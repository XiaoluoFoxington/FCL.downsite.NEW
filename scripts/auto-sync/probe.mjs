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

  ctx.log(`\n==== 预探测结束：needs_sync=${needsSync}${overallFailed ? '（存在探测错误）' : ''} ====`);
  console.log('\n--- 完整日志 ---');
  console.log(ctx.runLog.join('\n'));
  // 有候选 + 无错误 = exit 0（让 sync job 运行）
  // 有候选 + 有错误 = exit 1（警告有错误，但仍然要尝试同步）
  // 无候选 = exit 0（正常跳过）
  process.exit(overallFailed ? 1 : 0);
}

main().catch(async (e) => {
  console.error('预探测异常：' + (e.stack || e.message));
  // 异常时默认有候选（宁可多跑一次同步 job，也不要漏掉）
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    const fs = await import('node:fs');
    try { fs.appendFileSync(ghOutput, 'needs_sync=true\n'); } catch { /* ignore */ }
  }
  process.exit(1);
});
