// git.mjs — Git 操作封装（spawn + shell:false + 超时；绝不拼命令行字符串）
//
// 安全边界（设计 §8.5）：
//   · 只操作当前仓库：不 reset --hard、不 clean -fd、不 push --force、不改 remote URL、不改全局 config
//   · 身份只用 `-c user.name=...` 内联（custom / gha），default 模式完全不动身份
//   · 检测到未完成的 merge / rebase / cherry-pick 时只报告，不擅自 abort 用户的操作
//     （唯一例外：本轮自己发起的 pull --rebase 冲突，回滚到拉取前状态，避免把仓库留在半截）
//   · 不把 Token 拼进 URL：鉴权由 main.mjs 通过 GIT_CONFIG_* 注入 http.extraheader，只对子进程生效

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';

/** 强杀整棵进程树（Windows 下 node 的子 git 子进程不会随父进程自动退出） */
export function killTree(pid) {
  if (!pid) return;
  try {
    spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { windowsHide: true, stdio: 'ignore', timeout: 15000 });
  } catch { /* 忽略 */ }
}

/**
 * 运行一条 git 命令（stdout/stderr 全部捕获，不回显到协议 stdout）。
 * @returns {Promise<{ok:boolean, code:number|null, stdout:string, stderr:string, timedOut:boolean, error:string|null}>}
 */
export function runGit(root, args, opts = {}) {
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? opts.timeoutMs : 120000;
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn('git', ['-C', root, ...args], {
        shell: false,
        windowsHide: true,
        env: opts.env || process.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ ok: false, code: null, stdout: '', stderr: '', timedOut: false, error: e && e.message ? e.message : String(e) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
        timedOut = true;
        killTree(child.pid);
      }, timeoutMs)
      : null;

    child.stdout.on('data', (buf) => { stdout += buf.toString('utf8'); });
    child.stderr.on('data', (buf) => { stderr += buf.toString('utf8'); });

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({
        ok: !error && !timedOut && code === 0,
        code: typeof code === 'number' ? code : null,
        stdout,
        stderr,
        timedOut,
        error: error || null,
      });
    };

    child.on('error', (e) => finish(null, e && e.message ? e.message : String(e)));
    child.on('close', (code) => finish(code, null));
  });
}

/** 读取一条 git 命令的输出（失败返回 ''） */
export async function gitText(root, args, opts = {}) {
  const r = await runGit(root, args, opts);
  return r.ok ? r.stdout.trim() : '';
}

/** 判断 .git 下的某个路径是否存在（rebase 等状态文件） */
function gitPathExists(root, name) {
  try {
    const r = spawnSync('git', ['-C', root, 'rev-parse', '--git-path', name], {
      windowsHide: true, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 15000,
    });
    if (r.status !== 0) return false;
    const p = String(r.stdout || '').trim();
    if (!p) return false;
    return fs.existsSync(path.isAbsolute(p) ? p : path.resolve(root, p));
  } catch {
    return false;
  }
}

/**
 * 仓库体检（每轮 Git 操作前调用）。
 * @returns {Promise<object>} 见下方字段
 */
export async function inspectRepo(root) {
  const info = {
    root,
    isRepo: false,
    branch: '',
    detached: false,
    upstream: '',
    remoteUrl: '',
    ahead: 0,
    behind: 0,
    dirty: false,
    dirtyPaths: [],
    ops: { merge: false, rebase: false, cherryPick: false },
    error: null,
  };

  const inside = await runGit(root, ['rev-parse', '--is-inside-work-tree'], { timeoutMs: 20000 });
  if (!inside.ok || inside.stdout.trim() !== 'true') {
    info.error = inside.error || (inside.stderr || '').trim() || '不是 Git 工作区';
    return info;
  }
  info.isRepo = true;

  const branch = (await gitText(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
  info.branch = branch === 'HEAD' ? '' : branch;
  info.detached = branch === 'HEAD';

  info.upstream = await gitText(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  info.remoteUrl = await gitText(root, ['remote', 'get-url', 'origin']);

  const status = await runGit(root, ['status', '--porcelain'], { timeoutMs: 60000 });
  if (status.ok) {
    const lines = status.stdout.split(/\r?\n/).filter((l) => l.trim());
    info.dirtyPaths = lines;
    info.dirty = lines.length > 0;
  }

  info.ops.merge = gitPathExists(root, 'MERGE_HEAD');
  info.ops.rebase = gitPathExists(root, 'rebase-merge') || gitPathExists(root, 'rebase-apply');
  info.ops.cherryPick = gitPathExists(root, 'CHERRY_PICK_HEAD');

  // ahead/behind：优先用 upstream；没有 upstream 时退回 origin/<branch>（否则推送决策会误判为「无待推」）
  const range = info.upstream ? 'HEAD...@{u}' : (info.branch ? `HEAD...origin/${info.branch}` : '');
  if (range) {
    const counts = await gitText(root, ['rev-list', '--left-right', '--count', range]);
    const m = /^(\d+)\s+(\d+)$/.exec(counts.trim());
    if (m) {
      info.ahead = Number(m[1]);
      info.behind = Number(m[2]);
    }
  }
  return info;
}

/** 拉取远端引用（不合并），让 ahead/behind 反映最新远端 */
export async function fetch(root, { timeoutMs = 120000 } = {}) {
  const upstream = await gitText(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const remote = upstream ? upstream.split('/')[0] : 'origin';
  const r = await runGit(root, ['fetch', remote, '--tags'], { timeoutMs });
  return { ok: r.ok, error: r.ok ? null : (r.error || (r.stderr || '').trim() || `git fetch 退出码 ${r.code}`), timedOut: r.timedOut };
}

/**
 * 安全检查：把「不该继续自动操作」的情况分类出来。
 * @returns {{ ok: boolean, error: {code:string,message:string}|null, warnings: string[] }}
 */
export function safetyCheck(info) {
  const warnings = [];
  if (!info.isRepo) {
    return { ok: false, error: { code: 'GIT_NOT_A_REPO', message: info.error || '当前目录不是 Git 仓库' }, warnings };
  }
  if (info.ops.rebase) return { ok: false, error: { code: 'GIT_REBASE_IN_PROGRESS', message: '仓库存在未完成的 rebase，请手动处理后重试' }, warnings };
  if (info.ops.merge) return { ok: false, error: { code: 'GIT_MERGE_IN_PROGRESS', message: '仓库存在未完成的 merge，请手动处理后重试' }, warnings };
  if (info.ops.cherryPick) return { ok: false, error: { code: 'GIT_CHERRYPICK_IN_PROGRESS', message: '仓库存在未完成的 cherry-pick，请手动处理后重试' }, warnings };
  if (info.detached) return { ok: false, error: { code: 'GIT_DETACHED_HEAD', message: '当前处于 detached HEAD，无法安全拉取/推送' }, warnings };
  if (!info.branch) return { ok: false, error: { code: 'GIT_NO_BRANCH', message: '无法确定当前分支' }, warnings };
  if (!info.upstream) warnings.push('当前分支没有 upstream，将回退为 origin/<分支>');
  if (info.dirty) warnings.push(`工作区存在 ${info.dirtyPaths.length} 处用户修改，本轮跳过自动 Pull`);
  return { ok: true, error: null, warnings };
}

/**
 * Pull（仅当工作区干净时才真正执行）。
 * @returns {Promise<{status:'ok'|'skipped'|'failed', skippedReason:string|null, error:object|null, strategy:string}>}
 */
export async function pull(root, { strategy = 'rebase', timeoutMs = 600000, info = null } = {}) {
  const repo = info || await inspectRepo(root);
  if (repo.dirty) {
    return { status: 'skipped', skippedReason: '工作区有未提交修改，跳过自动 Pull（不覆盖用户改动）', error: null, strategy };
  }
  if (repo.detached || !repo.branch) {
    return { status: 'failed', skippedReason: null, error: { code: 'GIT_DETACHED_HEAD', message: '当前处于 detached HEAD，无法安全拉取' }, strategy };
  }
  if (repo.ops.rebase || repo.ops.merge || repo.ops.cherryPick) {
    return { status: 'failed', skippedReason: null, error: { code: 'GIT_OPERATION_IN_PROGRESS', message: '仓库有未完成的 merge/rebase/cherry-pick' }, strategy };
  }

  const baseArgs = strategy === 'ff-only' ? ['pull', '--ff-only'] : ['pull', '--rebase'];
  const args = repo.upstream ? baseArgs : [...baseArgs, 'origin', repo.branch];
  const r = await runGit(root, args, { timeoutMs });

  if (r.ok) return { status: 'ok', skippedReason: null, error: null, strategy };

  // 本轮自己发起的 rebase 落在半截 → 回滚到拉取前（不擅自解决冲突，也不把仓库留在坏状态）
  const inProgress = gitPathExists(root, 'rebase-merge') || gitPathExists(root, 'rebase-apply');
  if (strategy !== 'ff-only' && inProgress) {
    await runGit(root, ['rebase', '--abort'], { timeoutMs: 60000 });
  }

  const code = r.timedOut ? 'GIT_PULL_TIMEOUT'
    : /conflict|CONFLICT|冲突/i.test(r.stderr) ? 'GIT_PULL_CONFLICT'
      : 'GIT_PULL_FAILED';
  const message = r.timedOut
    ? `git pull 超时（${Math.round(timeoutMs / 60000)} 分钟）`
    : `git pull 失败：${(r.error || r.stderr || '').split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') || `退出码 ${r.code}`}`;
  return { status: 'failed', skippedReason: null, error: { code, message }, strategy };
}

/** 供提交使用的身份参数（不写 --global，只作用于本次提交） */
export function identityArgs({ identityMode = 'gha', userName = '', userEmail = '' } = {}) {
  if (identityMode === 'default') return [];
  if (identityMode === 'custom') {
    const args = [];
    if (userName && userName.trim()) args.push('-c', `user.name=${userName.trim()}`);
    if (userEmail && userEmail.trim()) args.push('-c', `user.email=${userEmail.trim()}`);
    return args;
  }
  return [
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
  ];
}

/** 提交主题：与 GHA 版 sync.mjs 完全一致的格式 */
export function buildSubject(softwareId, versionList) {
  return `[GHA] 新增：内容：数据源：资源id-${softwareId}：${versionList}呜~`;
}

/**
 * 逐软件提交 data/down/<id> 的变更（不暂存任何其它路径）。
 * @param {object} opts
 * @param {string} opts.root
 * @param {Array<{id:string, versions:string[], pruned:string[]}>} opts.items
 * @returns {Promise<{ok:boolean, commits:Array<{id:string,subject:string|null}>, error:object|null, skipped:boolean}>}
 */
export async function commitData(opts) {
  const { root, items = [], identity = {}, bodyLines = [], timeoutMs = 120000 } = opts;
  const commits = [];
  let skipped = true;

  for (const item of items) {
    const id = String(item.id || '').trim();
    if (!id) continue;
    const versions = (item.versions || []).map((v) => String(v));
    const pruned = (item.pruned || []).map((v) => String(v));
    if (!versions.length && !pruned.length) { commits.push({ id, subject: null }); continue; }

    const add = await runGit(root, ['add', '--', `data/down/${id}`], { timeoutMs });
    if (!add.ok) {
      return { ok: false, commits, skipped, error: { code: 'GIT_ADD_FAILED', message: `git add data/down/${id} 失败：${(add.error || add.stderr || '').trim()}` } };
    }

    // 有暂存变更才提交：git diff --cached --quiet 退出码 0 = 无变化
    const diff = await runGit(root, ['diff', '--cached', '--quiet', '--', `data/down/${id}`], { timeoutMs });
    if (diff.ok) { commits.push({ id, subject: null }); continue; }

    const versionList = versions.join('&') || pruned.join('&');
    const subject = versions.length ? buildSubject(id, versionList) : `[GHA] 删除：内容：数据源：资源id-${id}：${versionList}呜~`;
    const message = bodyLines.length ? bodyLines.join('\n') : `本地托盘自动同步：id=${id}`;
    // --only + pathspec：只提交本次数据文件，哪怕用户的其它改动已经在索引里也不能被卷进 [GHA] 提交
    const r = await runGit(
      root,
      [...identityArgs(identity), 'commit', '--only', '-m', subject, '-m', message, '--', `data/down/${id}`],
      { timeoutMs },
    );
    if (!r.ok) {
      return { ok: false, commits, skipped, error: { code: 'GIT_COMMIT_FAILED', message: `提交 id=${id} 失败：${(r.error || r.stderr || '').trim()}` } };
    }
    skipped = false;
    commits.push({ id, subject });
  }

  return { ok: true, commits, skipped, error: null };
}

/** 推送目标（优先 upstream，其次 origin/<branch>） */
export function pushTarget(info) {
  if (info.upstream) {
    const slash = info.upstream.indexOf('/');
    if (slash > 0) return { remote: info.upstream.slice(0, slash), ref: info.upstream.slice(slash + 1) };
  }
  if (info.branch) return { remote: 'origin', ref: info.branch };
  return null;
}

/**
 * Push（永不 --force）。
 * @returns {Promise<{ok:boolean, error:object|null}>}
 */
export async function push(root, { timeoutMs = 300000, info = null } = {}) {
  const repo = info || await inspectRepo(root);
  const target = pushTarget(repo);
  if (!target) return { ok: false, error: { code: 'GIT_NO_PUSH_TARGET', message: '无法确定推送目标（没有 upstream 也没有分支）' } };

  const r = await runGit(root, ['push', target.remote, `HEAD:${target.ref}`], { timeoutMs });
  if (r.ok) return { ok: true, error: null };

  const err = (r.error || r.stderr || '').toLowerCase();
  let code = 'GIT_PUSH_FAILED';
  let message = (r.error || r.stderr || '').trim() || `git push 退出码 ${r.code}`;

  if (r.timedOut) {
    code = 'GIT_PUSH_TIMEOUT';
    message = `git push 超时（${Math.round(timeoutMs / 60000)} 分钟）`;
  } else if (/authentication failed|could not read username|permission denied|403/.test(err)) {
    code = 'GIT_AUTH_FAILED';
    message = '推送鉴权失败（检查 PUSH_TOKEN 或本机 git 凭据）';
  } else if (/non-fast-forward|fetch first|rejected/.test(err)) {
    code = 'GIT_PUSH_REJECTED';
    message = '远端拒绝了推送（远端有新提交，需要先拉取）';
  }

  return { ok: false, error: { code, message: message.split(/\r?\n/).filter(Boolean).slice(-3).join(' / ') } };
}
