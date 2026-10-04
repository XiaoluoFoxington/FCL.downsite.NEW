// probe.mjs — 线路1 预探测（在独立 GHA job 中运行，无候选则跳过整个同步 job）
// 运行：node scripts/auto-sync/probe.mjs
// 输出：若存在待同步版本，向 $GITHUB_OUTPUT 写入 needs_sync=true；否则 needs_sync=false
// 本脚本不读 H1111_USER / H1111_PASSWORD，不触碰网盘、不写文件、不跑 git

import { appendFileSync } from 'node:fs';

import {
  SOFTWARES,
  compareVersionsDescending, versionFromTag,
  parseDataSourceIndex,
  fetchReleases,
} from './lib.mjs';
import { log } from './log.mjs';

// GITHUB_STEP_SUMMARY 汇总行（markdown 表格）
const probeRow = (sw, dsLatest, versions, note = '—') =>
  `| ${sw.softwareId} | ${sw.githubRepo} | ${dsLatest || '（无）'} | ${versions.length} | ${versions.join('<br>') || '—'} | ${note} |`;

async function main() {
  log.section(`线路1 预探测（${SOFTWARES.length} 个软件）`);
  log.summary('## 线路1 预探测');
  log.summary('');
  log.summary('| 软件 | 仓库 | 数据源最新 | 待同步数 | 待同步版本 | 备注 |');
  log.summary('|---|---|---|---|---|---|');

  let hasCandidates = false;
  let overallFailed = false;

  for (const sw of SOFTWARES) {
    log.group(`id=${sw.softwareId}（${sw.githubRepo}）`);
    try {
      const { latest: dsLatest } = parseDataSourceIndex(sw.softwareId);
      const releases = await fetchReleases(sw.githubRepo, !!sw.includePrerelease);
      if (!releases.length) {
        log.info(`数据源最新 ${dsLatest || '（无）'}｜无 Release`);
        log.summary(probeRow(sw, dsLatest, [], '无 Release'));
        continue;
      }

      const versioned = releases
        .map((r) => ({ version: versionFromTag(r.tag_name) }))
        .filter((x) => /^[vV]?[0-9]/.test(x.version))
        .filter((x, i, arr) => arr.findIndex((y) => y.version === x.version) === i);

      let candidates;
      if (!dsLatest) {
        candidates = versioned.slice(0, 1);
      } else {
        candidates = versioned.filter((x) => compareVersionsDescending(dsLatest, x.version) > 0);
      }
      candidates.sort((a, b) => compareVersionsDescending(b.version, a.version));

      if (!candidates.length) {
        log.info(`数据源最新 ${dsLatest || '（无）'}｜已是最新`);
        log.summary(probeRow(sw, dsLatest, []));
        continue;
      }
      hasCandidates = true;
      const versions = candidates.map((c) => c.version);
      log.ok(`需同步 ${candidates.length} 个：${versions.join(', ')}`);
      log.summary(probeRow(sw, dsLatest, versions));
    } catch (e) {
      overallFailed = true;
      log.warn(`探测失败：${e.message}`);
      log.summary(probeRow(sw, null, [], '❌ ' + (e.message || '').replace(/\|/g, '\\|')));
    } finally {
      log.end();
    }
  }

  log.summary('---');
  log.summary(`- 判定：${hasCandidates ? '有候选 → 调度同步 job' : '全部最新 → 跳过同步 job'}${overallFailed ? '（存在探测错误）' : ''}`);

  // 写入 GHA job 输出
  const needsSync = hasCandidates ? 'true' : 'false';
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    try { appendFileSync(ghOutput, `needs_sync=${needsSync}\n`); } catch { /* ignore */ }
  }
  log.info(`判定：needs_sync=${needsSync}${overallFailed ? '（存在探测错误）' : ''}`);
  log.flush();

  // 永远 exit 0：GHA 将 exit ≠ 0 视为 job 失败，失败的 probe 会导致 sync job 被跳过，
  // 即便 needs_sync=true 也无济于事
  process.exit(0);
}

main().catch((e) => {
  // 异常时默认有候选（宁可多跑一次同步 job，也不要漏掉）
  const ghOutput = process.env.GITHUB_OUTPUT;
  if (ghOutput) {
    try { appendFileSync(ghOutput, 'needs_sync=true\n'); } catch { /* ignore */ }
  }
  // 异常也不 exit 1：避免因 probe 崩溃导致 sync job 被跳过
  log.warn(`预探测异常：${e.message}（已默认写入 needs_sync=true）`);
  log.flush();
  process.exit(0);
});