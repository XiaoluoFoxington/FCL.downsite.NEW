// run-sync.mjs — 本地托盘版的前置/收尾包装器（仅 Windows 托盘版使用，GHA 不涉及）
//
// 顺序：
//   1. 同步前 git pull（默认 --rebase；拉取失败 → 取消本次同步，exit 2）
//   2. 跑 sync.mjs 全流程（探测 → 登录 → 离线下载 → 直链 → 写 JSON → 提交 → push）
//   3. 若上次 push 失败留下了本地提交，且本次同步成功 → 收尾补推（失败则留到下一轮）
//
// 配置来自环境变量（由 tray.ps1 把 config.json 翻译成环境变量后注入）：
//   LOCAL_SYNC_PULL=0|1                是否同步前拉取
//   LOCAL_SYNC_PULL_STRATEGY=rebase|ff-only
//   LOCAL_SYNC_PULL_TIMEOUT_MS=600000   pull 超时
//   LOCAL_SYNC_RETRY_PUSH=0|1          是否在成功同步后补推历史未推送提交
//   LOCAL_SYNC_GIT_TOKEN=...           GitHub PAT，用于 git pull/push 鉴权；
//                                      未设置 = 回退到本机 git 默认凭据（SSH / credential helper）
//   LOCAL_SYNC_GIT_IDENTITY=script|git|custom
//                                      提交身份：script = github-actions[bot]（默认）；
//                                      git = 本机 git 配置；custom = 使用下面两项
//   LOCAL_SYNC_GIT_USER_NAME=...       自定义提交用户名（custom 时）
//   LOCAL_SYNC_GIT_USER_EMAIL=...      自定义提交邮箱（custom 时）
//   LOCAL_SYNC_STEP_PULL=0|1           步骤：同步前拉取
//   LOCAL_SYNC_STEP_SYNC=0|1           步骤：执行 sync.mjs
//   LOCAL_SYNC_STEP_COMMIT=0|1         步骤：提交（由 sync.mjs 读取）
//   LOCAL_SYNC_STEP_PUSH=0|1           步骤：推送（含补推）
//                                      四项全关 = 暂停，由托盘兜底拦截
//
// 退出码：0 成功；1 失败；2 拉取失败已取消

import { spawnSync, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..', '..');
const SYNC_SCRIPT = path.join(ROOT, 'scripts', 'auto-sync', 'sync.mjs');

const PULL_ENABLED = process.env.LOCAL_SYNC_PULL !== '0';
const PULL_STRATEGY = process.env.LOCAL_SYNC_PULL_STRATEGY === 'ff-only' ? 'ff-only' : 'rebase';
const PULL_TIMEOUT_MS = toPositiveInt(process.env.LOCAL_SYNC_PULL_TIMEOUT_MS, 10 * 60 * 1000);
const RETRY_PUSH = process.env.LOCAL_SYNC_RETRY_PUSH !== '0';
const PUSH_TIMEOUT_MS = 5 * 60 * 1000;
const GIT_TOKEN = (process.env.LOCAL_SYNC_GIT_TOKEN || '').trim();
const IDENTITY_MODE = (process.env.LOCAL_SYNC_GIT_IDENTITY || 'script').trim().toLowerCase();
const STEPS = {
  pull: process.env.LOCAL_SYNC_STEP_PULL !== '0',
  sync: process.env.LOCAL_SYNC_STEP_SYNC !== '0',
  commit: process.env.LOCAL_SYNC_STEP_COMMIT !== '0',
  push: process.env.LOCAL_SYNC_STEP_PUSH !== '0',
};

// 结构化结果：托盘通过 LOCAL_SYNC_RESULT_FILE 指定最终文件；这里再给 sync.mjs 一个中间文件。
// 未设置时（手动执行）完全不写，不影响任何现有行为。
const RESULT_FILE = (process.env.LOCAL_SYNC_RESULT_FILE || '').trim();
const SYNC_RESULT_FILE = RESULT_FILE ? `${RESULT_FILE}.sync` : '';
if (SYNC_RESULT_FILE) {
  process.env.LOCAL_SYNC_SYNC_RESULT_FILE = SYNC_RESULT_FILE;
  try { fs.rmSync(SYNC_RESULT_FILE, { force: true }); } catch { /* 忽略 */ }
}

function writeResult(status, reason, message, exitCode) {
  if (!RESULT_FILE) return;
  try {
    const tmp = `${RESULT_FILE}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
      version: 1,
      status,
      reason,
      message: String(message || ''),
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      endedAt: new Date().toISOString(),
    }), 'utf8');
    try { fs.rmSync(RESULT_FILE, { force: true }); } catch { /* 忽略 */ }
    fs.renameSync(tmp, RESULT_FILE);
  } catch {
    // 结果文件只给托盘用，写失败不影响同步本身
  }
}

function readSyncResult() {
  if (!SYNC_RESULT_FILE) return null;
  try {
    const j = JSON.parse(fs.readFileSync(SYNC_RESULT_FILE, 'utf8'));
    const status = typeof j.status === 'string' ? j.status : '';
    if (!['success', 'nosync', 'failure'].includes(status)) return null;
    return {
      status,
      reason: typeof j.reason === 'string' ? j.reason : '',
      message: typeof j.message === 'string' ? j.message : '',
    };
  } catch {
    return null;
  }
}

// 有 PAT 就用 http.extraheader 临时鉴权：只作用于本次进程（含 sync.mjs 子进程），
// 不把 token 写进 .git/config 或 remote URL；没有则完全不动，沿用本机 git 凭据。
if (GIT_TOKEN) {
  const basic = Buffer.from(`x-access-token:${GIT_TOKEN}`, 'utf8').toString('base64');
  // 顺着已有的 GIT_CONFIG_* 追加，不覆盖别的工具注入的配置
  const count = Number.parseInt(process.env.GIT_CONFIG_COUNT || '0', 10);
  const idx = Number.isFinite(count) && count >= 0 ? count : 0;
  process.env[`GIT_CONFIG_KEY_${idx}`] = 'http.https://github.com/.extraheader';
  process.env[`GIT_CONFIG_VALUE_${idx}`] = `AUTHORIZATION: basic ${basic}`;
  process.env.GIT_CONFIG_COUNT = String(idx + 1);
}

function toPositiveInt(raw, fallback) {
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

function line(text = '') {
  process.stdout.write(`${text}\n`);
}

function fmtMs(ms) {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec} 秒`;
  return `${Math.floor(sec / 60)} 分 ${sec % 60} 秒`;
}

function identityText() {
  if (IDENTITY_MODE === 'git') return '本机 git 配置';
  if (IDENTITY_MODE === 'custom') return '自定义';
  return '脚本默认（github-actions[bot]）';
}

function git(args, opts = {}) {
  return spawnSync('git', ['-C', ROOT, ...args], { stdio: 'inherit', ...opts });
}

function gitText(args) {
  try {
    return execFileSync('git', ['-C', ROOT, ...args], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
  } catch {
    return '';
  }
}

function currentBranch() {
  const b = gitText(['rev-parse', '--abbrev-ref', 'HEAD']);
  return b && b !== 'HEAD' ? b : '';
}

function aheadCount(branch) {
  const ref = upstreamRef() || (branch ? `origin/${branch}` : '');
  if (!ref) return 0;
  const raw = gitText(['rev-list', '--count', `${ref}..HEAD`]);
  return /^\d+$/.test(raw) ? Number(raw) : 0;
}

function upstreamRef() {
  return gitText(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

function pushTarget() {
  const upstream = upstreamRef();
  if (upstream) {
    const slash = upstream.indexOf('/');
    if (slash > 0) return { remote: upstream.slice(0, slash), ref: upstream.slice(slash + 1) };
  }
  const branch = currentBranch();
  return branch ? { remote: 'origin', ref: branch } : null;
}

function gitPath(name) {
  const p = gitText(['rev-parse', '--git-path', name]);
  return p ? path.resolve(ROOT, p) : '';
}

function rebaseInProgress() {
  return ['rebase-merge', 'rebase-apply'].some((name) => {
    const p = gitPath(name);
    return p && fs.existsSync(p);
  });
}

function pull() {
  line('');
  line('========== 本地前置：拉取远端 ==========');

  if (!STEPS.pull) {
    line('（步骤设置：拉取已关闭，跳过）');
    return { ok: true };
  }

  if (!PULL_ENABLED) {
    line('（pullBeforeSync 已关闭，跳过拉取）');
    return { ok: true };
  }

  const branch = currentBranch();
  if (!branch) {
    const message = '当前处于 detached HEAD，无法安全拉取，已取消本次同步';
    line(`❌ ${message}`);
    return { ok: false, reason: 'pull-blocked', message };
  }
  if (rebaseInProgress()) {
    const message = '仓库里有未完成的 rebase，已取消本次同步（不替你 abort，请手动处理）';
    line(`❌ ${message}`);
    return { ok: false, reason: 'pull-blocked', message };
  }

  const baseArgs = PULL_STRATEGY === 'ff-only' ? ['pull', '--ff-only'] : ['pull', '--rebase'];
  // 没配 upstream 但远端有同名分支时，显式指定 origin/<branch>，否则 git pull 会直接报错
  const strategyArgs = upstreamRef() ? baseArgs : [...baseArgs, 'origin', branch];
  const t0 = Date.now();
  const r = git(strategyArgs, { timeout: PULL_TIMEOUT_MS });

  let message = '';
  if (r.error && r.error.code === 'ETIMEDOUT') {
    message = `git pull 超时（${fmtMs(PULL_TIMEOUT_MS)}），已取消本次同步`;
  } else if (r.error) {
    message = `无法执行 git pull：${r.error.message}，已取消本次同步`;
  } else if (r.status !== 0) {
    message = `git pull 失败（退出码 ${r.status}），已取消本次同步`;
  } else {
    line(`✅ 已拉取 ${upstreamRef() || `origin/${branch}`}｜用时 ${fmtMs(Date.now() - t0)}`);
    return { ok: true };
  }
  line(`❌ ${message}`);

  // pull --rebase 冲突会停在半截 rebase；既然拉取要取消，顺手把状态回滚干净
  if (PULL_STRATEGY === 'rebase' && rebaseInProgress()) {
    const aborted = git(['rebase', '--abort'], { stdio: 'ignore' });
    line(aborted.status === 0
      ? '已回滚未完成的 rebase（工作区恢复到拉取前）'
      : '⚠ 回滚 rebase 失败，请手动检查仓库状态');
  }
  return { ok: false, reason: 'pull-failed', message };
}

function pushLeftovers() {
  if (!STEPS.push) {
    line('');
    line('（步骤设置：推送已关闭，跳过补推）');
    return 0;
  }

  const target = pushTarget();
  if (!target) return 0;

  const ahead = aheadCount(currentBranch());
  if (ahead <= 0) return 0;

  line('');
  line(`========== 本地收尾：补推 ${ahead} 个未推送提交 ==========`);
  const t0 = Date.now();
  const r = git(['push', target.remote, `HEAD:${target.ref}`], { timeout: PUSH_TIMEOUT_MS });

  if (r.error && r.error.code === 'ETIMEDOUT') {
    line(`❌ 补推超时（${fmtMs(PUSH_TIMEOUT_MS)}），提交保留到下次同步再补推`);
    return 1;
  }
  if (r.error) {
    line(`❌ 无法执行 git push：${r.error.message}，提交保留到下次同步再补推`);
    return 1;
  }
  if (r.status !== 0) {
    line(`❌ 补推失败（退出码 ${r.status}），提交保留到下次同步再补推`);
    return 1;
  }
  line(`✅ 已补推 ${target.remote}/${target.ref}｜用时 ${fmtMs(Date.now() - t0)}`);
  return 0;
}

// ============ 主流程 ============

line(GIT_TOKEN
  ? '🔑 拉取/推送凭据：config.json 中的 GitHub 令牌'
  : '🔑 拉取/推送凭据：本机 git 默认凭据');
line(`👤 提交身份：${identityText()}`);
line(`🧩 步骤：拉取${STEPS.pull ? '开' : '关'}｜同步${STEPS.sync ? '开' : '关'}｜提交${STEPS.commit ? '开' : '关'}｜推送${STEPS.push ? '开' : '关'}`);
if (GIT_TOKEN) {
  const remote = gitText(['remote', 'get-url', 'origin']);
  if (/^(git@|ssh:)/i.test(remote)) {
    line('⚠ origin 使用 SSH，令牌只对 HTTPS 生效，本次仍走 SSH 凭据');
  }
}

const pullResult = pull();
if (!pullResult.ok) {
  line('');
  line('❌ 拉取失败，本次同步已取消（未下载、未提交）');
  writeResult('failure', pullResult.reason, pullResult.message, 2);
  process.exit(2);
}

let code = 0;
let syncResult = null;
if (!STEPS.sync) {
  line('');
  line('（步骤设置：同步已关闭，跳过 sync.mjs）');
  syncResult = { status: 'nosync', reason: 'step-sync-off', message: '步骤设置：同步已关闭，跳过 sync.mjs' };
} else {
  line('');
  line('========== 开始执行 sync.mjs ==========');
  const syncRun = spawnSync(process.execPath, [SYNC_SCRIPT], {
    cwd: ROOT,
    stdio: 'inherit',
    env: process.env,
  });

  if (syncRun.error) {
    line(`❌ 无法启动 sync.mjs：${syncRun.error.message}`);
    code = 1;
    syncResult = { status: 'failure', reason: 'sync-spawn-failed', message: `无法启动 sync.mjs：${syncRun.error.message}` };
  } else if (syncRun.status === null) {
    line('❌ sync.mjs 被异常终止（无退出码）');
    code = 1;
    syncResult = { status: 'failure', reason: 'sync-killed', message: 'sync.mjs 被异常终止（无退出码）' };
  } else {
    code = syncRun.status;
    syncResult = readSyncResult();
    if (!syncResult) {
      // 中间结果文件缺失：退出码 0 时无法判断是成功还是无需同步，只能标记未知
      syncResult = code === 0
        ? { status: 'unknown', reason: 'missing-result', message: '未读取到 sync.mjs 的结果文件' }
        : { status: 'failure', reason: 'sync-exit', message: `sync.mjs 异常退出（退出码 ${code}）` };
    }
  }
}

// 只有本次成功且推送步骤开启时才补推：失败时把历史提交继续留着，避免故障状态下越推越乱
if (code === 0 && STEPS.push && RETRY_PUSH) {
  const retryCode = pushLeftovers();
  if (retryCode !== 0) {
    code = retryCode;
    syncResult = { status: 'failure', reason: 'push-leftover-failed', message: '补推失败，提交保留到下次同步再补推' };
  }
}

// 退出码非 0 时结果必须一致地标为失败（正常路径下 sync.mjs/补推已经这么写了，这里是兜底）
if (code !== 0 && (!syncResult || syncResult.status !== 'failure')) {
  syncResult = {
    status: 'failure',
    reason: syncResult ? `${syncResult.reason}-exit` : 'unknown-exit',
    message: syncResult ? syncResult.message : `同步异常退出（退出码 ${code}）`,
  };
}
if (!syncResult) syncResult = { status: 'unknown', reason: 'no-result', message: '未执行同步' };

writeResult(syncResult.status, syncResult.reason, syncResult.message, code);
process.exit(code);
