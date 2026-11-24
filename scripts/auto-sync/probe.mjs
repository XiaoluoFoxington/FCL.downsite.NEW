// probe.mjs — 线路1 预探测（在独立 GHA job 中运行，无候选则整个 sync job 不调度）
// 运行：node scripts/auto-sync/probe.mjs
// 输出：有候选 → 向 $GITHUB_OUTPUT 写 needs_sync=true；否则 false
//
// 本脚本不读任何凭据（H1111_SESSION / H1111_USER / H1111_PASSWORD），不触碰网盘、不写数据文件、不跑 git。
// （会话巡检是**独立的一步** check-session.mjs，会读 H1111_SESSION 做只读验活。）
//
// 探测逻辑来自 plan.mjs（与 sync.mjs 共用同一份实现，避免两边口径漂移）。
// 日志实现来自 logger.mjs —— 无时间戳前缀、无 ::group:: 折叠、树形缩进、末尾不重打。

import { appendFileSync } from 'node:fs';

import { SOFTWARES } from './lib.mjs';
import { Logger, renderSoftwareTable, newRow, errText, fmtDur } from './logger.mjs';
import { planAll } from './plan.mjs';

const log = new Logger({ rootTitle: `线路1 预探测 · ${SOFTWARES.length} 个软件` });
const t0 = Date.now();

async function main() {
  const phase = log.child('阶段：逐软件比对数据源与 GitHub Releases');
  const { plans, rows, hasCandidates, failed, guarded } = await planAll(SOFTWARES, phase, (sw) => newRow(sw.softwareId, sw));
  phase.close(
    failed
      ? `⚠️ 探测结束：${rows.length} 个软件（${failed} 个出错）｜有候选 ${plans.length} 个`
      : `✅ 探测结束：${rows.length} 个软件｜有候选 ${plans.length} 个` +
        (guarded.length ? `｜暂缓 ${guarded.length} 个（发布未满守护时间）` : ''),
    { kind: failed ? 'warn' : 'ok' },
  );

  const needsSync = hasCandidates ? 'true' : 'false';
  const total = fmtDur(Date.now() - t0);

  // ---- 结论行 ----
  const verdict = log.child('判定');
  verdict.line(`有候选软件：${plans.length} / ${SOFTWARES.length}`);
  if (plans.length) {
    verdict.items(plans.map((p) => `id=${p.sw.softwareId}：${p.candidates.map((c) => c.version).join('、')}`));
  }
  if (guarded.length) {
    verdict.line(`不完整守护暂缓 ${guarded.length} 个：` +
      guarded.map((g) => `id=${g.id} ${g.version}`).join('、'));
  }
  verdict.line(hasCandidates ? '→ 调度 sync job（needs_sync=true）' : '→ 全部最新，不调度 sync job（needs_sync=false）');
  verdict.close(`✅ 判定完成｜用时 ${total}`, { body: false });

  // ---- GITHUB_OUTPUT ----
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    appendFileSync(ghOutput, `needs_sync=${needsSync}\n`);
    log.line(`已写入 GITHUB_OUTPUT：needs_sync=${needsSync}`);
  } else {
    log.line(`（本地运行，未设置 GITHUB_OUTPUT，needs_sync=${needsSync}）`);
  }

  // ---- 汇总页：详细表 ----
  const extra = [
    `- 触发时间（UTC+8）：${new Date(Date.now() + 8 * 3600 * 1000).toISOString().replace('T', ' ').slice(0, 19)}`,
    `- 软件总数：${SOFTWARES.length}｜有候选：${plans.length}｜守护暂缓：${guarded.length}｜探测出错：${failed}`,
    `- 判定：${hasCandidates ? '**有候选 → 调度同步 job**' : '**全部最新 → 跳过同步 job**'}`,
    `- 探测用时：${total}`,
  ];
  log.summary(renderSoftwareTable(rows, { title: '线路1 预探测汇总', extra }));

  log.annotate(
    failed ? 'warning' : 'notice',
    failed
      ? `预探测有 ${failed} 个软件出错（详见日志），仍按 needs_sync=${needsSync} 决定是否调度同步`
      : `预探测完成：${needsSync === 'true' ? `有 ${plans.length} 个软件待同步` : '全部已是最新'}`,
  );

  log.line(`预探测结束：needs_sync=${needsSync}${failed ? `（${failed} 个软件探测出错）` : ''}｜总用时 ${total}`);
  log.flushSummary();
  // 永远 exit 0：GHA 把 exit≠0 视为 job 失败，失败的 probe 会导致 sync job 被跳过，
  // 那样即便 needs_sync=true 也无济于事。错误通过 ::warning:: 与汇总表暴露。
  process.exit(0);
}

main().catch((e) => {
  // 探测崩溃时宁可多跑一次同步，也不要漏掉新版本
  const msg = errText(e);
  process.stderr.write(`预探测异常：${e.stack || msg}\n`);
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    try { appendFileSync(ghOutput, 'needs_sync=true\n'); } catch { /* 忽略 */ }
  }
  log.annotate('error', `预探测严重异常，已默认 needs_sync=true：${msg}`);
  log.summary([
    '### 线路1 预探测汇总',
    '',
    '> 预探测脚本发生严重异常，无法输出逐软件结果。',
    `> ❌ ${msg}`,
    '',
    '> 已默认写入 `needs_sync=true`，同步 job 仍会调度。',
  ]);
  log.flushSummary();
  process.exit(0);
});
