// log.mjs — 本地托盘版日志：按日期分目录、脱敏、保留期清理
//
// 约定（见 local/PROTOCOL.md §9）：
//   · local/logs/YYYY/MM/DD/run.log   —— Node 业务日志（追加写当日文件）
//   · local/logs/YYYY/MM/DD/tray.log  —— 宿主日志 + 子进程 stderr（宿主自己写）
//   · 行格式：[2026-11-26 20:00:00.123] [INFO] [Scheduler] 开始同步
//   · 写入前统一脱敏：配置里的凭据值、常见 token/cookie 形态一律替换成 ***
//   · 日志写入失败绝不能让同步业务崩溃（catch 后写 stderr）

import fs from 'node:fs';
import path from 'node:path';

import { LOG_DIR } from './paths.mjs';

const LEVELS = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

/** 零填充 */
function pad(n, width = 2) {
  return String(n).padStart(width, '0');
}

/** 本地时区的日期分段：[yyyy, MM, dd] */
function dateParts(date = new Date()) {
  return [String(date.getFullYear()), pad(date.getMonth() + 1), pad(date.getDate())];
}

/** 本地时区的日志时间戳：2026-11-26 20:00:00.123 */
export function stamp(date = new Date()) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`;
}

/** 某天的日志目录 local/logs/YYYY/MM/DD */
export function dayDir(date = new Date()) {
  return path.join(LOG_DIR, ...dateParts(date));
}

/** 某天的业务日志文件 */
export function runLogPath(date = new Date()) {
  return path.join(dayDir(date), 'run.log');
}

// ---------- 脱敏 ----------

/** 常见敏感形态（凭据值本身由调用方通过 registerSecrets 注册） */
const SECRET_PATTERNS = [
  /\bgh[pousr]_[A-Za-z0-9]{16,}\b/g,                 // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,               // fine-grained PAT
  /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi,               // Authorization: Bearer xxx
  /\bcloudreve-session=[^;\s"']+/gi,                 // 站点会话 cookie 形态
  /\b(x-access-token|authorization)\s*:\s*(basic|bearer)\s+[A-Za-z0-9+/=]+/gi,
];

const secrets = new Set();

/** 注册需要在日志里脱敏的字符串（配置里的凭据/密码值） */
export function registerSecrets(values) {
  for (const v of values || []) {
    const s = typeof v === 'string' ? v.trim() : '';
    // 太短的值（如 "1"）替换会污染日志，跳过
    if (s.length >= 6) secrets.add(s);
  }
}

/** 脱敏一段文本 */
export function redact(text) {
  let out = String(text ?? '');
  for (const s of secrets) {
    if (out.includes(s)) out = out.split(s).join('***');
  }
  for (const re of SECRET_PATTERNS) out = out.replace(re, '***');
  return out;
}

// ---------- 写入 ----------

let writeFailedReported = false;

function appendLine(file, line) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${line}\n`, 'utf8');
    return true;
  } catch (e) {
    // 日志写失败不能影响业务：只在第一次报 stderr，避免刷屏
    if (!writeFailedReported) {
      writeFailedReported = true;
      try {
        process.stderr.write(`[log] 无法写入日志 ${file}：${e && e.message}\n`);
      } catch { /* 忽略 */ }
    }
    return false;
  }
}

/** 兼容旧调用：直接往当日 run.log 写一行（无 tag） */
export function rawLine(text, date = new Date()) {
  return appendLine(runLogPath(date), redact(text));
}

/**
 * 创建业务日志器。
 * @param {{ level?: 'DEBUG'|'INFO'|'WARN'|'ERROR', now?: () => Date }} [opts]
 */
export function createLogger(opts = {}) {
  const minLevel = LEVELS[String(opts.level || 'INFO').toUpperCase()] || LEVELS.INFO;
  const now = opts.now || (() => new Date());

  function write(level, tag, message) {
    if ((LEVELS[level] || 0) < minLevel) return false;
    const date = now();
    const line = `[${stamp(date)}] [${level}] [${tag || 'App'}] ${redact(message)}`;
    return appendLine(runLogPath(date), line);
  }

  return {
    debug: (tag, msg) => write('DEBUG', tag, msg),
    info: (tag, msg) => write('INFO', tag, msg),
    warn: (tag, msg) => write('WARN', tag, msg),
    error: (tag, msg) => write('ERROR', tag, msg),
    /** 原样写一行（不加时间戳/等级），用于把子进程输出按原样落到当日 run.log */
    raw: (text) => appendLine(runLogPath(now()), redact(text)),
    /** 子进程 stdout 行：加 [sync] 前缀，保留原有中文日志 */
    child: (text) => appendLine(runLogPath(now()), redact(`[sync] ${text}`)),
    /** 当日日志路径 */
    path: () => runLogPath(now()),
  };
}

// ---------- 保留期清理 ----------

/**
 * 清理超过保留期的日志目录（只动 local/logs 下本程序自己的 YYYY/MM/DD 目录）。
 * @param {number} retentionDays 0 或负数 = 永久保留
 */
export function cleanupOldLogs(retentionDays, now = new Date()) {
  const days = Number(retentionDays);
  if (!Number.isFinite(days) || days <= 0) return { removed: 0, skipped: true };

  const cutoff = new Date(now.getTime() - days * 24 * 3600 * 1000);
  const cutoffKey = dateParts(cutoff).join('/');
  let removed = 0;

  let years;
  try {
    years = fs.readdirSync(LOG_DIR, { withFileTypes: true });
  } catch {
    return { removed: 0, skipped: false };
  }

  for (const y of years) {
    if (!y.isDirectory() || !/^\d{4}$/.test(y.name)) continue;
    const yearDir = path.join(LOG_DIR, y.name);
    let months;
    try { months = fs.readdirSync(yearDir, { withFileTypes: true }); } catch { continue; }
    for (const m of months) {
      if (!m.isDirectory() || !/^\d{2}$/.test(m.name)) continue;
      const monthDir = path.join(yearDir, m.name);
      let dayDirs;
      try { dayDirs = fs.readdirSync(monthDir, { withFileTypes: true }); } catch { continue; }
      for (const d of dayDirs) {
        if (!d.isDirectory() || !/^\d{2}$/.test(d.name)) continue;
        const key = `${y.name}/${m.name}/${d.name}`;
        if (key >= cutoffKey) continue; // 字符串比较对 YYYY/MM/DD 是安全的
        try {
          fs.rmSync(path.join(monthDir, d.name), { recursive: true, force: true });
          removed += 1;
        } catch { /* 单个目录删不掉就跳过 */ }
      }
      // 清空后的月目录顺手删掉（非必要，失败忽略）
      try {
        if (fs.readdirSync(monthDir).length === 0) fs.rmdirSync(monthDir);
      } catch { /* 忽略 */ }
    }
  }
  return { removed, skipped: false };
}
