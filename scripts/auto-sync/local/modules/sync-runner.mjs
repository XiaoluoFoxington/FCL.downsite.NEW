// sync-runner.mjs — 六阶段同步编排：Prepare → Pull → Sync → Commit → Push → Finish
//
// 关键约束（设计 §8）：
//   · Sync 阶段**只调用**共享业务入口 sync.mjs（GHA 同一份实现），不重新实现任何下载/写 JSON 逻辑
//       - 通过 LOCAL_SYNC_STEP_COMMIT=0 / LOCAL_SYNC_STEP_PUSH=0 让业务层只写数据文件，
//         Commit / Push 由本模块按本地配置控制（同样只操作 data/down/<id>，不碰用户其它改动）
//       - 通过 LOCAL_SYNC_RESULT_FILE 拿结构化结果，绝不解析日志文本判断成败
//   · Push 失败不回滚本地 Commit；下一轮先看 ahead，必要时按策略 Pull 后再推
//   · Finish 一定执行（WiFi 清理、临时资源）
//   · 只有四类状态：success / up-to-date / failure / internal-error；取消不算成功

import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { STATE_DIR, SYNC_SCRIPT, REPO_ROOT } from './paths.mjs';
import * as git from './git.mjs';
import * as wifi from './wifi.mjs';

const RESULT_FILE = path.join(STATE_DIR, 'sync-result.json');

/** 取消令牌：允许「安全取消」——先杀子进程树，再在阶段边界停下 */
export function createCancelToken() {
  return {
    cancelled: false,
    reason: '',
    child: null,
    cancel(reason = '用户取消') {
      if (this.cancelled) return;
      this.cancelled = true;
      this.reason = reason;
      if (this.child && this.child.pid && !this.child.killed) {
        this.child.killed = true;
        git.killTree(this.child.pid);
      }
    },
  };
}

function isoNow() {
  return new Date().toISOString();
}

function identityModeForChild(identityMode) {
  if (identityMode === 'default') return 'git';
  if (identityMode === 'custom') return 'custom';
  return 'script';
}

/** 子进程环境：凭据只走环境变量（绝不进 argv）；剥掉 GHA 专属变量，避免本地跑出 ::命令/Summary */
function buildChildEnv(config, resultFile) {
  const creds = config.credentials || {};
  const env = { ...process.env };
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_OUTPUT', 'GITHUB_STEP_SUMMARY', 'GITHUB_REPOSITORY', 'GITHUB_REF_NAME', 'GITHUB_TOKEN', 'H1111_SESSION', 'H1111_USER', 'H1111_PASSWORD', 'LOCAL_SYNC_STEP_COMMIT', 'LOCAL_SYNC_STEP_PUSH']) {
    delete env[key];
  }
  if (creds.H1111_SESSION) env.H1111_SESSION = creds.H1111_SESSION;
  if (creds.H1111_USER) env.H1111_USER = creds.H1111_USER;
  if (creds.H1111_PASSWORD) env.H1111_PASSWORD = creds.H1111_PASSWORD;
  if (creds.GH_TOKEN) env.GITHUB_TOKEN = creds.GH_TOKEN;
  env.LOCAL_SYNC_RESULT_FILE = resultFile;
  env.LOCAL_SYNC_STEP_COMMIT = '0';
  env.LOCAL_SYNC_STEP_PUSH = '0';
  env.LOCAL_SYNC_GIT_IDENTITY = identityModeForChild((config.stages.commit || {}).identityMode);
  env.LOCAL_SYNC_GIT_USER_NAME = (config.stages.commit || {}).userName || '';
  env.LOCAL_SYNC_GIT_USER_EMAIL = (config.stages.commit || {}).userEmail || '';
  return env;
}

function readResultFile(file) {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    return raw && typeof raw === 'object' ? raw : null;
  } catch {
    return null;
  }
}

/**
 * 跑一轮 sync.mjs。
 * @returns {Promise<{exitCode:number|null, timedOut:boolean, cancelled:boolean, spawnError:string|null, result:object|null}>}
 */
function runSyncChild({ config, log, cancelToken, onLine, root, syncScript }) {
  const timeoutMs = Math.max(1, Number((config.runtime || {}).syncTimeoutMinutes || 120)) * 60 * 1000;
  try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch { /* 忽略 */ }
  try { fs.unlinkSync(RESULT_FILE); } catch { /* 不存在就算了 */ }

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [syncScript], {
        cwd: root,
        env: buildChildEnv(config, RESULT_FILE),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      resolve({ exitCode: null, timedOut: false, cancelled: false, spawnError: e && e.message ? e.message : String(e), result: null });
      return;
    }
    cancelToken.child = child;

    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      log.error('Sync', `同步超时（${Math.round(timeoutMs / 60000)} 分钟），终止子进程树`);
      git.killTree(child.pid);
    }, timeoutMs);

    const pipe = (stream, sink) => {
      let buf = '';
      stream.on('data', (chunk) => {
        buf += chunk.toString('utf8');
        let idx;
        while ((idx = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, idx).replace(/\r$/, '');
          buf = buf.slice(idx + 1);
          if (line.trim()) sink(line);
        }
      });
      stream.on('end', () => {
        if (buf.trim()) sink(buf.trim());
        buf = '';
      });
    };
    pipe(child.stdout, (line) => { log.child(line); if (onLine) onLine(line); });
    pipe(child.stderr, (line) => { log.warn('Sync:stderr', line); });

    const finish = (code, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      cancelToken.child = null;
      resolve({
        exitCode: typeof code === 'number' ? code : null,
        timedOut,
        cancelled: cancelToken.cancelled,
        spawnError: spawnError || null,
        result: readResultFile(RESULT_FILE),
      });
    };
    child.on('error', (e) => finish(null, e && e.message ? e.message : String(e)));
    child.on('close', (code) => finish(code, null));
  });
}

/**
 * 执行一轮同步。
 *
 * @param {object} opts
 * @param {object} opts.config 本轮配置快照（执行中用户改配置只影响下一轮）
 * @param {object} opts.log 日志器
 * @param {(p:{stage:string,message:string})=>void} [opts.onProgress]
 * @param {object} [opts.cancelToken]
 * @returns {Promise<object>} 结构化结果（见 local/PROTOCOL.md §10）
 */
export async function runRound({
  config, log, onProgress = () => {}, cancelToken = createCancelToken(),
  // root / syncScript 默认取仓库实际位置；自动化测试可指向临时仓库，正常运行时不需要传
  root = REPO_ROOT, syncScript = SYNC_SCRIPT,
}) {
  const startedAt = isoNow();
  const t0 = Date.now();
  const stages = [];
  const warnings = [];
  let committed = false;
  let pushed = false;
  let aheadAtEnd = null;
  let syncPayload = null;
  let failure = null;
  let internalError = null;
  let prepared = null;

  const progress = (stage, message) => {
    try { onProgress({ stage, message }); } catch { /* UI 回调异常不能影响同步 */ }
  };

  const stageLog = {
    info: (tag, msg) => log.info(tag, msg),
    warn: (tag, msg) => log.warn(tag, msg),
    line: (msg) => log.info('Stage', msg),
  };

  /** 记录一个阶段的耗时与结论 */
  const mark = (name, status, message, extra = {}) => {
    stages.push({ name, status, durationMs: Date.now() - t0, message, ...extra });
    const level = status === 'failed' ? 'error' : status === 'ok' ? 'info' : 'warn';
    log[level](`Stage:${name}`, `${status === 'ok' ? '✅' : status === 'failed' ? '❌' : '⏭️'} ${message}`);
  };

  const cancelledResult = () => {
    const now = Date.now();
    return {
      status: 'failure',
      startedAt,
      finishedAt: isoNow(),
      durationMs: now - t0,
      message: '同步已取消',
      stats: null,
      error: { stage: stages.length ? stages[stages.length - 1].name : 'prepare', code: 'CANCELLED', message: cancelToken.reason || '用户取消' },
      stages,
      committed,
      pushed,
      aheadAtEnd: null,
      warnings,
    };
  };

  try {
    // ================= 1) Prepare =================
    progress('prepare', '检查网络与 WiFi');
    const prep = await wifi.prepare(config, stageLog);
    prepared = prep;
    warnings.push(...(prep.warnings || []));
    if (!prep.ok) {
      failure = { stage: 'prepare', code: (prep.error || {}).code || 'WIFI_CONNECT_FAILED', message: (prep.error || {}).message || 'WiFi 连接失败' };
      mark('prepare', 'failed', `准备阶段失败：${failure.message}`);
    } else {
      mark('prepare', 'ok', '网络准备完成');
    }

    if (cancelToken.cancelled) return cancelledResult();

    // ================= 2) Pull =================
    let repoInfo = null;
    if (!failure) {
      progress('pull', '检查 Git 仓库状态');
      const pullCfg = config.stages.pull || {};
      if (!pullCfg.enabled) {
        mark('pull', 'skipped', 'Pull 阶段已在配置中关闭');
      } else {
        repoInfo = await git.inspectRepo(root);
        const safety = git.safetyCheck(repoInfo);
        warnings.push(...safety.warnings);
        for (const w of safety.warnings) log.warn('Pull', w);
        if (!safety.ok) {
          failure = { stage: 'pull', code: safety.error.code, message: safety.error.message };
          mark('pull', 'failed', `Git 检查失败：${safety.error.message}`);
        } else {
          const timeoutMs = Math.max(1, Number((config.runtime || {}).pullTimeoutMinutes || 10)) * 60 * 1000;
          const result = await git.pull(root, { strategy: pullCfg.strategy || 'rebase', timeoutMs, info: repoInfo });
          if (result.status === 'ok') mark('pull', 'ok', `Pull 完成（${result.strategy}）`);
          else if (result.status === 'skipped') mark('pull', 'skipped', result.skippedReason || 'Pull 已跳过');
          else {
            failure = { stage: 'pull', code: result.error.code, message: result.error.message };
            mark('pull', 'failed', `Pull 失败：${result.error.message}`);
          }
        }
      }
    } else {
      mark('pull', 'skipped', '上一阶段失败，跳过 Pull');
    }

    if (cancelToken.cancelled) return cancelledResult();

    // ================= 3) Sync =================
    if (!failure) {
      progress('sync', '运行共享同步业务');
      if (!(config.stages.sync || {}).enabled) {
        mark('sync', 'skipped', 'Sync 阶段已在配置中关闭');
      } else {
        const run = await runSyncChild({ config, log, cancelToken, root, syncScript });
        if (run.cancelled) {
          log.warn('Sync', '同步子进程已取消');
          return cancelledResult();
        }
        syncPayload = run.result;
        if (run.spawnError) {
          internalError = { stage: 'sync', code: 'SYNC_SPAWN_FAILED', message: `无法启动同步业务：${run.spawnError}` };
          mark('sync', 'failed', internalError.message);
        } else if (run.timedOut) {
          failure = { stage: 'sync', code: 'SYNC_TIMEOUT', message: `同步超时（${(config.runtime || {}).syncTimeoutMinutes} 分钟）已终止` };
          mark('sync', 'failed', failure.message);
        } else if (run.exitCode !== 0) {
          const first = (syncPayload && Array.isArray(syncPayload.errors) && syncPayload.errors[0]) || `同步业务退出码 ${run.exitCode}`;
          failure = { stage: 'sync', code: 'SYNC_FAILED', message: String(first) };
          mark('sync', 'failed', `同步失败：${failure.message}`);
        } else if (syncPayload && syncPayload.ok === false) {
          const first = (Array.isArray(syncPayload.errors) && syncPayload.errors[0]) || '同步业务报告失败';
          failure = { stage: 'sync', code: 'SYNC_FAILED', message: String(first) };
          mark('sync', 'failed', `同步失败：${failure.message}`);
        } else if (syncPayload && syncPayload.allLatest) {
          mark('sync', 'ok', '同步完成：全部软件已是最新');
        } else {
          mark('sync', 'ok', '同步完成：已生成新数据');
        }
      }
    } else {
      mark('sync', 'skipped', '上一阶段失败，跳过 Sync');
    }

    if (cancelToken.cancelled) return cancelledResult();

    // ================= 4) Commit =================
    const commitCfg = config.stages.commit || {};
    let commitItems = [];
    if (syncPayload && Array.isArray(syncPayload.items)) {
      commitItems = syncPayload.items
        .map((it) => ({
          id: String(it.id),
          versions: Array.isArray(it.versions) ? it.versions.map(String) : [],
          pruned: Array.isArray(it.pruned) ? it.pruned.map(String) : [],
        }))
        .filter((it) => it.versions.length || it.pruned.length);
    }

    if (failure || internalError) {
      mark('commit', 'skipped', '上一阶段失败，跳过 Commit');
    } else if (!commitCfg.enabled) {
      mark('commit', 'skipped', 'Commit 阶段已在配置中关闭（数据留在工作区）');
    } else if (!commitItems.length) {
      mark('commit', 'skipped', '本轮无数据变更，无需提交');
    } else {
      progress('commit', '提交数据变更');
      const body = [
        '本地托盘自动同步生成的数据变更。',
        `生成时间：${startedAt}`,
        `涉及资源：${commitItems.map((it) => `id=${it.id}`).join('、')}`,
      ];
      const timeoutMs = 120000;
      const result = await git.commitData({
        root: root,
        items: commitItems,
        identity: {
          identityMode: commitCfg.identityMode,
          userName: commitCfg.userName,
          userEmail: commitCfg.userEmail,
        },
        bodyLines: body,
        timeoutMs,
      });
      if (!result.ok) {
        failure = { stage: 'commit', code: result.error.code, message: result.error.message };
        mark('commit', 'failed', `提交失败：${result.error.message}`);
      } else if (result.skipped) {
        mark('commit', 'skipped', '数据无实际文件变更，未产生提交');
      } else {
        committed = true;
        mark('commit', 'ok', `已提交 ${result.commits.filter((c) => c.subject).length} 个软件的数据变更`);
      }
    }

    if (cancelToken.cancelled) return cancelledResult();

    // ================= 5) Push =================
    const pushCfg = config.stages.push || {};
    if (failure || internalError) {
      mark('push', 'skipped', '上一阶段失败，跳过 Push（本地提交保留，下一轮继续推）');
    } else if (!pushCfg.enabled) {
      mark('push', 'skipped', 'Push 阶段已在配置中关闭（提交保留在本地）');
    } else {
      progress('push', '检查并推送远端');
      const timeoutMs = Math.max(1, Number((config.runtime || {}).pushTimeoutMinutes || 5)) * 60 * 1000;

      // 先 fetch 一次，拿到最新的 ahead/behind（Push 失败恢复的关键）
      const fetched = await git.fetch(root, { timeoutMs: 120000 });
      if (!fetched.ok) log.warn('Push', `git fetch 失败（继续按本地已知状态判断）：${fetched.error}`);

      repoInfo = await git.inspectRepo(root);
      aheadAtEnd = repoInfo.ahead;

      if (repoInfo.ahead === 0) {
        mark('push', 'skipped', '没有待推送的提交');
      } else {
        let pulledForPush = null;
        if (repoInfo.behind > 0) {
          log.info('Push', `远端领先 ${repoInfo.behind} 个提交，按策略先 Pull 再推`);
          const pullTimeoutMs = Math.max(1, Number((config.runtime || {}).pullTimeoutMinutes || 10)) * 60 * 1000;
          pulledForPush = await git.pull(root, {
            strategy: (config.stages.pull || {}).strategy || 'rebase',
            timeoutMs: pullTimeoutMs,
            info: repoInfo,
          });
          if (pulledForPush.status === 'failed') {
            failure = { stage: 'push', code: pulledForPush.error.code, message: `推送前 Pull 失败：${pulledForPush.error.message}` };
            mark('push', 'failed', failure.message);
          } else if (pulledForPush.status === 'skipped') {
            log.warn('Push', `推送前无法 Pull（${pulledForPush.skippedReason}），直接尝试推送`);
          }
          repoInfo = await git.inspectRepo(root);
          aheadAtEnd = repoInfo.ahead;
        }

        if (!failure) {
          const pushedResult = await git.push(root, { timeoutMs, info: repoInfo });
          if (pushedResult.ok) {
            pushed = true;
            const ahead = repoInfo.ahead;
            mark('push', 'ok', `已推送 ${ahead} 个提交到 ${git.pushTarget(repoInfo).remote}/${git.pushTarget(repoInfo).ref}`);
          } else {
            failure = { stage: 'push', code: pushedResult.error.code, message: pushedResult.error.message };
            mark('push', 'failed', `推送失败：${pushedResult.error.message}（提交保留在本地，下一轮继续尝试）`);
          }
        }
        const after = await git.inspectRepo(root);
        aheadAtEnd = after.ahead;
      }
    }

    if (cancelToken.cancelled) return cancelledResult();
  } catch (e) {
    internalError = { stage: 'unknown', code: 'UNEXPECTED_ERROR', message: e && e.message ? e.message : String(e) };
    log.error('Runner', `未捕获异常：${e && e.stack ? e.stack : e}`);
  } finally {
    // ================= 6) Finish（必定执行） =================
    try {
      progress('finish', '收尾');
      const finishResult = wifi.finish(config, prepared, { failed: Boolean(failure || internalError) }, stageLog);
      warnings.push(...(finishResult.warnings || []));
      mark('finish', finishResult.warnings && finishResult.warnings.length ? 'ok' : 'ok', '收尾完成');
    } catch (e) {
      warnings.push(`收尾失败：${e && e.message ? e.message : e}`);
      log.error('Finish', `收尾阶段异常：${e && e.message ? e.message : e}`);
    }
  }

  const durationMs = Date.now() - t0;
  const finishedAt = isoNow();

  // ---------- 结果分类 ----------
  let status;
  let message;
  let error = null;
  let stats = null;

  const syncItems = (syncPayload && Array.isArray(syncPayload.items)) ? syncPayload.items : [];
  const syncedItems = syncItems.filter((it) => Array.isArray(it.versions) && it.versions.length);
  const versionCount = syncedItems.reduce((sum, it) => sum + it.versions.length, 0);
  if (versionCount || syncedItems.length) stats = { resources: syncedItems.length, versions: versionCount };

  if (internalError) {
    status = 'internal-error';
    error = internalError;
    message = internalError.message;
  } else if (failure) {
    status = 'failure';
    error = failure;
    message = failure.message;
  } else if (!(config.stages.sync || {}).enabled && !committed && !pushed) {
    status = 'up-to-date';
    message = 'Sync 阶段已在配置中关闭，本轮未执行同步';
  } else if (committed || pushed) {
    status = 'success';
    const parts = [];
    if (stats && stats.versions) parts.push(`同步了 ${stats.resources} 个资源，共 ${stats.versions} 个版本`);
    else parts.push('已生成新数据');
    if (pushed) parts.push('已推送远端');
    else if (!(config.stages.push || {}).enabled) parts.push('提交保留在本地（Push 已关闭）');
    message = parts.join('，');
  } else if (syncPayload && syncPayload.allLatest) {
    status = 'up-to-date';
    message = '当前已是最新';
    if (stats) stats = null;
  } else {
    status = 'up-to-date';
    message = '本轮没有需要同步的内容';
  }

  if (warnings.length) {
    log.warn('Runner', `本轮警告：${warnings.join('；')}`);
  }

  return {
    status,
    startedAt,
    finishedAt,
    durationMs,
    message,
    stats,
    error,
    stages,
    committed,
    pushed,
    aheadAtEnd,
    warnings,
    // 供通知文案使用
    meta: {
      softwareTotal: syncPayload ? syncPayload.softwareTotal : null,
      softwareOk: syncPayload ? syncPayload.softwareOk : null,
      allLatest: Boolean(syncPayload && syncPayload.allLatest),
    },
  };
}

export { RESULT_FILE };
