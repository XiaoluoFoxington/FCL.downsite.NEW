// main.mjs — fdn-autosync-tray 本地业务入口
//
// 职责（设计 §15）：调度、配置、状态、Git、WiFi、日志、通知编排；
//                  命令分发 + **锁定权限二次校验**；Windows 侧动作委托给 PowerShell 宿主。
//
// 进程模型：tray.ps1（宿主）→ node main.mjs（本文件）→ node sync.mjs（共享同步业务，按轮启动）
// 通信：stdin/stdout JSON Lines（协议见 local/PROTOCOL.md §3）。stdout 只放协议消息，诊断走 stderr。

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
  LOCAL_DIR, REPO_ROOT, CONFIG_FILE, STATE_FILE, LOCK_FILE, STATE_DIR,
  LOG_DIR, ASSETS_DIR, DEFAULT_ICON, DATA_DIR,
} from './modules/paths.mjs';
import {
  loadConfig, saveConfig, secretsOf, restrictFileAcl, CONFIG_VERSION,
} from './modules/config.mjs';
import {
  loadState, saveState, recordResult, resetNotification, defaultState,
} from './modules/state.mjs';
import {
  createLogger, registerSecrets, cleanupOldLogs,
} from './modules/log.mjs';
import { createScheduler } from './modules/scheduler.mjs';
import { runRound, createCancelToken } from './modules/sync-runner.mjs';
import { decideNotification } from './modules/notification.mjs';
import { ensureIcon, clearCache, ICON_SIZES } from './modules/tray-icon.mjs';
import { sessionInfo, fmtRemaining } from '../session.mjs';

const APP_NAME = 'fdn-autosync-tray';

// ============================ 决策日志（同步函数里用不到 log 实例时） ============================

let log = createLogger();
const protocolDiag = (text) => {
  try { process.stderr.write(`[main] ${text}\n`); } catch { /* 忽略 */ }
};

// ============================ 协议输出 ============================

/** 把任意对象编成一行 ASCII 安全的 JSON（非 ASCII 转 \uXXXX，彻底躲开编码歧义） */
export function toProtocolLine(obj) {
  const json = JSON.stringify(obj);
  return json.replace(/[\u007f-\uffff]/g, (ch) => `\\u${ch.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

let stdoutBroken = false;

/** 发送一条协议消息（stdout 只放协议；失败不影响业务） */
function send(message) {
  if (stdoutBroken) return;
  try {
    process.stdout.write(`${toProtocolLine(message)}\n`);
  } catch (e) {
    stdoutBroken = true;
    protocolDiag(`无法写出协议消息：${e && e.message ? e.message : e}`);
  }
}

// ============================ 单实例锁 ============================

function isPidAlive(pid) {
  if (!pid || !Number.isFinite(pid)) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e && e.code === 'EPERM';
  }
}

/**
 * 单实例锁：local/state/instance.lock 里放 PID。
 * 已有活着的实例 → 返回 { ok:false }（本进程静默退出，宿主读不到首条 state 也会退出）。
 */
export function acquireInstanceLock() {
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 忽略 */ }
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return { ok: true, pid: process.pid };
    } catch (e) {
      if (!e || e.code !== 'EEXIST') return { ok: false, reason: e && e.message ? e.message : String(e), stale: false };
      let holder = 0;
      try { holder = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim()); } catch { holder = 0; }
      if (isPidAlive(holder)) return { ok: false, reason: '已有实例在运行', stale: false, pid: holder };
      // 陈旧锁 → 清掉重试
      try { fs.unlinkSync(LOCK_FILE); } catch { /* 忽略 */ }
    }
  }
  return { ok: false, reason: '无法创建单实例锁', stale: false };
}

function releaseInstanceLock() {
  try {
    const holder = Number(fs.readFileSync(LOCK_FILE, 'utf8').trim());
    if (holder === process.pid) fs.unlinkSync(LOCK_FILE);
  } catch { /* 忽略 */ }
}

// ============================ Git 鉴权（只对子进程生效） ============================

let gitAuthIndex = -1;

/** 通过 GIT_CONFIG_* 注入 http.extraheader；不写 .git/config、不改 remote URL、不进 argv */
export function setGitAuth(token) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!value) {
    if (gitAuthIndex >= 0) {
      delete process.env[`GIT_CONFIG_KEY_${gitAuthIndex}`];
      delete process.env[`GIT_CONFIG_VALUE_${gitAuthIndex}`];
      const total = Number.parseInt(process.env.GIT_CONFIG_COUNT || '0', 10);
      if (Number.isFinite(total) && total > 0) process.env.GIT_CONFIG_COUNT = String(total - 1);
      gitAuthIndex = -1;
    }
    return;
  }
  const count = Number.parseInt(process.env.GIT_CONFIG_COUNT || '0', 10);
  const index = Number.isFinite(count) && count >= 0 ? count : 0;
  const basic = Buffer.from(`x-access-token:${value}`, 'utf8').toString('base64');
  process.env[`GIT_CONFIG_KEY_${index}`] = 'http.https://github.com/.extraheader';
  process.env[`GIT_CONFIG_VALUE_${index}`] = `AUTHORIZATION: basic ${basic}`;
  process.env.GIT_CONFIG_COUNT = String(index + 1);
  gitAuthIndex = index;
}

// ============================ 时间/文案格式化 ============================

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmtLocal(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

function fmtDuration(ms) {
  const sec = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  if (min < 60) return rest ? `${min} 分 ${rest} 秒` : `${min} 分`;
  const hour = Math.floor(min / 60);
  return `${hour} 小时 ${min % 60} 分`;
}

const STATUS_TEXT = { success: '成功', 'up-to-date': '已是最新', failure: '失败', 'internal-error': '内部错误' };
const BADGE_TEXT = { prepare: '准备', pull: 'Pull', sync: 'Sync', commit: '提交', push: '推送', finish: '收尾' };

// ============================ 运行时上下文 ============================

const ctx = {
  config: null,
  state: defaultState(),
  scheduler: null,
  locked: false,
  paused: false,
  running: false,
  stage: null,
  cancelToken: null,
  iconPath: null,
  iconTimer: null,
  shuttingDown: false,
  pendingAcks: new Map(), // id -> { resolve, timer }
  ackSeq: 0,
  notifySeq: 0,
  actionSeq: 0,
};

function currentStatusText() {
  if (ctx.running) return `同步中（${BADGE_TEXT[ctx.stage] || ctx.stage || '准备'}）`;
  if (ctx.paused) return '已暂停';
  return '空闲';
}

function nextRunText(nextRunAt) {
  if (!nextRunAt) {
    if (ctx.paused) return '未安排（已暂停）';
    if (ctx.running) return '本轮结束后安排';
    return '未安排';
  }
  return fmtLocal(nextRunAt);
}

function nextRunTextShort(nextRunAt) {
  if (!nextRunAt) return ctx.paused ? '已暂停' : '未安排';
  const d = new Date(nextRunAt);
  if (Number.isNaN(d.getTime())) return '未安排';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 会话 cookie 剩余寿命（只显示天数/是否失效，绝不显示 cookie 值本身） */
export function sessionStatusLine() {
  const raw = (ctx.config && ctx.config.credentials.H1111_SESSION) || '';
  if (!raw.trim()) return '会话：未配置（H1111_SESSION 为空）';
  try {
    const info = sessionInfo(raw);
    if (!info.present) return '会话：未配置（H1111_SESSION 为空）';
    if (!info.parseable) return '会话：已配置（无法解析到期时间）';
    if (!info.valid) return '会话：已失效，请更新 H1111_SESSION';
    if (!info.band) return `会话：剩 ${Math.floor(info.daysLeft)} 天`;
    if (info.band === 0) return '会话：已过期，请更新 H1111_SESSION';
    return `会话：即将到期（${fmtRemaining(info.secondsLeft)}），请更新 H1111_SESSION`;
  } catch {
    return '会话：已配置（无法解析到期时间）';
  }
}

/** 菜单状态区文本（Node 排版、宿主原样显示） */
export function buildStatusLines() {
  const state = ctx.state;
  const nextRunAt = ctx.scheduler ? ctx.scheduler.getStatus().nextRunAt : null;
  const lines = [`自启动后已同步：${state.totalRuns} 次`, `当前状态：${currentStatusText()}`];
  lines.push(sessionStatusLine());

  if (!state.lastRun) {
    lines.push('上次同步：尚未同步');
    lines.push('上次结果：—');
  } else {
    lines.push(`上次同步：${fmtLocal(state.lastRun.finishedAt) || '未知'}`);
    const parts = [STATUS_TEXT[state.lastRun.status] || state.lastRun.status];
    if (state.lastRun.durationMs) parts.push(`用时 ${fmtDuration(state.lastRun.durationMs)}`);
    lines.push(`上次结果：${parts.join(' · ')}`);
  }
  lines.push(`下次同步：${nextRunText(nextRunAt)}`);
  return lines;
}

function buildTooltip() {
  const badge = ctx.running ? `同步中 · ${BADGE_TEXT[ctx.stage] || ctx.stage || ''}`.trim()
    : ctx.paused ? '已暂停'
      : ctx.state.lastRun ? (STATUS_TEXT[ctx.state.lastRun.status] || '空闲') : '空闲';
  const nextRunAt = ctx.scheduler ? ctx.scheduler.getStatus().nextRunAt : null;
  const text = `${APP_NAME}${ctx.locked ? '（已锁定）' : ''} · ${badge} · 下次 ${nextRunTextShort(nextRunAt)}`;
  return text.slice(0, 63);
}

/** 广播状态给宿主 */
function broadcastState() {
  const nextRunAt = ctx.scheduler ? ctx.scheduler.getStatus().nextRunAt : null;
  const s = ctx.state;
  send({
    type: 'state',
    data: {
      locked: ctx.locked,
      paused: ctx.paused,
      running: ctx.running,
      stage: ctx.stage,
      hasRun: Boolean(s.lastRun),
      totalRuns: s.totalRuns,
      lastRun: s.lastRun ? {
        status: s.lastRun.status,
        finishedAt: s.lastRun.finishedAt,
        durationMs: s.lastRun.durationMs,
        message: s.lastRun.message,
      } : null,
      nextRunAt,
      counts: s.stats || {},
      statusLines: buildStatusLines(),
      tooltip: buildTooltip(),
    },
  });
}

/** 只读详细状态（不含任何凭据） */
function buildDetail() {
  const s = ctx.state;
  const nextRunAt = ctx.scheduler ? ctx.scheduler.getStatus().nextRunAt : null;
  const last = s.lastRun;
  return {
    statusText: currentStatusText(),
    stageText: ctx.running ? `阶段：${BADGE_TEXT[ctx.stage] || ctx.stage || ''}` : '阶段：—',
    totalRuns: s.totalRuns,
    lastRun: last ? {
      startText: fmtLocal(last.startedAt) || '未知',
      endText: fmtLocal(last.finishedAt) || '未知',
      durationText: fmtDuration(last.durationMs),
      statusText: STATUS_TEXT[last.status] || last.status,
      message: last.message || '',
      errorText: last.error && last.error.message ? `${BADGE_TEXT[last.error.stage] || last.error.stage || ''}阶段 ${last.error.code || ''}：${last.error.message}` : '',
    } : null,
    counts: s.stats || {},
    nextRunText: nextRunText(nextRunAt),
    locked: ctx.locked,
  };
}

// ============================ 图标刷新（去抖 + 缓存） ============================

function scheduleIconRefresh(force = false) {
  if (ctx.iconTimer) clearTimeout(ctx.iconTimer);
  ctx.iconTimer = setTimeout(() => {
    ctx.iconTimer = null;
    refreshIcon(force).catch((e) => log.warn('Icon', `刷新图标失败：${e && e.message ? e.message : e}`));
  }, 150);
}

async function refreshIcon(force = false) {
  if (!ctx.config) return;
  const view = {
    running: ctx.running,
    paused: ctx.paused,
    lastRun: ctx.state.lastRun,
  };
  const icon = await ensureIcon({ config: ctx.config, view, log, force });
  if (!icon || !icon.path) return;
  if (icon.path !== ctx.iconPath || force) {
    ctx.iconPath = icon.path;
    send({ type: 'icon', path: icon.path, tooltip: buildTooltip() });
  }
  if (icon.error) log.warn('Icon', `图标不可用：${icon.error}`);
}

// ============================ 通知（等宿主 ack 才清零计数） ============================

function requestNotify(title, text) {
  const id = `n-${(ctx.notifySeq += 1)}`;
  return requestAck({ type: 'notify', id, title, text }, 15000).then((ack) => Boolean(ack && ack.ok));
}

function requestAction(name, extra = {}, timeoutMs = 8000) {
  const id = `a-${(ctx.actionSeq += 1)}`;
  return requestAck({ type: 'action', id, name, ...extra }, timeoutMs);
}

function requestAck(message, timeoutMs) {
  return new Promise((resolve) => {
    const id = message.id;
    const timer = setTimeout(() => {
      ctx.pendingAcks.delete(id);
      resolve(null);
    }, timeoutMs);
    ctx.pendingAcks.set(id, { resolve, timer });
    send(message);
  });
}

function resolveAck(message) {
  const id = message.id;
  const pending = ctx.pendingAcks.get(id);
  if (!pending) return false;
  ctx.pendingAcks.delete(id);
  clearTimeout(pending.timer);
  pending.resolve(message);
  return true;
}

// ============================ 一轮同步 ============================

async function executeRound(trigger) {
  const snapshot = JSON.parse(JSON.stringify(ctx.config)); // 本轮配置快照：执行中改配置只影响下一轮
  const token = createCancelToken();
  ctx.cancelToken = token;
  ctx.stage = 'prepare';
  broadcastState();

  let result;
  try {
    result = await runRound({
      config: snapshot,
      log,
      cancelToken: token,
      onProgress: ({ stage }) => {
        ctx.stage = stage;
        broadcastState();
      },
    });
  } catch (e) {
    // 兜底：runRound 理论上不会抛出，但一旦抛出也必须计入统计，不能让本轮「消失」
    log.error('Main', `同步流程未捕获异常：${e && e.stack ? e.stack : e}`);
    result = {
      status: 'internal-error',
      startedAt: new Date(Date.now() - 1).toISOString(),
      finishedAt: new Date().toISOString(),
      durationMs: 1,
      message: e && e.message ? e.message : String(e),
      stats: null,
      error: { stage: 'runner', code: 'UNEXPECTED_ERROR', message: e && e.message ? e.message : String(e) },
      stages: [],
      committed: false,
      pushed: false,
      aheadAtEnd: null,
      warnings: [],
    };
  } finally {
    ctx.cancelToken = null;
    ctx.stage = null;
  }

  const nextRunAt = ctx.scheduler ? ctx.scheduler.getStatus().nextRunAt : null;
  ctx.state = recordResult(ctx.state, result, nextRunAt);
  saveStateSafe();
  broadcastState();
  log.info('Main', `本轮结果：${result.status}（${result.message}）｜触发：${trigger}`);

  // 通知：发送成功才清零累积计数
  try {
    const nextForNotify = ctx.scheduler ? ctx.scheduler.getStatus().nextRunAt : null;
    const decision = decideNotification({ result, config: ctx.config, state: ctx.state, nextRunAt: nextForNotify });
    if (decision.send) {
      const ok = await requestNotify(decision.title, decision.text);
      log.info('Notify', `通知（${decision.mode}）${ok ? '已发送' : '发送失败，保留计数'}：${decision.title}`);
      if (ok && decision.reset) {
        ctx.state = resetNotification(ctx.state);
        saveStateSafe();
        broadcastState();
      }
    }
  } catch (e) {
    log.warn('Notify', `通知流程异常（不影响同步结果）：${e && e.message ? e.message : e}`);
  }

  scheduleIconRefresh();
  return result;
}

// ============================ 状态持久化 ============================

function saveStateSafe() {
  const saved = saveState(ctx.state);
  if (!saved || saved.ok === false) {
    log.error('Main', `状态保存失败：${(saved && saved.error) || '未知错误'}`);
  }
}

// ============================ 配置 ------------

/**
 * 把 patch 深合并到 base 之上（只在本进程内存里操作，不做任何类型校验）。
 * 用途：宿主可能只发来部分字段，绝不能因此把用户其余设置冲成默认值。
 */
function deepMergeConfig(base, patch) {
  const isPlain = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v);
  if (!isPlain(patch)) return isPlain(base) ? base : patch;
  const out = isPlain(base) ? { ...base } : {};
  for (const [key, value] of Object.entries(patch)) {
    out[key] = isPlain(value) && isPlain(out[key]) ? deepMergeConfig(out[key], value) : value;
  }
  return out;
}

function applyConfigSideEffects(config) {
  // 脱敏集合 + Git 鉴权 + 调度间隔
  registerSecrets(secretsOf(config));
  setGitAuth(config.credentials.PUSH_TOKEN || '');
  if (ctx.scheduler) ctx.scheduler.setIntervalMinutes(config.scheduler.intervalMinutes);
}

// ============================ 命令处理 ============================

const LOCKED_ALLOWED = new Set([
  'get-status', 'get-detail', 'sync-now', 'sync-cancel', 'unlock', 'open-log-folder', 'open-log-latest', 'open',
]);
const LOCKED_OPEN_TARGETS = new Set(['log-folder', 'latest-log']);

/** 锁定状态下的命令白名单（Node 侧二次校验，不只依赖宿主隐藏菜单项） */
export function isCommandAllowed(name, { locked, target = '' } = {}) {
  if (!locked) return true;
  if (name === 'open') return LOCKED_OPEN_TARGETS.has(String(target));
  return LOCKED_ALLOWED.has(name);
}

function ack(message, payload = {}) {
  send({ type: 'ack', id: message.id, ok: true, message: '', error: null, ...payload });
}

function nack(message, error, message2 = '') {
  send({ type: 'ack', id: message.id, ok: false, message: message2, error: String(error) });
}

function openTargetPath(target) {
  switch (target) {
    case 'log-folder': return LOG_DIR;
    case 'latest-log': {
      // 打开的是「最新一次日志文件」本身（交给默认程序/编辑器），没有日志时退回日志目录
      return findLatestLog() || LOG_DIR;
    }
    case 'project-dir': return REPO_ROOT;
    case 'data-dir': return DATA_DIR;
    case 'sync-dir': return path.join(REPO_ROOT, 'scripts', 'auto-sync');
    case 'config-file': return CONFIG_FILE;
    default: return null;
  }
}

function findLatestLog() {
  let latest = null;
  let latestTime = 0;
  const walk = (dir, depth = 0) => {
    if (depth > 4) return;
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full, depth + 1);
      else if (e.isFile() && e.name.endsWith('.log')) {
        try {
          const t = fs.statSync(full).mtimeMs;
          if (t > latestTime) { latestTime = t; latest = full; }
        } catch { /* 忽略 */ }
      }
    }
  };
  walk(LOG_DIR);
  return latest;
}

/** 校验并复制用户选择的图标（复制进程序自己的 assets/，不依赖原始路径） */
function importUserIcon(sourcePath) {
  const src = String(sourcePath || '').trim();
  if (!src) return { ok: false, error: '未提供图片路径' };
  if (!fs.existsSync(src)) return { ok: false, error: '图片不存在' };
  const ext = path.extname(src).toLowerCase();
  if (!['.png', '.ico', '.bmp', '.jpg', '.jpeg'].includes(ext)) {
    return { ok: false, error: '只支持 PNG / ICO / BMP 图片' };
  }
  let head;
  try {
    const fd = fs.openSync(src, 'r');
    head = Buffer.alloc(16);
    fs.readSync(fd, head, 0, 16, 0);
    fs.closeSync(fd);
  } catch (e) {
    return { ok: false, error: `无法读取图片：${e && e.message ? e.message : e}` };
  }
  const isPng = head[0] === 0x89 && head[1] === 0x50;
  const isBmp = head[0] === 0x42 && head[1] === 0x4d;
  const isIco = head[0] === 0x00 && head[1] === 0x00 && (head[2] === 0x01 || head[2] === 0x02);
  const isJpg = head[0] === 0xff && head[1] === 0xd8;
  if (!isPng && !isBmp && !isIco && !isJpg) return { ok: false, error: '图片格式无法识别（可能已损坏）' };

  try {
    fs.mkdirSync(ASSETS_DIR, { recursive: true });
    for (const name of fs.readdirSync(ASSETS_DIR)) {
      if (name.startsWith('user-icon.')) {
        try { fs.unlinkSync(path.join(ASSETS_DIR, name)); } catch { /* 忽略 */ }
      }
    }
    const fileName = `user-icon${ext === '.jpeg' ? '.jpg' : ext}`;
    fs.copyFileSync(src, path.join(ASSETS_DIR, fileName));
    return { ok: true, iconPath: `assets/${fileName}` };
  } catch (e) {
    return { ok: false, error: `复制图片失败：${e && e.message ? e.message : e}` };
  }
}

async function handleCommand(message) {
  const name = String(message.name || '');
  const target = String(message.target || '');
  const locked = ctx.locked;

  if (!isCommandAllowed(name, { locked, target })) {
    log.warn('Command', `已锁定，拒绝命令：${name}${target ? `（${target}）` : ''}`);
    nack(message, 'locked', '已锁定，该操作不可用');
    return;
  }

  switch (name) {
    case 'get-status': {
      broadcastState();
      ack(message);
      return;
    }

    case 'get-detail': {
      ack(message, { data: { detail: buildDetail() } });
      return;
    }

    case 'sync-now': {
      if (ctx.running) {
        nack(message, 'running', '正在同步，已忽略重复触发');
        return;
      }
      ack(message, { data: { accepted: true } });
      ctx.scheduler.syncNow().catch((e) => log.error('Main', `立即同步异常：${e && e.stack ? e.stack : e}`));
      return;
    }

    case 'sync-cancel': {
      if (!ctx.running || !ctx.cancelToken) {
        ack(message, { data: { cancelled: false, reason: '当前没有同步在运行' } });
        return;
      }
      ctx.cancelToken.cancel('用户取消');
      log.warn('Main', '用户请求取消当前同步');
      ack(message, { data: { cancelled: true } });
      return;
    }

    case 'pause': {
      ctx.scheduler.pause();
      ctx.paused = true;
      ctx.state.paused = true;
      saveStateSafe();
      broadcastState();
      ack(message);
      return;
    }

    case 'resume': {
      ctx.scheduler.resume();
      ctx.paused = false;
      ctx.state.paused = false;
      saveStateSafe();
      broadcastState();
      ack(message);
      return;
    }

    case 'lock': {
      const password = typeof message.password === 'string' ? message.password : '';
      const existing = ctx.config.security.lockPassword || '';
      if (!existing) {
        if (!password || password.length < 1) {
          nack(message, 'no-password', '请先设置锁定密码');
          return;
        }
        ctx.config.security.lockPassword = password;
        const saved = saveConfig(ctx.config);
        if (!saved.ok) { nack(message, 'config-save-failed', saved.error || '保存密码失败'); return; }
        ctx.config = saved.config;
        applyConfigSideEffects(ctx.config);
        registerSecrets(secretsOf(ctx.config));
        log.info('Main', '已设置锁定密码并锁定');
      } else {
        if (password && password !== existing) { nack(message, 'bad-password', '密码错误'); return; }
        log.info('Main', '已锁定托盘菜单');
      }
      ctx.locked = true;
      ctx.state.locked = true;
      saveStateSafe();
      broadcastState();
      ack(message);
      return;
    }

    case 'unlock': {
      const password = typeof message.password === 'string' ? message.password : '';
      const existing = ctx.config.security.lockPassword || '';
      if (existing && password !== existing) {
        log.warn('Main', '解锁失败：密码错误');
        nack(message, 'bad-password', '密码错误');
        return;
      }
      ctx.locked = false;
      ctx.state.locked = false;
      saveStateSafe();
      broadcastState();
      log.info('Main', '已解锁');
      ack(message);
      return;
    }

    case 'open': {
      const resolved = openTargetPath(target);
      if (!resolved) { nack(message, 'unknown-target', '未知的打开目标'); return; }
      if (!fs.existsSync(resolved)) { nack(message, 'not-found', '目标不存在'); return; }
      ack(message, { data: { path: resolved } });
      return;
    }

    case 'get-config': {
      ack(message, { data: { config: ctx.config } });
      return;
    }

    case 'save-config': {
      const incoming = message.config;
      if (!incoming || typeof incoming !== 'object') { nack(message, 'bad-config', '配置内容为空'); return; }
      // 防御：宿主/设置窗口若只发了部分字段，也不能把其余用户设置冲掉
      const merged = deepMergeConfig(ctx.config, incoming);
      const saved = saveConfig(merged);
      if (!saved.ok) {
        log.warn('Main', `配置校验失败：${saved.error}`);
        send({ type: 'ack', id: message.id, ok: false, message: saved.error, error: 'invalid-config', data: { config: saved.config } });
        return;
      }
      ctx.config = saved.config;
      applyConfigSideEffects(ctx.config);
      log.info('Main', '配置已保存');
      ack(message, { data: { config: ctx.config } });
      broadcastState();
      scheduleIconRefresh(true);
      return;
    }

    case 'set-icon': {
      const imported = importUserIcon(message.path);
      if (!imported.ok) { nack(message, 'bad-icon', imported.error); return; }
      ctx.config.appearance.iconPath = imported.iconPath;
      const saved = saveConfig(ctx.config);
      if (!saved.ok) { nack(message, 'config-save-failed', saved.error || '保存失败'); return; }
      ctx.config = saved.config;
      log.info('Main', `已更换托盘图标：${imported.iconPath}`);
      ack(message, { data: { iconPath: imported.iconPath } });
      scheduleIconRefresh(true);
      return;
    }

    case 'reset-icon': {
      try {
        for (const entry of fs.readdirSync(ASSETS_DIR)) {
          if (entry.startsWith('user-icon.')) fs.unlinkSync(path.join(ASSETS_DIR, entry));
        }
      } catch { /* 忽略 */ }
      ctx.config.appearance.iconPath = null;
      const saved = saveConfig(ctx.config);
      if (!saved.ok) { nack(message, 'config-save-failed', saved.error || '保存失败'); return; }
      ctx.config = saved.config;
      log.info('Main', '已恢复默认图标');
      ack(message);
      scheduleIconRefresh(true);
      return;
    }

    case 'repair-autostart': {
      const ackMsg = await requestAction('repair-autostart', { enabled: Boolean(ctx.config.startup.enabled) }, 10000);
      if (ackMsg && ackMsg.ok) ack(message);
      else nack(message, 'host-action-failed', (ackMsg && ackMsg.error) || '宿主未能重建快捷方式');
      return;
    }

    case 'restart':
    case 'exit': {
      const isRestart = name === 'restart';
      if (ctx.running) {
        nack(message, 'running', '正在同步，请等待结束或先取消再操作');
        return;
      }
      ack(message);
      log.info('Main', isRestart ? '正在重启托盘' : '正在退出托盘');
      await shutdown({ restart: isRestart });
      return;
    }

    default:
      log.warn('Command', `未知命令：${name}`);
      nack(message, 'unknown-command', `未知命令：${name}`);
  }
}

function handleEvent(message) {
  const name = String(message.name || '');
  switch (name) {
    case 'wake': {
      log.info('Main', '收到系统唤醒事件');
      ctx.scheduler.wake().catch((e) => log.error('Main', `唤醒补跑异常：${e && e.message ? e.message : e}`));
      return;
    }
    case 'autostart-changed': {
      const enabled = Boolean(message.enabled);
      if (ctx.config.startup.enabled !== enabled) {
        ctx.config.startup.enabled = enabled;
        const saved = saveConfig(ctx.config);
        if (saved.ok) ctx.config = saved.config;
      }
      log.info('Main', `开机自启动已${enabled ? '启用' : '禁用'}${message.ok === false ? `（失败：${message.error || '未知'}）` : ''}`);
      broadcastState();
      return;
    }
    case 'autostart-status': {
      const exists = Boolean(message.exists);
      if (ctx.config.startup.enabled !== exists) {
        ctx.config.startup.enabled = exists;
        const saved = saveConfig(ctx.config);
        if (saved.ok) ctx.config = saved.config;
        if (!exists) log.warn('Main', '自启动快捷方式不存在（程序可能被移动过），配置已置为关闭；可在菜单里重新开启或点「修复自启动」');
      }
      broadcastState();
      return;
    }
    default:
      log.debug('Event', `忽略未知事件：${name}`);
  }
}

// ============================ 收尾 ============================

async function shutdown({ restart = false, notifyHost = true } = {}) {
  if (ctx.shuttingDown) return;
  ctx.shuttingDown = true;
  try { ctx.scheduler.stop(); } catch { /* 忽略 */ }
  if (ctx.cancelToken) ctx.cancelToken.cancel('程序退出');
  saveStateSafe();
  log.info('Main', restart ? '退出以重启' : '退出');
  if (notifyHost) {
    const action = await requestAction(restart ? 'restart' : 'exit', {}, 5000);
    if (!action) protocolDiag('宿主未回应退出请求（继续退出）');
  }
  releaseInstanceLock();
  // 给 stdout 一点时间冲刷
  setTimeout(() => process.exit(0), 50);
}

// ============================ 启动 ============================

async function main() {
  const lock = acquireInstanceLock();
  if (!lock.ok) {
    protocolDiag(`未获得单实例锁：${lock.reason}${lock.pid ? `（PID ${lock.pid}）` : ''}`);
    process.exit(0);
    return;
  }

  const loaded = loadConfig();
  ctx.config = loaded.config;
  log = createLogger({ level: process.env.FDN_LOG_LEVEL || 'INFO' });
  registerSecrets(secretsOf(ctx.config));

  // 旧版迁移后：把用户原来指向的图片复制进 assets/，改用相对路径
  if (loaded.migrated) {
    const legacyIcon = (loaded.config.appearance || {}).iconPath;
    if (legacyIcon && path.isAbsolute(legacyIcon) && fs.existsSync(legacyIcon)) {
      const imported = importUserIcon(legacyIcon);
      if (imported.ok) {
        ctx.config.appearance.iconPath = imported.iconPath;
        const saved = saveConfig(ctx.config);
        if (saved.ok) ctx.config = saved.config;
      } else {
        log.warn('Config', `旧版自定义图标迁移失败（回退默认）：${imported.error}`);
        ctx.config.appearance.iconPath = null;
        saveConfig(ctx.config);
      }
    }
  }

  if (loaded.created) log.info('Config', `已生成默认配置：${CONFIG_FILE}`);
  if (loaded.migrated) log.info('Config', `已把旧版配置迁移到 v${CONFIG_VERSION}${loaded.backup ? `（备份：${path.basename(loaded.backup)}）` : ''}`);
  if (loaded.recovered) log.error('Config', `配置损坏已恢复默认：${loaded.errors.join('；')}`);
  for (const w of loaded.warnings || []) log.warn('Config', w);
  for (const e of loaded.errors || []) log.error('Config', e);

  // 配置文件权限尽量收紧（便携性的代价：只能靠 ACL 减少被读取的机会）
  const acl = restrictFileAcl();
  if (!acl.ok) log.debug('Config', `收紧配置文件权限失败（忽略）：${acl.error}`);

  const loadedState = loadState();
  ctx.state = loadedState.state;
  if (loadedState.recovered) log.error('State', loadedState.error || '状态文件已重置');
  if (loadedState.error && !loadedState.recovered) log.warn('State', loadedState.error);
  ctx.locked = Boolean(ctx.state.locked);
  ctx.paused = Boolean(ctx.state.paused);

  applyConfigSideEffects(ctx.config);
  setGitAuth(ctx.config.credentials.PUSH_TOKEN || '');

  // 日志保留期清理（只清本程序自己的日志）
  try {
    const cleaned = cleanupOldLogs((ctx.config.logging || {}).retentionDays);
    if (cleaned.removed) log.info('Log', `已清理 ${cleaned.removed} 个过期日志目录`);
  } catch (e) {
    log.warn('Log', `清理旧日志失败：${e && e.message ? e.message : e}`);
  }

  log.info('Main', `${APP_NAME} 启动｜PID ${process.pid}｜仓库 ${REPO_ROOT}`);
  log.info('Main', `配置：间隔 ${ctx.config.scheduler.intervalMinutes} 分钟｜锁定 ${ctx.locked ? '是' : '否'}｜暂停 ${ctx.paused ? '是' : '否'}｜图标尺寸 ${ICON_SIZES.join('/')}`);

  // 环境自检：Git / 同步脚本必须存在
  const missing = [];
  if (!fs.existsSync(path.join(REPO_ROOT, 'scripts', 'auto-sync', 'sync.mjs'))) missing.push('scripts/auto-sync/sync.mjs');
  const gitOk = (() => {
    try {
      return spawnSync('git', ['--version'], { windowsHide: true, timeout: 15000 }).status === 0;
    } catch { return false; }
  })();
  if (!gitOk) missing.push('git');
  if (missing.length) log.error('Main', `运行依赖缺失：${missing.join('、')}（相关阶段会失败）`);

  ctx.scheduler = createScheduler({
    config: ctx.config,
    log,
    runRound: executeRound,
    onState: (info) => {
      ctx.running = info.running;
      ctx.paused = info.paused;
      if (ctx.state.paused !== info.paused) {
        ctx.state.paused = info.paused;
        saveStateSafe();
      }
      if (info.nextRunAt) ctx.state.nextRunAt = info.nextRunAt;
      else if (!info.running) ctx.state.nextRunAt = null;
      broadcastState();
      scheduleIconRefresh();
    },
  });

  // 先把首条状态发出去（宿主用它确认 Node 已就绪）
  broadcastState();
  scheduleIconRefresh();

  // stdin 协议循环
  const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch {
      log.warn('Protocol', `非法 JSON（已忽略）：${text.slice(0, 120)}`);
      return;
    }
    if (!message || typeof message !== 'object') return;
    if (message.type === 'ack') {
      if (!resolveAck(message)) log.debug('Protocol', `收到无法匹配的 ack：${message.id}`);
      return;
    }
    if (message.type === 'command') {
      handleCommand(message).catch((e) => {
        log.error('Command', `命令处理异常：${e && e.stack ? e.stack : e}`);
        try { nack(message, 'internal-error', e && e.message ? e.message : String(e)); } catch { /* 忽略 */ }
      });
      return;
    }
    if (message.type === 'event') { handleEvent(message); return; }
    log.debug('Protocol', `忽略未知消息类型：${message.type}`);
  });
  rl.on('close', () => {
    log.info('Main', 'stdin 已关闭，准备退出');
    shutdown({ restart: false, notifyHost: false }).catch(() => process.exit(0));
  });

  // 配置刚被判定损坏并恢复默认时，本次启动不自动跑一轮：
  // 默认值里 runOnStart=true + 各阶段全开，若此时仓库刚好领先远端，可能触发用户没预期的推送。
  let runOnStart = ctx.config.startup.runOnStart === true;
  if (loaded.recovered && runOnStart) {
    runOnStart = false;
    log.warn('Main', '配置刚恢复默认，本次启动跳过自动同步（请先在设置里确认配置，再手动「立即同步」）');
  }

  // 启动调度（state.paused 时保持暂停）
  ctx.scheduler.restore({ paused: ctx.paused, runOnStart });
}

process.on('uncaughtException', (e) => {
  try { log.error('Main', `未捕获异常：${e && e.stack ? e.stack : e}`); } catch { /* 忽略 */ }
  protocolDiag(`uncaughtException: ${e && e.stack ? e.stack : e}`);
});

process.on('unhandledRejection', (e) => {
  try { log.error('Main', `未处理的 Promise 拒绝：${e && e.stack ? e.stack : e}`); } catch { /* 忽略 */ }
});

process.on('SIGTERM', () => { shutdown({ restart: false }).catch(() => process.exit(0)); });
process.on('SIGINT', () => { shutdown({ restart: false }).catch(() => process.exit(0)); });

// 只有被直接执行时才启动；被测试 import 时只暴露纯函数（toProtocolLine / isCommandAllowed / buildStatusLines）
const invokedDirectly = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (invokedDirectly) {
  main().catch((e) => {
    protocolDiag(`启动失败：${e && e.stack ? e.stack : e}`);
    releaseInstanceLock();
    process.exit(1);
  });
}

export { ctx };
