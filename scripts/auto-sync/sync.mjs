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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { ENV, RETRY } from './config.mjs';
import * as h1 from './h1api.mjs';

// ---------- 路径 ----------
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOFTWARES = JSON.parse(readFileSync(join(HERE, 'softwares.json'), 'utf8'));

// 与前端 js/adapters/download/common.js 一致的版本比较（提取连续数字，逐位比较）
const VERSION_NUMBER = /\d+/g;
function compareVersionsDescending(left, right) {
  const leftParts = String(left).match(VERSION_NUMBER)?.map(Number) || [];
  const rightParts = String(right).match(VERSION_NUMBER)?.map(Number) || [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

// ---------- 日志 ----------
let runLog = [];
function log(msg) {
  const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
  runLog.push(line);
  console.log(line);
}

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

// ---------- GitHub Releases ----------
async function fetchReleases(githubRepo, includePrerelease) {
  const url = `https://api.github.com/repos/${githubRepo}/releases?per_page=100`;
  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY.GENERIC_ATTEMPTS; attempt += 1) {
    try {
      const headers = {
        Accept: 'application/vnd.github+json',
        'User-Agent': 'FCL.downsite.NEW-auto-sync',
        ...(ENV.GITHUB_TOKEN ? { Authorization: `Bearer ${ENV.GITHUB_TOKEN}` } : {}),
      };
      const res = await fetch(url, { headers });
      if (!res.ok) throw new Error(`GitHub API HTTP ${res.status}`);
      const list = await res.json();
      return list.filter(
        (r) => !r.draft && (includePrerelease || !r.prerelease) && /[0-9]/.test(r.tag_name || ''),
      );
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY.GENERIC_ATTEMPTS) log(`  [GitHub] 拉取失败（第${attempt}次）：${e.message}，重试…`);
    }
  }
  throw new Error(`GitHub 拉取失败：${lastErr?.message || '未知'}`);
}

// 版本名归一化（不再拆分路径，仅用作 auto 日期目录下的 JSON 文件名）：
//   保留前导 v/V 原样；空白与非法文件名字符（\/:*?"<>|）归一为 _；
//   连续点塌缩为一点；去掉首尾点（避免隐藏文件/以点结尾），保证文件名安全
function versionFromTag(tag) {
  return String(tag || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');
}
// Release 发布时间 → 日期目录（UTC+8 的年/月/日，不补零，如 2026/8/26）
function datePathFromRelease(release) {
  const shifted = new Date(new Date(release.published_at).getTime() + 8 * 3600 * 1000);
  return `${shifted.getUTCFullYear()}/${shifted.getUTCMonth() + 1}/${shifted.getUTCDate()}`;
}

// index.json 条目 nextUrl 的版本识别：
//   新格式（日期归档）：/data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json
//   旧格式（版本逐位拆分，仅兼容保留）：/data/down/{id}/{段...}.json
const AUTO_DIR_RE = /^\/data\/down\/\d+\/auto\/\d+\/\d+\/\d+\/([^/]+)\.json$/;
// 旧格式：整个版本路径为 [0-9A-Za-z_/] 段，长度 ≥2 判定与旧逻辑 segs.length>=2 一致
const OLD_DIR_RE = /^\/data\/down\/\d+\/([0-9A-Za-z_/]+)\.json$/;
// 从 nextUrl 反解版本名（新格式优先、旧格式兜底）；非版本条目返回 null
function entryVersionKey(nextUrl) {
  const next = String(nextUrl || '');
  const m = AUTO_DIR_RE.exec(next);
  if (m) return m[1];
  const o = OLD_DIR_RE.exec(next);
  if (o) {
    // auto 是保留命名空间：旧格式首段不可能以 auto 开头（版本名以 v/V/数字开头），
    // 排除以防 auto 目录下不完整的手工路径被误判成巨大假版本
    const segs = o[1].split('/');
    if (segs[0] !== 'auto' && segs.length >= 2 && segs.every((s) => /^[0-9A-Za-z_]+$/.test(s))) return segs.join('.');
  }
  return null;
}

// ---------- 从 index.json 解析数据源版本 ----------
// 返回 { latest, entries }：latest 为数据源最新版本名（无则 null）
function parseDataSourceIndex(softwareId) {
  const indexPath = join(ROOT, 'data', 'down', String(softwareId), 'index.json');
  if (!existsSync(indexPath)) return { latest: null, entries: [] };
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    throw new Error(`解析 ${indexPath} 失败：${e.message}`);
  }
  if (!Array.isArray(entries)) entries = [];
  // 版本条目：新格式 auto 日期目录 / 旧格式逐位拆分，均可反解出版本名
  const versions = [];
  for (const e of entries) {
    const key = entryVersionKey(e.nextUrl);
    if (key != null) versions.push(key);
  }
  if (!versions.length) return { latest: null, entries };
  versions.sort(compareVersionsDescending);
  return { latest: versions[0], entries };
}

// ---------- 判定某版本是否已在数据源内 ----------
function versionKnown(entries, version) {
  return entries.some((e) => entryVersionKey(e.nextUrl) === version);
}

// ---------- 资产 → 版本文件条目 ----------
// mode=arch：按 archNames 顺序输出 [{arch,url,size}]；asset 名以 -{arch}.apk 结尾识别
//            fallbackArch 兜底：无法按后缀识别的 .apk 归入该 arch（如 Zalith2 的 all 包无后缀）
// mode=name：按资产名排序输出 [{name,url,size}]（如 Amethyst / Amethyst-Debug）
function mapAssetsToEntries(mode, archNames, fallbackArch, assets) {
  if (mode === 'name') {
    const out = [];
    for (const a of assets) {
      const name = String(a.name).replace(/\.apk$/i, '');
      out.push({ name, url: a.browser_download_url, _file: a.name });
    }
    out.sort((x, y) => x.name.localeCompare(y.name));
    return out;
  }
  // arch 模式
  const byArch = new Map();
  for (const arch of archNames) byArch.set(arch, null);
  const leftover = [];
  const apkRe = /\.apk$/i;
  for (const a of assets) {
    const name = String(a.name);
    if (!apkRe.test(name)) continue;
    let hit = null;
    for (const arch of archNames) {
      if (name.endsWith(`-${arch}.apk`)) { hit = arch; break; }
    }
    if (hit) {
      if (!byArch.get(hit)) byArch.set(hit, a);
    } else {
      leftover.push(a);
    }
  }
  // fallback：无后缀命中的 apk 归入 fallbackArch（前提是该 arch 尚无资产）
  if (fallbackArch && !byArch.get(fallbackArch) && leftover.length) {
    byArch.set(fallbackArch, leftover[0]);
  }
  const out = [];
  for (const arch of archNames) {
    const a = byArch.get(arch);
    if (a) out.push({ arch, url: a.browser_download_url, _file: a.name });
  }
  return out;
}

// ---------- 单个版本同步：下载（如缺）→ 取直链 → 写 JSON ----------
// 返回 { version, files:[{arch|name,url,size}], jsonRel } 或 null（失败后仍抛错由上层判定）
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
  if (!ENV.USER || !ENV.PASSWORD) {
    console.error('缺少凭据：请设置环境变量 H1111_USER / H1111_PASSWORD');
    process.exit(2);
  }
  log(`==== 线路1 自动同步开始（${SOFTWARES.length} 个软件） ====`);
  let overallFailed = false;
  let anyCommit = false;

  for (const sw of SOFTWARES) {
    log(`\n########## 软件 id=${sw.softwareId}（${sw.githubRepo}） ##########`);
    const swLog = [];
    const swLogOrigin = log;
    log = (msg) => { swLog.push(msg); swLogOrigin(msg); };
    try {
      // 1) 数据源基线
      const { latest: dsLatest, entries: origEntries } = parseDataSourceIndex(sw.softwareId);
      log(`数据源最新版本：${dsLatest || '（无）'}`);
      if (dsLatest) log(`数据源版本数：${origEntries.filter((e) => entryVersionKey(e.nextUrl) != null).length}`);

      // 2) GitHub Releases
      log(`拉取 GitHub Releases：${sw.githubRepo} …`);
      const releases = await fetchReleases(sw.githubRepo, !!sw.includePrerelease);
      log(`Release 总数（非 draft${sw.includePrerelease ? '' : '、非 prerelease'}）：${releases.length}`);
      if (!releases.length) { log('（无 Release，跳过）'); continue; }

      // 版本名列表（去重）
      const versioned = releases
        .map((r) => ({ version: versionFromTag(r.tag_name), release: r }))
        .filter((x) => /^[vV]?[0-9]/.test(x.version))
        .filter((x, i, arr) => arr.findIndex((y) => y.version === x.version) === i);

      // 3) 候选：数据源无版本 → 只取最新；否则落后多少取多少
      let candidates;
      if (!dsLatest) {
        candidates = versioned.slice(0, 1);
        log(`数据源无版本 → 只取最新 Release：${candidates[0]?.version || ''}`);
      } else {
        candidates = versioned.filter((x) => compareVersionsDescending(dsLatest, x.version) > 0);
        log(`落后 ${candidates.length} 个版本：${candidates.map((c) => c.version).join(', ') || '（无）'}`);
      }
      candidates.sort((a, b) => compareVersionsDescending(b.version, a.version)); // 旧的先处理

      if (!candidates.length) { log('（已是最新，无需同步）'); continue; }

      // 4) 登录（每软件一次；失败会抛出 → 整体失败）
      log('登录 huang1111 …');
      await h1.login(ENV.USER, ENV.PASSWORD, (m) => log(m));

      // 5) 逐个版本同步
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

      // 6) 更新 index.json + 提交前校验
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
      log = swLogOrigin;
    }
  }

  // 7) push（有提交才推）
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
  console.log(runLog.join('\n'));
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