// probe.mjs — 线路1 预探测（在独立 GHA job 中运行，无候选则跳过整个同步 job）
// 运行：node scripts/auto-sync/probe.mjs
// 输出：若存在待同步版本，向 $GITHUB_OUTPUT 写入 needs_sync=true；否则 needs_sync=false
// 本脚本不读 H1111_USER / H1111_PASSWORD，不触碰网盘、不写文件、不跑 git

import {
  ctx, SOFTWARES,
  compareVersionsDescending, versionFromTag,
  entryVersionKey, parseDataSourceIndex,
  fetchReleases,
} from './lib.mjs';

async function main() {
  ctx.log(`==== 线路1 预探测开始（${SOFTWARES.length} 个软件） ====`);
  let hasCandidates = false;
  let overallFailed = false;

  for (const sw of SOFTWARES) {
    ctx.log(`\n---- 探测软件 id=${sw.softwareId}（${sw.githubRepo}） ----`);
    try {
      const { latest: dsLatest, entries: origEntries } = parseDataSourceIndex(sw.softwareId);
      ctx.log(`数据源最新版本：${dsLatest || '（无）'}`);
      if (dsLatest) ctx.log(`数据源版本数：${origEntries.filter((e) => entryVersionKey(e.nextUrl) != null).length}`);

      ctx.log(`拉取 GitHub Releases：${sw.githubRepo} …`);
      const releases = await fetchReleases(sw.githubRepo, !!sw.includePrerelease);
      ctx.log(`Release 总数（非 draft${sw.includePrerelease ? '' : '、非 prerelease'}）：${releases.length}`);
      if (!releases.length) { ctx.log('（无 Release，跳过）'); continue; }

      const versioned = releases
        .map((r) => ({ version: versionFromTag(r.tag_name) }))
        .filter((x) => /^[vV]?[0-9]/.test(x.version))
        .filter((x, i, arr) => arr.findIndex((y) => y.version === x.version) === i);

      let candidates;
      if (!dsLatest) {
        candidates = versioned.slice(0, 1);
        ctx.log(`数据源无版本 → 只取最新 Release：${candidates[0]?.version || ''}`);
      } else {
        candidates = versioned.filter((x) => compareVersionsDescending(dsLatest, x.version) > 0);
        ctx.log(`落后 ${candidates.length} 个版本：${candidates.map((c) => c.version).join(', ') || '（无）'}`);
      }
      candidates.sort((a, b) => compareVersionsDescending(b.version, a.version));

      if (!candidates.length) { ctx.log('（已是最新）'); continue; }
      ctx.log(`→ 需同步 ${candidates.length} 个版本`);
      hasCandidates = true;
    } catch (e) {
      overallFailed = true;
      ctx.log(`❌ 软件 ${sw.softwareId} 探测失败：${e.message}`);
    }
  }

  // 写入 GHA job 输出
  const ghOutput = process.env.GITHUB_OUTPUT;
  const needsSync = hasCandidates ? 'true' : 'false';
  if (ghOutput) {
    const fs = await import('node:fs');
    fs.appendFileSync(ghOutput, `needs_sync=${needsSync}\n`);
    ctx.log(`\n已写入 GITHUB_OUTPUT：needs_sync=${needsSync}`);
  }

  // GHA 告警：有探测错误时在 Actions UI 显示黄色警告，但仍以 exit 0 完成 job，
  // 确保 sync job 的 if 条件（needs.probe.outputs.needs_sync == 'true'）能正常评估
  if (overallFailed && process.env.GITHUB_ACTIONS === 'true') {
    console.log('::warning::预探测存在错误（详见上方日志），但仍将根据 needs_sync 决定是否调度 sync job');
  }
  ctx.log(`\n==== 预探测结束：needs_sync=${needsSync}${overallFailed ? '（存在探测错误）' : ''} ====`);
  console.log('\n--- 完整日志 ---');
  console.log(ctx.runLog.join('\n'));
  // 永远 exit 0：GHA 将 exit ≠ 0 视为 job 失败，失败的 probe 会导致 sync job 被跳过，
  // 即便 needs_sync=true 也无济于事；因此错误通过 ::warning:: 告警，退出码保持 0
  process.exit(0);
}

main().catch(async (e) => {
  console.error('预探测异常：' + (e.stack || e.message));
  // 异常时默认有候选（宁可多跑一次同步 job，也不要漏掉）
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const fs = await import('node:fs');
    try { fs.appendFileSync(ghOutput, 'needs_sync=true\n'); } catch { /* ignore */ }
  }
  // 异常也不 exit 1：避免因 probe 崩溃导致 sync job 被跳过
  // 通过 ::error:: 在 GHA UI 显示红色错误标记
  if (process.env.GITHUB_ACTIONS === 'true') {
    console.log('::error::预探测发生严重异常：' + e.message + '（已默认写入 needs_sync=true）');
  }
  console.log('\n--- 完整日志 ---');
  console.log(ctx.runLog.join('\n'));
  process.exit(0);
});
