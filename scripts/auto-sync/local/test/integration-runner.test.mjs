// integration-runner.test.mjs — 六阶段编排的端到端回归（临时仓库 + 假 sync.mjs）
//
// 覆盖设计 §20.4 的硬性回归：
//   · 正常 Pull / Commit / Push，远端真的收到提交
//   · Push 失败（远端领先且本轮不允许 Pull）→ 状态 failure，但**本地提交不丢**
//   · 下一轮按策略 Pull 后补推成功（Push 失败恢复）
//   · 不执行强推：远端历史里两边的提交都在
//   · 全部已是最新 → up-to-date（不发提交）
//
// 做法：把 FDN_REPO_ROOT 指到临时仓库，把 FDN_LOCAL_DIR 指到临时数据目录，
//       在临时仓库里放一个**假 sync.mjs**（只按 FAKE_SYNC_MODE 写结果文件 + 数据文件），
//       这样不需要网络、不碰真实仓库，也不会真的调用 huang1111/ GitHub。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const REPO_SRC = path.resolve('scripts/auto-sync/local');

function git(cwd, args) {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
  return r.stdout.trim();
}

function initRepo(root) {
  fs.mkdirSync(root, { recursive: true });
  spawnSync('git', ['init', '--initial-branch=main', root], { encoding: 'utf8', windowsHide: true });
  git(root, ['config', 'user.name', 'Test Bot']);
  git(root, ['config', 'user.email', 'bot@example.com']);
  git(root, ['config', 'commit.gpgsign', 'false']);
  fs.mkdirSync(path.join(root, 'data', 'down'), { recursive: true });
  fs.writeFileSync(path.join(root, 'README.md'), '# temp\n');
  git(root, ['add', '-A']);
  git(root, ['commit', '-m', 'init']);
}

const FAKE_SYNC = `// 假同步业务：按 FAKE_SYNC_MODE 决定结果，只写结果文件与数据文件
import fs from 'node:fs';
import path from 'node:path';

const mode = process.env.FAKE_SYNC_MODE || 'new';
const out = process.env.LOCAL_SYNC_RESULT_FILE;
const root = process.cwd();
const softwareId = '19';
const dataDir = path.join(root, 'data', 'down', softwareId);

function writeResult(payload) {
  if (out) fs.writeFileSync(out, JSON.stringify(payload, null, 2));
}

process.stdout.write('假同步业务开始\\n');

if (process.env.LOCAL_SYNC_STEP_COMMIT !== '0') {
  process.stderr.write('❌ 期望托盘把 LOCAL_SYNC_STEP_COMMIT 设为 0（提交由本地 runner 负责）\\n');
  process.exit(3);
}
if (process.env.LOCAL_SYNC_STEP_PUSH !== '0') {
  process.stderr.write('❌ 期望托盘把 LOCAL_SYNC_STEP_PUSH 设为 0（推送由本地 runner 负责）\\n');
  process.exit(4);
}

if (mode === 'fail') {
  writeResult({ ok: false, stage: 'sync', allLatest: false, softwareTotal: 1, softwareOk: 0, items: [], errors: ['假失败：网盘 API 报错'] });
  process.stdout.write('假同步业务失败\\n');
  process.exit(1);
}

if (mode === 'up-to-date') {
  writeResult({ ok: true, stage: 'sync', allLatest: true, softwareTotal: 1, softwareOk: 1, items: [{ id: softwareId, result: '✅ 已是最新', versions: [], pruned: [] }], errors: [] });
  process.stdout.write('假同步业务：全部已是最新\\n');
  process.exit(0);
}

fs.mkdirSync(dataDir, { recursive: true });
fs.writeFileSync(path.join(dataDir, 'index.json'), JSON.stringify({ versions: ['9.9.9'] }, null, 2));
writeResult({ ok: true, stage: 'sync', allLatest: false, softwareTotal: 1, softwareOk: 1, items: [{ id: softwareId, result: '✅ 已同步', versions: ['9.9.9'], pruned: [] }], errors: [] });
process.stdout.write('假同步业务：同步了 9.9.9\\n');
process.exit(0);
`;

/** 建一个临时工作区：bare 远端 + 本地克隆 + 假 sync.mjs + 本地数据目录 */
function makeWorkspace(tag) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `fdn-int-${tag}-`));
  const remote = path.join(tmp, 'remote.git');
  spawnSync('git', ['init', '--bare', '--initial-branch=main', remote], { encoding: 'utf8', windowsHide: true });

  const seed = path.join(tmp, 'seed');
  initRepo(seed);
  git(seed, ['remote', 'add', 'origin', remote]);
  git(seed, ['push', '-u', 'origin', 'main']);

  const work = path.join(tmp, 'work');
  spawnSync('git', ['clone', remote, work], { encoding: 'utf8', windowsHide: true });
  git(work, ['config', 'user.name', 'Test Bot']);
  git(work, ['config', 'user.email', 'bot@example.com']);
  git(work, ['config', 'commit.gpgsign', 'false']);

  // 假业务脚本放在临时仓库里，供 sync-runner 以子进程方式执行
  const syncDir = path.join(work, 'scripts', 'auto-sync');
  fs.mkdirSync(syncDir, { recursive: true });
  fs.writeFileSync(path.join(syncDir, 'sync.mjs'), FAKE_SYNC);
  git(work, ['add', 'scripts/auto-sync/sync.mjs']);
  git(work, ['commit', '-m', 'add fake sync']);
  git(work, ['push']);

  const localDir = path.join(tmp, 'local');
  fs.mkdirSync(localDir, { recursive: true });

  return { tmp, remote, work, localDir, seed };
}

const baseConfig = (localDir) => ({
  version: 1,
  runtime: { nodePath: '', syncTimeoutMinutes: 2, pullTimeoutMinutes: 2, pushTimeoutMinutes: 1 },
  startup: { enabled: false, runOnStart: false },
  scheduler: { intervalMinutes: 10, catchUpOnWake: true },
  wifi: {
    enabled: false, ssid: '', password: '', useSavedFirst: true, alwaysConnect: false,
    skipOnFailure: true, disconnectAfter: false, disconnectEvenOnFailure: true, forgetOnDisconnect: false,
  },
  stages: {
    pull: { enabled: true, strategy: 'rebase' },
    sync: { enabled: true },
    commit: { enabled: true, identityMode: 'custom', userName: 'Test Bot', userEmail: 'bot@example.com' },
    push: { enabled: true },
  },
  credentials: { H1111_SESSION: 'FAKE', H1111_USER: '', H1111_PASSWORD: '', GH_TOKEN: '', PUSH_TOKEN: '' },
  notifications: {
    mode: 'standard',
    standard: { success: true, 'up-to-date': false, failure: true, 'internal-error': true },
    cumulative: { everyRuns: 7, internalErrorMode: 'always' },
  },
  appearance: { iconPath: null },
  logging: { retentionDays: 7 },
  security: { lockPassword: '' },
});

const silentLog = { debug() {}, info() {}, warn() {}, error() {}, raw() {}, child() {} };

// sync-runner 只在 import 时读一次 paths（本地数据目录），所以这里统一指定一个临时目录
const LOCAL_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'fdn-int-local-'));
process.env.FDN_LOCAL_DIR = LOCAL_DATA;

const { runRound } = await import(`file:///${REPO_SRC.replace(/\\/g, '/')}/modules/sync-runner.mjs`);

/** 按临时仓库跑一轮：root + syncScript 都指向临时仓库里的假业务脚本 */
const round = (ws, config) => runRound({
  config,
  log: silentLog,
  root: ws.work,
  syncScript: path.join(ws.work, 'scripts', 'auto-sync', 'sync.mjs'),
});


test('六阶段：正常同步 → 提交 → 推送，远端收到提交', async () => {
  const ws = makeWorkspace('happy');
    process.env.FAKE_SYNC_MODE = 'new';

  const result = await round(ws, baseConfig(ws.localDir));

  assert.equal(result.status, 'success', `期望 success，实际 ${result.status}：${result.error ? result.error.message : ''}`);
  assert.equal(result.committed, true);
  assert.equal(result.pushed, true);
  assert.deepEqual(result.stats, { resources: 1, versions: 1 });
  assert.equal(result.aheadAtEnd, 0, '推送后不应再有待推提交');

  const remoteLog = git(ws.remote, ['log', '--format=%s', '-n', '4']);
  assert.match(remoteLog, /资源id-19：9\.9\.9/, '远端应收到本地提交');
  assert.equal(git(ws.work, ['status', '--porcelain']), '', '提交后工作区应干净');

  fs.rmSync(ws.tmp, { recursive: true, force: true });
});

test('全部已是最新 → up-to-date，不产生提交', async () => {
  const ws = makeWorkspace('latest');
    process.env.FAKE_SYNC_MODE = 'up-to-date';

  const before = git(ws.work, ['rev-parse', 'HEAD']);
  const result = await round(ws, baseConfig(ws.localDir));

  assert.equal(result.status, 'up-to-date', `实际 ${result.status}`);
  assert.equal(result.committed, false);
  assert.equal(git(ws.work, ['rev-parse', 'HEAD']), before, '不应产生新提交');

  fs.rmSync(ws.tmp, { recursive: true, force: true });
});

test('Push 失败不回滚本地提交，下一轮补推成功（远端 pre-receive 拒绝）', async () => {
  const ws = makeWorkspace('recover');

  // 远端装一个可控的 pre-receive 钩子：存在 reject-flag 时拒绝一切推送（模拟「远端拒绝了推送」）
  const hookDir = path.join(ws.remote, 'hooks');
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(path.join(hookDir, 'pre-receive'), [
    '#!/bin/sh',
    'if [ -f "$GIT_DIR/reject-flag" ]; then',
    '  echo "远端拒绝：测试用 pre-receive 钩子" >&2',
    '  exit 1',
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.writeFileSync(path.join(ws.remote, 'reject-flag'), '1');

  process.env.FAKE_SYNC_MODE = 'new';
  const first = await round(ws, baseConfig(ws.localDir));

  assert.equal(first.status, 'failure', `期望 failure，实际 ${first.status}`);
  assert.equal(first.error.stage, 'push');
  assert.equal(first.committed, true, '本地提交必须保留（不回滚）');
  assert.ok(first.aheadAtEnd >= 1, `本地应仍有待推提交，实际 ${first.aheadAtEnd}`);
  assert.match(git(ws.work, ['log', '-1', '--format=%s']), /资源id-19/, '提交没有被回滚');

  // 第二轮：远端放开推送，业务报「已是最新」，只剩上一轮的提交要补推
  fs.unlinkSync(path.join(ws.remote, 'reject-flag'));
  process.env.FAKE_SYNC_MODE = 'up-to-date';
  const second = await round(ws, baseConfig(ws.localDir));

  assert.equal(second.status, 'success', `期望补推成功，实际 ${second.status}：${second.error ? second.error.message : 'ok'}`);
  assert.equal(second.pushed, true);
  assert.equal(second.aheadAtEnd, 0);

  const remoteLog = git(ws.remote, ['log', '--format=%s', '-n', '6']);
  assert.match(remoteLog, /资源id-19/, '远端应收到补推的提交');

  fs.rmSync(ws.tmp, { recursive: true, force: true });
});

test('远端领先时推送前会自动 Pull（避免把提交推成非快进）', async () => {
  const ws = makeWorkspace('behind');

  const other = path.join(ws.tmp, 'other');
  spawnSync('git', ['clone', ws.remote, other], { encoding: 'utf8', windowsHide: true });
  git(other, ['config', 'user.name', 'Other']);
  git(other, ['config', 'user.email', 'other@example.com']);
  fs.writeFileSync(path.join(other, 'other.txt'), 'remote change\n');
  git(other, ['add', '-A']);
  git(other, ['commit', '-m', 'remote: other change']);
  git(other, ['push']);

  process.env.FAKE_SYNC_MODE = 'new';
  const result = await round(ws, baseConfig(ws.localDir));

  assert.equal(result.status, 'success', `实际 ${result.status}：${result.error ? result.error.message : ''}`);
  assert.equal(result.pushed, true);
  const remoteLog = git(ws.remote, ['log', '--format=%s', '-n', '6']);
  assert.match(remoteLog, /remote: other change/, '远端原有提交必须保留（没有强推）');
  assert.match(remoteLog, /资源id-19/, '本地提交也已推送');

  // 远端历史应是线性快进（rebase），没有 merge 提交
  const merges = git(ws.remote, ['log', '--merges', '--format=%s']);
  assert.equal(merges, '', '不应产生 merge 提交（策略为 rebase）');

  fs.rmSync(ws.tmp, { recursive: true, force: true });
});

test('Sync 业务失败 → failure，且不做提交/推送', async () => {
  const ws = makeWorkspace('syncfail');
    process.env.FAKE_SYNC_MODE = 'fail';

  const before = git(ws.work, ['rev-parse', 'HEAD']);
  const result = await round(ws, baseConfig(ws.localDir));

  assert.equal(result.status, 'failure');
  assert.equal(result.error.stage, 'sync');
  assert.equal(result.committed, false);
  assert.equal(result.pushed, false);
  assert.equal(git(ws.work, ['rev-parse', 'HEAD']), before);

  fs.rmSync(ws.tmp, { recursive: true, force: true });
});

test('未完成的 rebase 会阻止自动 Pull（不擅自 abort 用户操作）', async () => {
  const ws = makeWorkspace('rebase');
    process.env.FAKE_SYNC_MODE = 'up-to-date';

  fs.mkdirSync(path.join(ws.work, '.git', 'rebase-merge'), { recursive: true });
  const result = await round(ws, baseConfig(ws.localDir));

  assert.equal(result.status, 'failure');
  assert.equal(result.error.code, 'GIT_REBASE_IN_PROGRESS');
  assert.equal(result.stages.find((s) => s.name === 'pull').status, 'failed');
  assert.ok(fs.existsSync(path.join(ws.work, '.git', 'rebase-merge')), '不得擅自删除用户的 rebase 状态');

  fs.rmSync(ws.tmp, { recursive: true, force: true });
});

test('工作区有用户未提交修改 → 跳过 Pull，不覆盖用户改动', async () => {
  const ws = makeWorkspace('dirty');
    process.env.FAKE_SYNC_MODE = 'up-to-date';

  fs.writeFileSync(path.join(ws.work, 'user-notes.txt'), '用户自己的改动\n');
  const result = await round(ws, baseConfig(ws.localDir));

  assert.ok(result.stages.find((s) => s.name === 'pull').status === 'skipped', 'Pull 应被跳过');
  assert.equal(result.status, 'up-to-date');
  assert.equal(fs.readFileSync(path.join(ws.work, 'user-notes.txt'), 'utf8'), '用户自己的改动\n', '用户文件内容不得被改动');

  fs.rmSync(ws.tmp, { recursive: true, force: true });
});