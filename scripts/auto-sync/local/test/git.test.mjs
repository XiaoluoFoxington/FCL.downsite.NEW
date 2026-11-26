// git.test.mjs — Git 封装（inspectRepo / commitData / pull / push / safetyCheck）
//
// 对应设计文档 §20.4「Git 测试（使用本地 bare repository 模拟远端）」与 PROTOCOL.md §10：
//   · 正常 Pull、Commit、Push；无变更不提交
//   · **Push 失败后下一轮能重新 Push 成功**（设计 §20.4 要求"必须是自动化回归测试"）
//   · 远端有新提交 / Pull 冲突 / 用户未提交修改 / 没有 Upstream / Rebase-Merge 未完成 / detached HEAD
//   · 不会意外覆盖用户修改；不会强推（远端始终保留对方提交）
//
// 全部操作都在 os.tmpdir() 下的临时 bare repo + clone 里进行，
// **绝不在真实仓库根目录跑 git add / commit / push**。
// 每个仓库都设了本地身份（user.name/user.email）并关掉 gpg 签名，保证与机器全局配置无关。

import { describe, test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  runGit, gitText, inspectRepo, fetch, safetyCheck, pull, push, pushTarget,
  commitData, buildSubject, identityArgs,
} from '../modules/git.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fdn-git-'));

/** Windows 反斜杠路径转给 git 时用正斜杠（避免 `F:\` 被当成 URL scheme） */
const fwd = (p) => p.replace(/\\/g, '/');

/**
 * 跑一条 git 命令（测试自己的旁路断言用；被测代码走 modules/git.mjs）。
 * 与产品代码保持一致：shell:false + 数组参数。
 */
function git(cwd, args) {
  const r = spawnSync('git', ['-C', fwd(cwd), ...args], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 120000,
    shell: false,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
  });
  return {
    ok: r.status === 0,
    code: r.status,
    stdout: (r.stdout || '').trim(),
    stderr: (r.stderr || '').trim(),
    error: r.error ? r.error.message : null,
  };
}

function gitOk(cwd, args) {
  const r = git(cwd, args);
  assert.equal(r.ok, true, `git ${args.join(' ')} 失败（cwd=${cwd}）：${r.stderr || r.error || r.stdout}`);
  return r.stdout;
}

/** 每个仓库设本地身份并关掉任何可能打扰自动提交的开关（不碰 --global） */
function configureRepo(dir) {
  for (const [k, v] of [
    ['user.name', 'Local Tester'],
    ['user.email', 'local@example.test'],
    ['commit.gpgsign', 'false'],
  ]) {
    gitOk(dir, ['config', '--local', k, v]);
  }
}

/** 在 data/down/<id> 下写一个数据文件（模拟 sync 业务产物） */
function writeData(root, id, version, extra = '') {
  const dir = path.join(root, 'data', 'down', id);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${version}.json`);
  fs.writeFileSync(file, `${JSON.stringify({ id, version })}${extra}\n`, 'utf8');
  return file;
}

let remote = '';
let seed = '';
let cloneSeq = 0;

/**
 * 克隆一份仓库（从当前远端状态）。
 * 用 `--config core.autocrlf=false` 让 config 在 checkout 之前生效：
 * 否则机器全局 autocrlf=true 会先把工作区落成 CRLF，再改配置就会被判定成"脏"。
 */
function cloneOne(label = 'clone') {
  cloneSeq += 1;
  const dir = path.join(tmpRoot, `${label}-${cloneSeq}`);
  gitOk(tmpRoot, ['clone', '--quiet', '--config', 'core.autocrlf=false', fwd(remote), fwd(dir)]);
  configureRepo(dir);
  return dir;
}

/** 一对仓库：local（被测对象）+ other（扮演另一个人/另一台机器） */
function clonePair() {
  return { local: cloneOne('local'), other: cloneOne('other') };
}

/** 远端（bare）上的所有提交主题，按从新到旧 */
function remoteSubjects() {
  return gitOk(remote, ['log', '--format=%s', 'main']).split(/\r?\n/).filter(Boolean);
}

function remoteCount() {
  return Number(gitOk(remote, ['rev-list', '--count', 'main']));
}

function headSubject(dir) {
  return gitOk(dir, ['log', '-1', '--format=%s']);
}

function headCount(dir) {
  return Number(gitOk(dir, ['rev-list', '--count', 'HEAD']));
}

before(() => {
  // 1) 造一个有内容的种子仓库（main 分支 + data/down + 用户自己的 notes.txt）
  seed = path.join(tmpRoot, 'seed');
  gitOk(tmpRoot, ['init', '--quiet', '--initial-branch=main', fwd(seed)]);
  configureRepo(seed);
  writeData(seed, '111', '1.0.0');
  fs.writeFileSync(path.join(seed, 'notes.txt'), 'user notes\n', 'utf8');
  gitOk(seed, ['add', '-A']);
  gitOk(seed, ['commit', '--quiet', '-m', 'seed: 初始数据']);

  // 2) 造 bare 仓库当远端，并把种子推上去（之后所有 clone 才有 origin/main upstream）
  remote = path.join(tmpRoot, 'remote.git');
  gitOk(tmpRoot, ['init', '--quiet', '--bare', '--initial-branch=main', fwd(remote)]);
  gitOk(seed, ['remote', 'add', 'origin', fwd(remote)]);
  gitOk(seed, ['push', '--quiet', '-u', 'origin', 'main']);

  assert.equal(remoteCount(), 1);
});

after(() => {
  // git 对象文件在 Windows 上是只读的，rmSync 需要重试清除只读属性
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  } catch {
    /* 临时目录清理失败不影响测试结论 */
  }
});

// ---------------------------------------------------------------------------
// inspectRepo
// ---------------------------------------------------------------------------

describe('inspectRepo（设计 §20.4 仓库体检）', () => {
  test('干净克隆：分支/upstream/远端/计数/ops 全部正确', async () => {
    const local = cloneOne();
    const info = await inspectRepo(local);

    assert.equal(info.isRepo, true);
    assert.equal(info.branch, 'main');
    assert.equal(info.detached, false);
    assert.equal(info.upstream, 'origin/main');
    assert.match(info.remoteUrl, /remote\.git\/?$/i);
    assert.equal(info.dirty, false);
    assert.deepEqual(info.dirtyPaths, []);
    assert.equal(info.ahead, 0);
    assert.equal(info.behind, 0);
    assert.deepEqual(info.ops, { merge: false, rebase: false, cherryPick: false });
    assert.equal(info.error, null);
    assert.equal(info.root, local);
  });

  test('脏工作区：已修改 + 未跟踪文件都算 dirty，并给出路径清单', async () => {
    const local = cloneOne();
    fs.writeFileSync(path.join(local, 'notes.txt'), 'user notes（本地改动）\n', 'utf8');
    fs.writeFileSync(path.join(local, 'new-user-file.txt'), '新文件\n', 'utf8');

    const info = await inspectRepo(local);
    assert.equal(info.dirty, true);
    assert.equal(info.dirtyPaths.length, 2);
    assert.ok(info.dirtyPaths.some((l) => l.includes('notes.txt')));
    assert.ok(info.dirtyPaths.some((l) => l.includes('new-user-file.txt')));
  });

  test('ahead / behind：本地领先、远端领先都能算对（先 fetch）', async () => {
    const { local, other } = clonePair();

    // 本地先提交一个数据变更（未推送）
    writeData(local, '222', '1.0.0');
    gitOk(local, ['add', '-A']);
    gitOk(local, ['commit', '--quiet', '-m', 'local: 新增 222']);

    let info = await inspectRepo(local);
    assert.equal(info.ahead, 1, '本地多 1 个提交');
    assert.equal(info.behind, 0);

    // 另一个人也推了一个提交
    writeData(other, '333', '1.0.0');
    gitOk(other, ['add', '-A']);
    gitOk(other, ['commit', '--quiet', '-m', 'other: 新增 333']);
    const pushed = await push(other);
    assert.equal(pushed.ok, true, `对方推送应成功：${JSON.stringify(pushed.error)}`);

    // 没 fetch 前本地还不知道（behind 仍 0）
    info = await inspectRepo(local);
    assert.equal(info.behind, 0, 'fetch 之前看不到远端新提交');

    const f = await fetch(local);
    assert.equal(f.ok, true);
    info = await inspectRepo(local);
    assert.equal(info.ahead, 1);
    assert.equal(info.behind, 1, 'fetch 之后能看到远端领先 1 个提交');
  });

  test('未完成的 rebase（.git/rebase-merge 存在）→ ops.rebase 为真', async () => {
    const local = cloneOne();
    const gitDir = path.join(local, '.git');
    assert.equal(fs.existsSync(gitDir), true, 'clone 出来的 .git 应是目录');
    fs.mkdirSync(path.join(gitDir, 'rebase-merge'), { recursive: true });

    const info = await inspectRepo(local);
    assert.equal(info.ops.rebase, true);
    assert.equal(info.ops.merge, false);
  });

  test('未完成的 merge（MERGE_HEAD 存在）→ ops.merge 为真', async () => {
    const local = cloneOne();
    const head = gitOk(local, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(local, '.git', 'MERGE_HEAD'), `${head}\n`, 'utf8');

    const info = await inspectRepo(local);
    assert.equal(info.ops.merge, true);
  });

  test('detached HEAD → detached=true 且 branch 为空串', async () => {
    const local = cloneOne();
    gitOk(local, ['checkout', '--quiet', '--detach', 'HEAD']);

    const info = await inspectRepo(local);
    assert.equal(info.detached, true);
    assert.equal(info.branch, '');
  });

  test('非 Git 目录 → isRepo=false 且给出可读错误，不抛异常', async () => {
    const notRepo = path.join(tmpRoot, 'not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });

    const info = await inspectRepo(notRepo);
    assert.equal(info.isRepo, false);
    assert.equal(info.branch, '');
    assert.equal(typeof info.error, 'string');
    assert.ok(info.error.length > 0);
  });
});

// ---------------------------------------------------------------------------
// safetyCheck
// ---------------------------------------------------------------------------

describe('safetyCheck（设计 §8.5：检测到未完成操作只报告，不擅自处理）', () => {
  test('未完成 rebase → GIT_REBASE_IN_PROGRESS', async () => {
    const local = cloneOne();
    fs.mkdirSync(path.join(local, '.git', 'rebase-merge'), { recursive: true });

    const info = await inspectRepo(local);
    const safety = safetyCheck(info);
    assert.equal(safety.ok, false);
    assert.deepEqual(safety.error, {
      code: 'GIT_REBASE_IN_PROGRESS',
      message: '仓库存在未完成的 rebase，请手动处理后重试',
    });
  });

  test('未完成 merge → GIT_MERGE_IN_PROGRESS；detached → GIT_DETACHED_HEAD', async () => {
    const local = cloneOne();
    const head = gitOk(local, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(local, '.git', 'MERGE_HEAD'), `${head}\n`, 'utf8');
    let safety = safetyCheck(await inspectRepo(local));
    assert.equal(safety.ok, false);
    assert.equal(safety.error.code, 'GIT_MERGE_IN_PROGRESS');

    fs.unlinkSync(path.join(local, '.git', 'MERGE_HEAD'));
    gitOk(local, ['checkout', '--quiet', '--detach', 'HEAD']);
    safety = safetyCheck(await inspectRepo(local));
    assert.equal(safety.ok, false);
    assert.equal(safety.error.code, 'GIT_DETACHED_HEAD');
    assert.match(safety.error.message, /detached HEAD/);
  });

  test('非仓库 → GIT_NOT_A_REPO', async () => {
    const notRepo = path.join(tmpRoot, 'safety-not-a-repo');
    fs.mkdirSync(notRepo, { recursive: true });
    const safety = safetyCheck(await inspectRepo(notRepo));
    assert.equal(safety.ok, false);
    assert.equal(safety.error.code, 'GIT_NOT_A_REPO');
  });

  test('脏工作区只给 warning（Pull 会自己跳过），没有 upstream 也提示但不阻塞', () => {
    const info = {
      isRepo: true,
      branch: 'main',
      detached: false,
      upstream: '',
      remoteUrl: 'x',
      ahead: 0,
      behind: 0,
      dirty: true,
      dirtyPaths: [' M notes.txt', '?? new.txt'],
      ops: { merge: false, rebase: false, cherryPick: false },
      error: null,
    };
    const safety = safetyCheck(info);
    assert.equal(safety.ok, true);
    assert.equal(safety.error, null);
    assert.ok(safety.warnings.some((w) => w.includes('没有 upstream')));
    assert.ok(safety.warnings.some((w) => w.includes('2 处用户修改')));
  });
});

// ---------------------------------------------------------------------------
// commitData
// ---------------------------------------------------------------------------

describe('commitData（设计 §8.4 / §20.4：只提交 data/down/<id>，绝不碰用户其它改动）', () => {
  test('提交主题与 GHA 完全一致：`[GHA] 新增：内容：数据源：资源id-<id>：<版本>呜~`', async () => {
    const local = cloneOne();
    writeData(local, '1201', '1.0.0');

    const res = await commitData({ root: local, items: [{ id: '1201', versions: ['1.0.0'], pruned: [] }] });

    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
    assert.deepEqual(res.commits, [{ id: '1201', subject: '[GHA] 新增：内容：数据源：资源id-1201：1.0.0呜~' }]);
    assert.equal(headSubject(local), '[GHA] 新增：内容：数据源：资源id-1201：1.0.0呜~');
    assert.equal(headSubject(local), buildSubject('1201', '1.0.0'), '必须与 buildSubject 一致（与 GHA 版同一格式）');
  });

  test('只暂存 data/down/<id>：用户自己改的 notes.txt 不被提交、改动仍在工作区', async () => {
    const local = cloneOne();
    fs.writeFileSync(path.join(local, 'notes.txt'), '这是用户自己的改动，不许提交\n', 'utf8');
    fs.writeFileSync(path.join(local, 'untracked-user.txt'), '未跟踪文件\n', 'utf8');
    writeData(local, '444', '2.0.0');

    const res = await commitData({ root: local, items: [{ id: '444', versions: ['2.0.0'], pruned: [] }] });
    assert.equal(res.ok, true);

    const committedFiles = gitOk(local, ['show', '--name-only', '--format=', 'HEAD']).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(committedFiles, ['data/down/444/2.0.0.json'], '提交里只能有数据文件');
    assert.ok(!committedFiles.includes('notes.txt'));

    // 用户改动没被吞掉
    assert.equal(fs.readFileSync(path.join(local, 'notes.txt'), 'utf8'), '这是用户自己的改动，不许提交\n');
    const status = gitOk(local, ['status', '--porcelain']);
    assert.match(status, /notes\.txt/);
    assert.match(status, /untracked-user\.txt/);
  });

  test('无文件变更 → skipped=true 且不产生新提交', async () => {
    const local = cloneOne();
    writeData(local, '555', '1.0.0');
    const first = await commitData({ root: local, items: [{ id: '555', versions: ['1.0.0'] }] });
    assert.equal(first.skipped, false);
    const countAfterFirst = headCount(local);

    // 同样的 id/版本再来一次，但工作区没有任何变化
    const second = await commitData({ root: local, items: [{ id: '555', versions: ['1.0.0'] }] });
    assert.equal(second.ok, true);
    assert.equal(second.skipped, true, '没有实际变更必须 skipped');
    assert.deepEqual(second.commits, [{ id: '555', subject: null }]);
    assert.equal(headCount(local), countAfterFirst, '不能产生空提交');
  });

  test('只有 pruned（删除）→ 用「删除」主题', async () => {
    const local = cloneOne();
    // 种子里已有 data/down/111/1.0.0.json
    fs.rmSync(path.join(local, 'data', 'down', '111', '1.0.0.json'));

    const res = await commitData({ root: local, items: [{ id: '111', versions: [], pruned: ['1.0.0'] }] });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
    assert.equal(headSubject(local), '[GHA] 删除：内容：数据源：资源id-111：1.0.0呜~');
  });

  test('多版本用 & 连接（与 GHA 版一致）', async () => {
    const local = cloneOne();
    writeData(local, '666', '1.0.0');
    writeData(local, '666', '1.0.1');

    const res = await commitData({ root: local, items: [{ id: '666', versions: ['1.0.0', '1.0.1'] }] });
    assert.equal(res.ok, true);
    assert.equal(headSubject(local), '[GHA] 新增：内容：数据源：资源id-666：1.0.0&1.0.1呜~');
  });

  test('身份模式：gha（默认）/ default（本机 git 配置）/ custom（只作用于本仓库提交）', async () => {
    const gha = cloneOne();
    writeData(gha, '771', '1.0.0');
    let res = await commitData({ root: gha, items: [{ id: '771', versions: ['1.0.0'] }] });
    assert.equal(res.ok, true);
    assert.equal(gitOk(gha, ['log', '-1', ['--format=%an <%ae>'].join('')]), 'github-actions[bot] <github-actions[bot]@users.noreply.github.com>');

    const dflt = cloneOne();
    writeData(dflt, '772', '1.0.0');
    res = await commitData({
      root: dflt,
      items: [{ id: '772', versions: ['1.0.0'] }],
      identity: { identityMode: 'default' },
    });
    assert.equal(res.ok, true);
    assert.equal(gitOk(dflt, ['log', '-1', '--format=%an <%ae>']), 'Local Tester <local@example.test>');

    const custom = cloneOne();
    writeData(custom, '773', '1.0.0');
    res = await commitData({
      root: custom,
      items: [{ id: '773', versions: ['1.0.0'] }],
      identity: { identityMode: 'custom', userName: 'Custom Bot', userEmail: 'custom@example.test' },
    });
    assert.equal(res.ok, true);
    assert.equal(gitOk(custom, ['log', '-1', '--format=%an <%ae>']), 'Custom Bot <custom@example.test>');
    // 不写 --global：仓库配置里的 user.name 不能被 custom 覆盖
    assert.equal(gitOk(custom, ['config', '--local', 'user.name']), 'Local Tester');
  });

  test('多个 item 逐软件提交；空 id 与「无变更」的 item 被跳过', async () => {
    const local = cloneOne();
    writeData(local, '881', '1.0.0');
    writeData(local, '882', '1.0.0');
    const before = headCount(local);

    const res = await commitData({
      root: local,
      items: [
        { id: '881', versions: ['1.0.0'] },
        { id: '', versions: ['9.9.9'] },            // 空 id → 忽略
        { id: '999', versions: [], pruned: [] },    // 无变更 → subject null
        { id: '882', versions: ['1.0.0'] },
      ],
    });

    assert.equal(res.ok, true);
    assert.equal(res.skipped, false);
    assert.deepEqual(res.commits, [
      { id: '881', subject: '[GHA] 新增：内容：数据源：资源id-881：1.0.0呜~' },
      { id: '999', subject: null },
      { id: '882', subject: '[GHA] 新增：内容：数据源：资源id-882：1.0.0呜~' },
    ]);
    assert.equal(headCount(local), before + 2, '两个 id 各一个提交');
    const subjects = gitOk(local, ['log', '-3', '--format=%s']).split(/\r?\n/);
    assert.deepEqual(subjects.slice(0, 2), [
      '[GHA] 新增：内容：数据源：资源id-882：1.0.0呜~',
      '[GHA] 新增：内容：数据源：资源id-881：1.0.0呜~',
    ]);
  });

  test('identityArgs / buildSubject / pushTarget 纯函数契约', () => {
    assert.deepEqual(identityArgs({}), [
      '-c', 'user.name=github-actions[bot]',
      '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
    ]);
    assert.deepEqual(identityArgs({ identityMode: 'default' }), []);
    assert.deepEqual(identityArgs({ identityMode: 'custom', userName: ' A ', userEmail: ' b@c.d ' }), [
      '-c', 'user.name=A', '-c', 'user.email=b@c.d',
    ]);
    assert.equal(buildSubject('123', '1.0.0'), '[GHA] 新增：内容：数据源：资源id-123：1.0.0呜~');

    assert.deepEqual(pushTarget({ upstream: 'origin/main', branch: 'main' }), { remote: 'origin', ref: 'main' });
    assert.deepEqual(pushTarget({ upstream: 'fork/dev', branch: 'main' }), { remote: 'fork', ref: 'dev' });
    assert.deepEqual(pushTarget({ upstream: '', branch: 'feature' }), { remote: 'origin', ref: 'feature' });
    assert.equal(pushTarget({ upstream: '', branch: '' }), null);
  });

  // ⚠ 已知缺陷（未擅自修改产品代码，详见最终报告「发现的问题」）：
  //   commitData 只 `git add data/down/<id>`，但随后用的是不带 pathspec 的 `git commit`，
  //   于是「用户在同步开始前已经 git add 过的其它文件」会被一起卷进这一条
  //   `[GHA] 新增：…` 提交里，违背「只提交 data/down/<id>，不碰用户其它改动」的约定。
  //   复现：git add notes.txt → commitData → `git show --name-only HEAD` 里出现 notes.txt。
  //   建议修法：`git commit --only -m <subject> -m <body> -- data/down/<id>`。
  test('用户已暂存（git add）的其它文件也不得被卷进数据提交', async () => {
    const local = cloneOne();
    fs.writeFileSync(path.join(local, 'notes.txt'), '用户暂存好的改动\n', 'utf8');
    gitOk(local, ['add', 'notes.txt']);
    writeData(local, '1301', '1.0.0');

    const res = await commitData({ root: local, items: [{ id: '1301', versions: ['1.0.0'] }] });
    assert.equal(res.ok, true);

    const committedFiles = gitOk(local, ['show', '--name-only', '--format=', 'HEAD']).split(/\r?\n/).filter(Boolean);
    assert.deepEqual(committedFiles, ['data/down/1301/1.0.0.json'], '用户已暂存的文件不应进入数据提交');
  });
});

// ---------------------------------------------------------------------------
// push / pull
// ---------------------------------------------------------------------------

describe('push（永不 --force）+ Pull（只在干净时真执行）', () => {
  test('正常推送：远端拿到提交', async () => {
    const local = cloneOne();
    writeData(local, '901', '1.0.0');
    await commitData({ root: local, items: [{ id: '901', versions: ['1.0.0'] }] });
    const subject = headSubject(local);

    const res = await push(local);
    assert.equal(res.ok, true);
    assert.equal(res.error, null);
    assert.ok(remoteSubjects().includes(subject), '远端 main 上应出现本地提交');
  });

  test('无待推送提交时 push 也是 ok（不报错、不改远端）', async () => {
    const local = cloneOne();
    const before = remoteCount();
    const res = await push(local);
    assert.equal(res.ok, true);
    assert.equal(remoteCount(), before);
  });

  test('Pull：本地落后时按 rebase 策略拉到远端提交（status=ok）', async () => {
    const { local, other } = clonePair();
    writeData(other, '902', '1.0.0');
    gitOk(other, ['add', '-A']);
    gitOk(other, ['commit', '--quiet', '-m', 'other: 902']);
    const otherSubject = headSubject(other);
    assert.equal((await push(other)).ok, true);

    await fetch(local);
    const res = await pull(local, { strategy: 'rebase' });
    assert.equal(res.status, 'ok');
    assert.equal(res.error, null);
    assert.equal(res.strategy, 'rebase');
    assert.ok(gitOk(local, ['log', '--format=%s']).split(/\r?\n/).includes(otherSubject));
    // 用户文件必须还在（拉取不能覆盖工作区）
    assert.equal(fs.readFileSync(path.join(local, 'notes.txt'), 'utf8'), 'user notes\n');
  });

  test('Pull：工作区脏 → skipped，且绝不覆盖用户改动', async () => {
    const local = cloneOne();
    const mine = '我的本地修改\n';
    fs.writeFileSync(path.join(local, 'notes.txt'), mine, 'utf8');

    const res = await pull(local, { strategy: 'rebase' });
    assert.equal(res.status, 'skipped');
    assert.equal(res.error, null);
    assert.match(res.skippedReason, /工作区有未提交修改/);
    assert.equal(fs.readFileSync(path.join(local, 'notes.txt'), 'utf8'), mine, '用户改动必须原样保留');
  });

  test('Pull：detached HEAD → failed GIT_DETACHED_HEAD', async () => {
    const local = cloneOne();
    gitOk(local, ['checkout', '--quiet', '--detach', 'HEAD']);

    const res = await pull(local);
    assert.equal(res.status, 'failed');
    assert.equal(res.error.code, 'GIT_DETACHED_HEAD');
  });

  test('Pull：仓库里有未完成 rebase → failed GIT_OPERATION_IN_PROGRESS', async () => {
    const local = cloneOne();
    fs.mkdirSync(path.join(local, '.git', 'rebase-merge'), { recursive: true });

    const res = await pull(local);
    assert.equal(res.status, 'failed');
    assert.equal(res.error.code, 'GIT_OPERATION_IN_PROGRESS');
  });

  test('Pull：没有 upstream 时回退成 `pull <remote> <branch>`（设计 §20.4「没有 Upstream」）', async () => {
    const { local, other } = clonePair();

    // 造一个远端存在、但本地分支没有 upstream 的分支
    gitOk(local, ['checkout', '--quiet', '-b', 'feature']);
    gitOk(local, ['push', '--quiet', '-u', 'origin', 'feature']);
    gitOk(local, ['branch', '--unset-upstream']);
    const info = await inspectRepo(local);
    assert.equal(info.upstream, '', '前提：确实没有 upstream');
    assert.ok(safetyCheck(info).warnings.some((w) => w.includes('没有 upstream')));

    // 远端该分支上出现新提交
    gitOk(other, ['fetch', '--quiet', 'origin']);
    gitOk(other, ['checkout', '--quiet', '-B', 'feature', 'origin/feature']);
    writeData(other, '903', '1.0.0');
    gitOk(other, ['add', '-A']);
    gitOk(other, ['commit', '--quiet', '-m', 'other: feature 903']);
    gitOk(other, ['push', '--quiet', 'origin', 'feature']);

    const res = await pull(local, { strategy: 'rebase' });
    assert.equal(res.status, 'ok', `没有 upstream 也应能拉取，error=${JSON.stringify(res.error)}`);
    assert.ok(gitOk(local, ['log', '--format=%s']).includes('other: feature 903'));
  });

  test('runGit / gitText：失败命令给出 ok=false 与 stderr，不抛异常', async () => {
    const local = cloneOne();
    const r = await runGit(local, ['this-subcommand-does-not-exist']);
    assert.equal(r.ok, false);
    assert.notEqual(r.code, 0);
    assert.ok((r.stderr || r.error || '').length > 0);
    assert.equal(r.timedOut, false);

    assert.equal(await gitText(local, ['this-subcommand-does-not-exist']), '', '失败时返回空串');
    assert.equal(await gitText(local, ['rev-parse', '--abbrev-ref', 'HEAD']), 'main');
  });
});

// ---------------------------------------------------------------------------
// Push 失败恢复回归（设计 §20.4 明确要求自动化）
// ---------------------------------------------------------------------------

describe('Push 失败 → 下一轮重新 Push 成功（设计 §20.4 强制回归）', () => {
  test('远端有新提交 → 推送被拒（本地提交保留），下一轮 Pull+Push 后远端拿到该提交', async () => {
    const { local, other } = clonePair();

    // ---- 第 1 步：本地提交（模拟 sync 生成了数据）----
    writeData(local, '1001', '1.0.0');
    const commitRes = await commitData({ root: local, items: [{ id: '1001', versions: ['1.0.0'] }] });
    assert.equal(commitRes.ok, true);
    assert.equal(commitRes.skipped, false);
    const mySubject = headSubject(local);
    assert.equal(mySubject, '[GHA] 新增：内容：数据源：资源id-1001：1.0.0呜~');
    const myCommit = gitOk(local, ['rev-parse', 'HEAD']);
    const remoteBefore = remoteCount();

    // ---- 第 2 步：别人先推了另一个提交 → 本轮 Push 必须失败 ----
    writeData(other, '1002', '1.0.0');
    gitOk(other, ['add', '-A']);
    gitOk(other, ['commit', '--quiet', '-m', 'other: 新增 1002']);
    const otherSubject = headSubject(other);
    assert.equal((await push(other)).ok, true);
    assert.equal(remoteCount(), remoteBefore + 1);

    const failed = await push(local);
    assert.equal(failed.ok, false);
    assert.equal(failed.error.code, 'GIT_PUSH_REJECTED');
    assert.match(failed.error.message, /远端拒绝了推送/);

    // ---- 第 3 步：本地提交绝不能丢（不回滚、不 reset）----
    assert.equal(gitOk(local, ['rev-parse', 'HEAD']), myCommit, '本地提交必须原样保留');
    assert.equal(headSubject(local), mySubject);
    await fetch(local);
    const afterFail = await inspectRepo(local);
    assert.equal(afterFail.ahead, 1, '本地仍有 1 个未推送提交');
    assert.equal(afterFail.behind, 1, '同时落后远端 1 个提交');

    // ---- 第 4 步：没有强推（远端仍只有对方的提交，没有我的）----
    let subjects = remoteSubjects();
    assert.ok(subjects.includes(otherSubject), '远端必须仍保留对方的提交（证明没强推）');
    assert.ok(!subjects.includes(mySubject), '被拒的提交不该出现在远端');
    assert.equal(remoteCount(), remoteBefore + 1);

    // ---- 第 5 步：下一轮：Pull(rebase) + Push 成功 ----
    const pulled = await pull(local, { strategy: 'rebase' });
    assert.equal(pulled.status, 'ok', `下一轮 Pull 应成功：${JSON.stringify(pulled.error)}`);
    const afterPull = await inspectRepo(local);
    assert.equal(afterPull.ahead, 1, 'rebase 之后我的提交还在，且位于对方提交之上');
    assert.equal(afterPull.behind, 0);

    const pushed = await push(local, { info: afterPull });
    assert.equal(pushed.ok, true, `恢复推送应成功：${JSON.stringify(pushed.error)}`);

    // ---- 第 6 步：远端两个提交都在，历史线性（无强推痕迹）----
    subjects = remoteSubjects();
    assert.ok(subjects.includes(mySubject), '远端应拿到我的提交');
    assert.ok(subjects.includes(otherSubject), '远端应仍保留对方的提交');
    assert.equal(remoteCount(), remoteBefore + 2);
    assert.equal(subjects[0], mySubject, '我的提交在最新位置（rebase 到对方之上）');
    assert.equal(subjects[1], otherSubject);
    // 远端与本地一致
    assert.equal(gitOk(remote, ['rev-parse', 'main']), gitOk(local, ['rev-parse', 'HEAD']));
    // 线性历史：没有合并提交
    assert.equal(gitOk(local, ['rev-list', '--merges', '--count', 'HEAD']), '0');
  });

  test('推送前 Pull 发现冲突 → 明确失败（GIT_PULL_CONFLICT），且不把仓库留在半截', async () => {
    const { local, other } = clonePair();

    // 两边都改同一个文件 → rebase 冲突
    writeData(local, '1101', '1.0.0', '本地版本');
    await commitData({ root: local, items: [{ id: '1101', versions: ['1.0.0'] }] });

    writeData(other, '1101', '1.0.0', '对方版本（冲突）');
    gitOk(other, ['add', '-A']);
    gitOk(other, ['commit', '--quiet', '-m', 'other: 改同一个文件']);
    assert.equal((await push(other)).ok, true);
    await fetch(local);

    const res = await pull(local, { strategy: 'rebase' });
    assert.equal(res.status, 'failed');
    assert.equal(res.error.code, 'GIT_PULL_CONFLICT');
    assert.match(res.error.message, /git pull 失败/);

    // 产品代码会 abort 本轮自己发起的 rebase：仓库不能停在 rebase 中间状态
    const info = await inspectRepo(local);
    assert.equal(info.ops.rebase, false, '冲突后必须 abort，不能把仓库留在 rebase 半截');
    assert.equal(info.ops.merge, false);
    // 用户/本地提交仍在
    assert.ok(headSubject(local).includes('1101'));
  });
});

// ---------------------------------------------------------------------------
// 安全红线静态检查（设计 §8.5）
// ---------------------------------------------------------------------------

describe('安全红线（设计 §8.5：不强推 / 不 hard reset / 不 clean / 不用 shell）', () => {
  const source = fs.readFileSync(new URL('../modules/git.mjs', import.meta.url), 'utf8');

  /**
   * 剔掉注释后的「可执行代码」，避免注释里写的"不 reset --hard / 不 push --force"
   * 这类说明文字被误判成违规用法。
   */
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '')                        // 块注释
    .split(/\r?\n/)
    .filter((line) => !line.trim().startsWith('//'))          // 行注释
    .join('\n');

  test('代码里没有 --force / reset --hard / clean -fd', () => {
    assert.equal(/--force\b/.test(codeOnly), false, 'git.mjs 不得出现 --force');
    assert.equal(/reset\s+--hard/.test(codeOnly), false, 'git.mjs 不得 reset --hard');
    assert.equal(/clean\s+-[a-z]*[df]/.test(codeOnly), false, 'git.mjs 不得 clean -fd');
    assert.equal(/\bpush\b[^\n]*-f\b/.test(codeOnly), false, 'git.mjs 不得 push -f');
  });

  test('spawn 参数用数组 + shell:false（不拼命令行字符串，避免注入）', () => {
    assert.match(codeOnly, /spawn\(\s*'git',\s*\[/);
    assert.match(codeOnly, /shell:\s*false/);
    assert.equal(/[^.\w]execSync\s*\(/.test(codeOnly), false, '不得用 execSync 拼命令行');
    assert.equal(/[^.\w]exec\s*\(/.test(codeOnly), false, '不得用 exec 拼命令行（.exec( 是正则方法，允许）');
  });
});
