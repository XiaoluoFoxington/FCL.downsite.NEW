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
//   LOCAL_SYNC_DEBUG=0|1               调试模式：跳过所有 git 网络操作（不 pull / 不 push）
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
const DEBUG = process.env.LOCAL_SYNC_DEBUG === '1';

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

  if (DEBUG) {
    line('（debug 模式：跳过 git pull）');
    return true;
  }

  if (!PULL_ENABLED) {
    line('（pullBeforeSync 已关闭，跳过拉取）');
    return true;
  }

  const branch = currentBranch();
  if (!branch) {
    line('❌ 当前处于 detached HEAD，无法安全拉取，已取消本次同步');
    return false;
  }
  if (rebaseInProgress()) {
    line('❌ 仓库里有未完成的 rebase，已取消本次同步（不替你 abort，请手动处理）');
    return false;
  }

  const baseArgs = PULL_STRATEGY === 'ff-only' ? ['pull', '--ff-only'] : ['pull', '--rebase'];
  // 没配 upstream 但远端有同名分支时，显式指定 origin/<branch>，否则 git pull 会直接报错
  const strategyArgs = upstreamRef() ? baseArgs : [...baseArgs, 'origin', branch];
  const t0 = Date.now();
  const r = git(strategyArgs, { timeout: PULL_TIMEOUT_MS });

  if (r.error && r.error.code === 'ETIMEDOUT') {
    line(`❌ git pull 超时（${fmtMs(PULL_TIMEOUT_MS)}），已取消本次同步`);
  } else if (r.error) {
    line(`❌ 无法执行 git pull：${r.error.message}，已取消本次同步`);
  } else if (r.status !== 0) {
    line(`❌ git pull 失败（退出码 ${r.status}），已取消本次同步`);
  } else {
    line(`✅ 已拉取 ${upstreamRef() || `origin/${branch}`}｜用时 ${fmtMs(Date.now() - t0)}`);
    return true;
  }

  // pull --rebase 冲突会停在半截 rebase；既然拉取要取消，顺手把状态回滚干净
  if (PULL_STRATEGY === 'rebase' && rebaseInProgress()) {
    const aborted = git(['rebase', '--abort'], { stdio: 'ignore' });
    line(aborted.status === 0
      ? '已回滚未完成的 rebase（工作区恢复到拉取前）'
      : '⚠ 回滚 rebase 失败，请手动检查仓库状态');
  }
  return false;
}

function pushLeftovers() {
  if (DEBUG) {
    line('');
    line('（debug 模式：跳过补推，提交保留在本地）');
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
if (DEBUG) line('🐛 调试模式：跳过 git pull / push，提交只留在本地');
if (GIT_TOKEN) {
  const remote = gitText(['remote', 'get-url', 'origin']);
  if (/^(git@|ssh:)/i.test(remote)) {
    line('⚠ origin 使用 SSH，令牌只对 HTTPS 生效，本次仍走 SSH 凭据');
  }
}

if (!pull()) {
  line('');
  line('❌ 拉取失败，本次同步已取消（未下载、未提交）');
  process.exit(2);
}

line('');
line('========== 开始执行 sync.mjs ==========');
const syncRun = spawnSync(process.execPath, [SYNC_SCRIPT], {
  cwd: ROOT,
  stdio: 'inherit',
  env: process.env,
});

let code = 0;
if (syncRun.error) {
  line(`❌ 无法启动 sync.mjs：${syncRun.error.message}`);
  code = 1;
} else if (syncRun.status === null) {
  line('❌ sync.mjs 被异常终止（无退出码）');
  code = 1;
} else {
  code = syncRun.status;
}

// 只有本次同步成功才补推：失败时把历史提交继续留着，避免在故障状态下越推越乱
if (code === 0 && RETRY_PUSH) {
  const retryCode = pushLeftovers();
  if (retryCode !== 0) code = retryCode;
}

process.exit(code);
