// sync.mjs — 线路1 自动同步主流程（GitHub Releases → huang1111 离线下载 → 直链 → 写 JSON → 分软件提交 → push）
// 运行：node scripts/auto-sync/sync.mjs   （需要环境变量 H1111_USER / H1111_PASSWORD）
//
// 检测逻辑（用户确认）：
//   1. 取数据源内最新版本（data/down/{id}/index.json 中可解析的版本条目）
//   2. 若数据源没有版本 → 只取 Release 最新一个
//   3. 否则 → 落后 Release 多少版本，就把落后的全部下载
//
// 重试策略（用户确认，见 config.mjs RETRY）：
//   验证码类失败（登录/取直链）→ 换新验证码最多 10 次
//   离线下载失败              → 提交+轮询最多 3 次
//   其他任何失败（网络/HTTP） → 最多 2 次尝试
//
// 提交格式（用户确认）：`[GHA] 新增：内容：数据源：资源id-{id}：{版本号范围}呜~\n\n{日志}`
// 每个软件一个 commit；全部完成后统一 push。

import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENV } from './config.mjs';
import * as h1 from './h1api.mjs';
import {
  ctx, ROOT, SOFTWARES,
  compareVersionsDescending, versionFromTag, datePathFromRelease,
  entryVersionKey, versionKnown, parseDataSourceIndex,
  fetchReleases, mapAssetsToEntries,
} from './lib.mjs';
const log = (msg) => ctx.log(msg);

// ---------- Git 小工具（不改全局配置，全部 -c 内联；子进程不依赖管道捕获） ----------
function git(args) {
  return execFileSync('git', ['-C', ROOT, ...args], { stdio: 'inherit' });
}
// 只关心退出码的命令（如 git diff --quiet），stdout/stderr 丢弃
function gitQuiet(args) {
  execFileSync('git', ['-C', ROOT, ...args], { stdio: 'ignore' });
  return true;
}
// 读取当前分支名：直接解析 .git/HEAD（无管道捕获，兼容受限沙箱）
function currentBranch() {
  if (ENV.GITHUB_REF_NAME) return ENV.GITHUB_REF_NAME;
  try {
    const head = readFileSync(join(ROOT, '.git', 'HEAD'), 'utf8').trim();
    const m = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
    return m ? m[1] : 'main';
  } catch {
    return 'main';
  }
}

// ---------- 单个版本同步：下载（如缺）→ 取直链 → 写 JSON ----------
// 返回 { version, files:[{arch|name,url,size}], jsonRel } 或 null
async function syncVersion(sw, version, release) {
  log(`  ══ 版本 ${version} ══`);
  // 1) 筛选资产（assetFilter 正则）
  const filterRe = sw.assetFilter ? new RegExp(sw.assetFilter) : null;
  const assets = (release.assets || []).filter((a) => !filterRe || filterRe.test(a.name || ''));
  const entries = mapAssetsToEntries(sw.mode, sw.archNames, sw.fallbackArch, assets);
  if (!entries.length) {
    log(`  ⚠ 无可用资产（共 ${assets.length} 个 .apk），跳过该版本`);
    return null;
  }
  // 网盘路径（根目录 foldcraftlauncher_cn_auto 即"auto"语义，内部与站内日期目录一致）
  const datePath = datePathFromRelease(release);
  const netPath = `foldcraftlauncher_cn_auto/${sw.softwareId}/${datePath}`;
  const wantFiles = entries.map((e) => e._file);

  // 2) 幂等：网盘目录已存在全部期望文件 → 跳过离线下载
  let dir = await h1.listDir(netPath, log);
  const hadAllFiles = dir.exists && wantFiles.every((f) => dir.objects.some((o) => o.type === 'file' && o.name === f));
  if (!hadAllFiles) {
    await h1.offlineDownload(entries.map((e) => e.url), netPath, wantFiles, log);
    dir = await h1.listDir(netPath, log);
  } else {
    log('  [幂等] 网盘目录已全部存在，跳过离线下载');
  }
  if (!dir.exists) throw new Error(`下载完成后目录仍不存在：/${netPath}`);

  // 3) 文件 id + size 映射
  const fileMeta = new Map(dir.objects.filter((o) => o.type === 'file').map((o) => [o.name, o]));
  const missing = wantFiles.filter((f) => !fileMeta.has(f));
  if (missing.length) throw new Error(`目录中缺少文件：${missing.join(', ')}`);

  // 4) 批量取直链（验证码重试 ≤10 在 h1api 内）
  const ids = wantFiles.map((f) => fileMeta.get(f).id);
  const sources = await h1.getSources(ids, log);
  const urlById = new Map(sources.map((s) => [s.id, s.url]));
  const sized = entries.map((e) => {
    const meta = fileMeta.get(e._file);
    const url = urlById.get(meta.id);
    if (!url) throw new Error(`直链缺失：${e._file}`);
    return { ...(sw.mode === 'name' ? { name: e.name } : { arch: e.arch }), url, size: meta.size };
  });

  // 5) 写 data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json（与 index.json nextUrl 完全一致）
  const jsonRel = `data/down/${sw.softwareId}/auto/${datePath}/${version}.json`;
  const jsonPath = join(ROOT, jsonRel);
  mkdirSync(dirname(jsonPath), { recursive: true });
  writeFileSync(jsonPath, JSON.stringify(sized, null, 2));
  log(`  ✅ 已写 ${jsonRel}（${sized.length} 个文件，共 ${sized.reduce((s, e) => s + (e.size || 0), 0)} 字节）`);
  for (const e of sized) log(`     · ${e.arch || e.name}: ${e.url}（${e.size || '?'} 字节）`);
  return { version, files: sized, jsonRel };
}

// ---------- 更新 index.json（保留手动条目，新增版本降序插入，default 移到最新） ----------
// synced：syncVersion 成功返回的对象数组（含 version / jsonRel）
function updateIndex(softwareId, origEntries, synced) {
  const manual = [];
  const versionEntries = []; // { key, entry }
  for (const e of origEntries) {
    const key = entryVersionKey(e.nextUrl);
    if (key != null) versionEntries.push({ key, entry: e });
    else manual.push(e);
  }
  for (const s of synced) {
    if (versionEntries.some((x) => x.key === s.version)) continue;
    versionEntries.push({
      key: s.version,
      entry: { name: s.version, nextUrl: '/' + s.jsonRel },
    });
  }
  versionEntries.sort((a, b) => compareVersionsDescending(a.key, b.key));
  const hadDefault = versionEntries.some((x) => x.entry.default === true);
  let entries = [...manual, ...versionEntries.map((x) => ({ ...x.entry }))];
  if (hadDefault && versionEntries.length) {
    // default 只保留在最新版本上
    const newest = versionEntries[0].key;
    entries = entries.map((e) => {
      const key = entryVersionKey(e.nextUrl);
      const { default: _d, ...rest } = e;
      return key === newest ? { ...rest, default: true } : rest;
    });
  }
  const indexPath = join(ROOT, 'data', 'down', String(softwareId), 'index.json');
  writeFileSync(indexPath, JSON.stringify(entries, null, 2));
  return indexPath;
}

// ---------- 提交前数据校验（JSON 可解析、直链前缀、size、index 一致性） ----------
function verifySyncedData(sw, synced) {
  const errors = [];
  const urlPrefix = ENV.HOST + '/f/';
  for (const s of synced) {
    const jsonRel = s.jsonRel;
    const nextUrl = '/' + jsonRel;
    let rows;
    try {
      rows = JSON.parse(readFileSync(join(ROOT, jsonRel), 'utf8'));
    } catch (e) {
      errors.push(`${jsonRel} 解析失败：${e.message}`);
      continue;
    }
    if (!Array.isArray(rows) || rows.length === 0) {
      errors.push(`${jsonRel} 不是非空数组`);
      continue;
    }
    rows.forEach((row, i) => {
      const key = sw.mode === 'name' ? row.name : row.arch;
      if (!key) errors.push(`${jsonRel}[${i}] 缺少 ${sw.mode === 'name' ? 'name' : 'arch'}`);
      if (typeof row.url !== 'string' || !row.url.startsWith(urlPrefix)) {
        errors.push(`${jsonRel}[${i}] url 不是 ${urlPrefix} 前缀`);
      }
      const size = Number(row.size);
      if (!Number.isFinite(size) || size < 0) errors.push(`${jsonRel}[${i}] size 缺失或非法`);
    });
  }
  let index = [];
  try {
    index = JSON.parse(readFileSync(join(ROOT, 'data', 'down', String(sw.softwareId), 'index.json'), 'utf8'));
  } catch (e) {
    errors.push(`data/down/${sw.softwareId}/index.json 解析失败：${e.message}`);
  }
  if (Array.isArray(index)) {
    for (const s of synced) {
      const nextUrl = '/' + s.jsonRel;
      if (!index.some((e) => String(e.nextUrl || '') === nextUrl)) errors.push(`index.json 缺少 ${nextUrl}`);
    }
  }
  if (errors.length) throw new Error('提交前数据校验失败：\n  - ' + errors.join('\n  - '));
  log(`    ✅ 提交前校验通过（${synced.length} 个版本 JSON、${urlPrefix} URL、size、index 一致性）`);
}

// ---------- 提交单个软件 ----------
function commitSoftware(softwareId, range, bodyLines) {
  // 先暂存 data/down/{id} 全部变更
  git(['add', '--', `data/down/${softwareId}`]);
  // 无变更则不提交
  try {
    gitQuiet(['diff', '--cached', '--quiet']);
    log('  （无文件变更，跳过提交）');
    return false;
  } catch {
    /* 有变更 */
  }
  const subject = `[GHA] 新增：内容：数据源：资源id-${softwareId}：${range}呜~`;
  const body = bodyLines.join('\n');
  git([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
    'commit', '-m', subject, '-m', body,
  ]);
  log(`  ✅ 已提交：${subject}`);
  return true;
}

// ---------- push ----------
function push() {
  const branch = currentBranch();
  if (ENV.GITHUB_TOKEN && ENV.GITHUB_REPOSITORY) {
    git(['remote', 'set-url', 'origin', `https://x-access-token:${ENV.GITHUB_TOKEN}@github.com/${ENV.GITHUB_REPOSITORY}.git`]);
  }
  const args = ['-C', ROOT, 'push', 'origin', `HEAD:${branch}`];
  execFileSync('git', args, { stdio: 'inherit' });
  log(`  ✅ 已推送 origin/${branch}`);
}

// ---------- 主流程 ----------
async function main() {
  log(`==== 线路1 自动同步开始（${SOFTWARES.length} 个软件） ====`);
  let overallFailed = false;
  let anyCommit = false;

  // ---- 阶段 1：全量预探测候选（不登录、不动网盘、不读凭据），全部无候选就直接退出 ----
  log('\n==== 阶段 1：预探测候选 ====');
  const pending = [];
  for (const sw of SOFTWARES) {
    log(`\n---- 预探测软件 id=${sw.softwareId}（${sw.githubRepo}） ----`);
    try {
      const { latest: dsLatest, entries: origEntries } = parseDataSourceIndex(sw.softwareId);
      log(`数据源最新版本：${dsLatest || '（无）'}`);
      if (dsLatest) log(`数据源版本数：${origEntries.filter((e) => entryVersionKey(e.nextUrl) != null).length}`);

      log(`拉取 GitHub Releases：${sw.githubRepo} …`);
      const releases = await fetchReleases(sw.githubRepo, !!sw.includePrerelease);
      log(`Release 总数（非 draft${sw.includePrerelease ? '' : '、非 prerelease'}）：${releases.length}`);
      if (!releases.length) { log('（无 Release，跳过）'); continue; }

      const versioned = releases
        .map((r) => ({ version: versionFromTag(r.tag_name), release: r }))
        .filter((x) => /^[vV]?[0-9]/.test(x.version))
        .filter((x, i, arr) => arr.findIndex((y) => y.version === x.version) === i);

      let candidates;
      if (!dsLatest) {
        candidates = versioned.slice(0, 1);
        log(`数据源无版本 → 只取最新 Release：${candidates[0]?.version || ''}`);
      } else {
        candidates = versioned.filter((x) => compareVersionsDescending(dsLatest, x.version) > 0);
        log(`落后 ${candidates.length} 个版本：${candidates.map((c) => c.version).join(', ') || '（无）'}`);
      }
      candidates.sort((a, b) => compareVersionsDescending(b.version, a.version));

      if (!candidates.length) { log('（已是最新，无需同步）'); continue; }
      log(`→ 需同步 ${candidates.length} 个版本`);
      pending.push({ sw, dsLatest, origEntries, candidates });
    } catch (e) {
      overallFailed = true;
      log(`❌ 软件 ${sw.softwareId} 预探测失败：${e.message}`);
    }
  }

  if (!pending.length) {
    log('\n==== 全部软件均已是最新，无需登录 huang1111，直接结束 ====');
    log(`==== 线路1 自动同步结束（${overallFailed ? '存在失败项' : '全部成功'}） ====`);
    console.log('\n--- 完整日志 ---');
    console.log(ctx.runLog.join('\n'));
    process.exit(overallFailed ? 1 : 0);
  }

  // ---- 阶段 2：校验凭据 + 一次性登录 + 同步有候选的软件 ----
  if (!ENV.USER || !ENV.PASSWORD) {
    console.error('缺少凭据：请设置环境变量 H1111_USER / H1111_PASSWORD');
    process.exit(2);
  }
  log(`\n==== 阶段 2：登录 huang1111，同步 ${pending.length} 个软件 ====`);
  log('登录 huang1111 …');
  await h1.login(ENV.USER, ENV.PASSWORD, (m) => log(m));

  for (const { sw, dsLatest, origEntries, candidates } of pending) {
    log(`\n########## 软件 id=${sw.softwareId}（${sw.githubRepo}） ##########`);
    const swLog = [];
    // 拦截 ctx.log：每个软件的日志同时写入 swLog（供 commit body 用）和全局 runLog
    const origLog = ctx.log.bind(ctx);
    ctx.log = function (msg) { swLog.push(msg); origLog(msg); };
    try {
      // 逐个版本同步
      const synced = [];
      for (const cand of candidates) {
        if (versionKnown(origEntries, cand.version)) {
          log(`  （版本 ${cand.version} 已在数据源，跳过）`);
          continue;
        }
        try {
          const result = await syncVersion(sw, cand.version, cand.release);
          if (result) synced.push(result);
        } catch (e) {
          overallFailed = true;
          log(`  ❌ 版本 ${cand.version} 同步失败（已按重试策略耗尽仍失败）：${e.message}`);
        }
      }
      if (!synced.length) { log('（本次无成功同步的版本）'); continue; }

      // 更新 index.json + 提交前校验
      const indexPath = updateIndex(sw.softwareId, origEntries, synced);
      log(`    ✅ 已更新 ${indexPath.replace(ROOT + '/', '')}（+${synced.length} 个版本）`);
      verifySyncedData(sw, synced);
      const newVersionsSorted = synced.map((s) => s.version).sort(compareVersionsDescending);
      const range = dsLatest ? `${dsLatest}-${newVersionsSorted[0]}` : String(newVersionsSorted[0]);
      log(`    提交范围：${range}`);
      try {
        if (commitSoftware(sw.softwareId, range, swLog)) anyCommit = true;
      } catch (e) {
        overallFailed = true;
        log(`  ❌ 提交失败：${e.message}`);
      }
    } catch (e) {
      overallFailed = true;
      log(`  ❌ 软件 ${sw.softwareId} 处理失败：${e.message}`);
    } finally {
      ctx.log = origLog; // 恢复全局 log
    }
  }

  // push（有提交才推）
  if (anyCommit) {
    log('\n==== 提交已完成，推送远程 ====');
    try {
      push();
    } catch (e) {
      overallFailed = true;
      log(`❌ push 失败：${e.message}`);
    }
  } else {
    log('\n==== 无提交，跳过 push ====');
  }
  log(`==== 线路1 自动同步结束（${overallFailed ? '存在失败项' : '全部成功'}） ====`);
  console.log('\n--- 完整日志 ---');
  console.log(ctx.runLog.join('\n'));
  process.exit(overallFailed ? 1 : 0);
}

// 直接执行本文件（node scripts/auto-sync/sync.mjs）才进入主流程；
// 被 import（如验证脚本）时仅暴露纯函数，便于白盒测试
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    console.error('脚本异常：' + (e.stack || e.message));
    process.exit(1);
  });
}

export { compareVersionsDescending, datePathFromRelease, entryVersionKey, versionFromTag };
