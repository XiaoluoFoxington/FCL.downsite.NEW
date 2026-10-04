// sync.mjs — 线路1 自动同步主流程（GitHub Releases → huang1111 离线下载 → 直链 → 写 JSON → 分软件提交 → push）
// 运行：node scripts/auto-sync/sync.mjs   （需要环境变量 H1111_USER / H1111_PASSWORD）
//
// 检测逻辑（用户确认）：
//   1. 取数据源内最新版本（data/down/{id}/index.json 中可解析的版本条目）
//   2. 若数据源没有版本 → 只取 Release 最新一个
//   3. 否则 → 落后 Release 多少版本，就把落后的全部下载
//
// 离线下载成功判据（用户确认）：
//   只看网盘目录（listDir）里是否出现全部期望文件、且每个文件 size 与 GitHub asset 精确相等。
//   不依赖 /aria2/finished 的 status，也不依赖 POST /aria2/url 返回的 code。
//
// 重试策略（用户确认，见 config.mjs RETRY）：
//   验证类失败（登录/取直链）→ 完整验证链路（41700 → PoW → policy → permit）最多 3 次
//   离线下载失败              → 提交+轮询最多 3 次
//   其他任何失败（网络/HTTP） → 最多 2 次尝试
//   站点验证协议细节见 h1api.mjs 文件头与 docs/huang1111-api-notes.md §0.3 / §0.7
//
// 提交格式（用户确认）：`[GHA] 新增：内容：数据源：资源id-{id}：{版本列表&分隔}呜~\n\n{日志}`
// 每个软件一个 commit；全部完成后统一 push。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENV } from './config.mjs';
import * as h1 from './h1api.mjs';
import { log } from './log.mjs';
import {
  ROOT, SOFTWARES,
  compareVersionsDescending, versionFromTag, datePathFromRelease,
  entryVersionKey, entrySortKey, isPinnedEntry, normalizeVersionText, versionKnown,
  parseDataSourceIndex, fetchReleases, mapAssetsToEntries,
} from './lib.mjs';

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
// 离线下载成功与否只由 h1.offlineDownload 内部按目录文件列表判定（文件名 + size 精确匹配）
async function syncVersion(sw, version, release) {
  log.info(`版本 ${version}`);
  // 1) 筛选资产（assetFilter 正则）
  const filterRe = sw.assetFilter ? new RegExp(sw.assetFilter) : null;
  const assets = (release.assets || []).filter((a) => !filterRe || filterRe.test(a.name || ''));
  const entries = mapAssetsToEntries(sw.mode, sw.archNames, sw.fallbackArch, assets);
  if (!entries.length) {
    log.detail(`无可用资产（共 ${assets.length} 个），跳过该版本`);
    return null;
  }
  // 网盘路径（根目录 foldcraftlauncher_cn_auto 即"auto"语义；层级与数据源一致：
  // {id}/{年}/{月}/{日}/{版本号}，版本号目录下才是文件，避免同一天多个版本互相覆盖）
  const datePath = datePathFromRelease(release);
  const netPath = `foldcraftlauncher_cn_auto/${sw.softwareId}/${datePath}/${version}`;
  // 期望文件：文件名 + GitHub asset 的精确字节数；成败只看目录里是否出现同名且 size 相等的文件
  const wantFiles = entries.map((e) => ({ name: e._file, size: e.size }));

  // 2) 幂等：网盘目录已存在全部期望文件（且 size 匹配）→ 跳过离线下载
  let dir = await h1.listDir(netPath);
  const hadAllFiles =
    dir.exists &&
    wantFiles.every((w) =>
      dir.objects.some((o) => o.type === 'file' && o.name === w.name && Number(o.size) === Number(w.size)),
    );
  if (!hadAllFiles) {
    await h1.offlineDownload(entries.map((e) => e.url), netPath, wantFiles);
    dir = await h1.listDir(netPath);
  } else {
    log.detail('网盘目录已全部存在且 size 匹配，跳过离线下载');
  }
  if (!dir.exists) throw new Error(`下载完成后目录仍不存在：/${netPath}`);

  // 3) 文件 id + size 映射
  const fileMeta = new Map(dir.objects.filter((o) => o.type === 'file').map((o) => [o.name, o]));
  const missing = wantFiles
    .filter((w) => {
      const o = fileMeta.get(w.name);
      return !o || Number(o.size) !== Number(w.size);
    })
    .map((w) => w.name);
  if (missing.length) throw new Error(`目录中缺少或 size 不匹配的文件：${missing.join(', ')}`);

  // 4) 批量取直链（captcha policy v2 验证链路在 h1api 内：41700 → PoW → policy → permit）
  //    响应含 url 与 short_url（2026-09-26 站长确认二者等价：short_url 只是少了末尾文件名段）。
  //    站端 JS 用完整 url，这里保持一致只取 url；两者都满足下方 /f/ 前缀校验。
  const ids = wantFiles.map((w) => fileMeta.get(w.name).id);
  const sources = await h1.getSources(ids);
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
  log.ok(`版本 ${version} 已写 ${jsonRel}（${sized.length} 个文件，共 ${sized.reduce((s, e) => s + (e.size || 0), 0)} 字节）`);
  log.detail(sized.map((e) => e.arch || e.name).join(', '));
  return { version, files: sized, jsonRel, title: release.name ?? null };
}

// ---------- 更新 index.json ----------
// 排序规则（2026-10-02 修订，见 lib.mjs 的 entrySortKey 注释）：
//   · 置顶桶（pinned: true，或版本号完全无法识别的历史遗留条目）原样保留、永远排在版本条目之前
//   · 其余条目（含 { name, children } 内联形态的手写版本条目、旧格式路径条目、自动同步条目）
//     一律按版本号降序统一排序——手写条目不再因为"没有 nextUrl"而被压到前面
function updateIndex(softwareId, origEntries, synced) {
  const pinned = [];
  const versionEntries = []; // { key, entry }
  for (const e of origEntries) {
    if (isPinnedEntry(e)) {
      pinned.push(e);
      continue;
    }
    const key = entrySortKey(e);
    versionEntries.push({ key, entry: e });
  }
  for (const s of synced) {
    if (versionEntries.some((x) => (normalizeVersionText(x.key) ?? x.key) === (normalizeVersionText(s.version) ?? s.version))) continue;
    // name=发布标题（release.name），tag=版本号；key 仍是版本号，用于排序/去重
    versionEntries.push({
      key: s.version,
      entry: { name: s.title || s.version, nextUrl: '/' + s.jsonRel, tag: s.version },
    });
  }
  versionEntries.sort((a, b) => compareVersionsDescending(a.key, b.key));
  // default 只保留在最新的版本条目上（置顶条目一律不带 default）
  versionEntries.forEach((x, i) => {
    const { default: _d, ...rest } = x.entry;
    x.entry = i === 0 ? { ...rest, default: true } : rest;
  });
  const entries = [...pinned, ...versionEntries.map((x) => ({ ...x.entry }))];
  const indexPath = join(ROOT, 'data', 'down', String(softwareId), 'index.json');
  writeFileSync(indexPath, JSON.stringify(entries, null, 2));
  return indexPath;
}

// ---------- 从 index.json 条目 nextUrl 解析网盘相对路径段（年/月/日/版本） ----------
// 仅匹配新格式 auto 条目；旧格式/手动条目返回 null
const AUTO_PATH_RE = /^\/data\/down\/\d+\/auto\/(\d+\/\d+\/\d+\/[^/]+)\.json$/;
function autoPathFromEntry(nextUrl) {
  const m = AUTO_PATH_RE.exec(String(nextUrl || ''));
  return m ? m[1] : null;
}

// ---------- keepLatest 保留清理（网盘目录 + index.json 条目 + 本地 JSON 联动） ----------
// 读取当前 index.json 的全部版本条目，按版本号降序保留最新 keep 个，最旧的超出部分：
//   ① 删除网盘对应版本目录（foldcraftlauncher_cn_auto/{id}/{年}/{月}/{日}/{版本}）
//   ② 删除本地 data/down/{id}/auto/.../{版本}.json
//   ③ 从 index.json 移除该条目并写回
// 返回被清理的版本数组；keepLatest <= 0 或无可清理时返回 []
async function pruneSoftware(sw) {
  const keep = Number(sw.keepLatest) || 0;
  if (keep <= 0) return [];
  const indexPath = join(ROOT, 'data', 'down', String(sw.softwareId), 'index.json');
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    return [];
  }
  if (!Array.isArray(entries)) return [];

  // 置顶条目永不参与清理；其余条目按版本号降序参与 keep 保留
  const vers = entries
    .map((entry, idx) => ({ idx, key: isPinnedEntry(entry) ? null : entrySortKey(entry), entry }))
    .filter((x) => x.key != null);
  if (vers.length <= keep) return [];
  vers.sort((a, b) => compareVersionsDescending(a.key, b.key));

  const toDelete = vers.slice(keep); // 最旧的超出部分
  const keepSet = new Set(vers.slice(0, keep).map((v) => v.key));
  log.detail(`[清理] keepLatest=${keep}，现有 ${vers.length} 个版本，清理 ${toDelete.length} 个最旧：${toDelete.map((t) => t.key).join(', ')}`);

  const pruned = [];
  for (const { key, entry } of toDelete) {
    try {
      const netRel = autoPathFromEntry(entry.nextUrl);
      if (netRel) {
        await h1.deleteDir(`foldcraftlauncher_cn_auto/${sw.softwareId}/${netRel}`);
      }
      // 只删有真实本地路径的条目：手写 children 条目无 nextUrl，绝不能拼出 "undefined" 去删
      if (typeof entry.nextUrl === 'string' && entry.nextUrl) {
        const jsonRel = entry.nextUrl.replace(/^\//, '');
        const localPath = join(ROOT, jsonRel);
        if (existsSync(localPath)) unlinkSync(localPath);
      }
      pruned.push(key);
    } catch (e) {
      log.warn(`[清理] 版本 ${key} 清理失败：${e.message}`);
    }
  }
  if (pruned.length) {
    const prunedSet = new Set(pruned);
    const next = entries.filter((entry) => {
      if (isPinnedEntry(entry)) return true; // 置顶条目原样保留
      const key = entrySortKey(entry);
      if (key == null) return true;
      return keepSet.has(key) || !prunedSet.has(key);
    });
    writeFileSync(indexPath, JSON.stringify(next, null, 2));
  }
  return pruned;
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
}

// ---------- 提交单个软件 ----------
function commitSoftware(softwareId, versionList, bodyLines) {
  // 先暂存 data/down/{id} 全部变更
  git(['add', '--', `data/down/${softwareId}`]);
  // 无变更则不提交
  try {
    gitQuiet(['diff', '--cached', '--quiet']);
    return false;
  } catch {
    /* 有变更 */
  }
  const subject = `[GHA] 新增：内容：数据源：资源id-${softwareId}：${versionList}呜~`;
  const body = bodyLines.join('\n');
  git([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
    'commit', '-m', subject, '-m', body,
  ]);
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
}

// ---------- 主流程 ----------
async function main() {
  let overallFailed = false;
  let anyCommit = false;

  log.section(`线路1 自动同步（${SOFTWARES.length} 个软件）`);
  log.summary('## 线路1 自动同步');
  log.summary('');
  log.summary('| 软件 | 仓库 | 版本 | 结果 |');
  log.summary('|---|---|---|---|');

  // 概览结果：按 SOFTWARES 顺序登记每个软件的状态，最后统一渲染
  const results = [];
  const resultBySw = new Map();
  const addResult = (sw, versions, status) => {
    const r = { sw, versions, status };
    results.push(r);
    resultBySw.set(sw.softwareId, r);
    return r;
  };
  const renderSummary = () => {
    for (const r of results) {
      const versions = r.versions.length ? r.versions.join('<br>') : '—';
      const status = String(r.status).replace(/\|/g, '\\|');
      log.summary(`| ${r.sw.softwareId} | ${r.sw.githubRepo} | ${versions} | ${status} |`);
    }
    log.summary('');
    log.summary(`- 结果：${overallFailed ? '存在失败项' : '全部成功'}`);
  };

  // ---- 阶段 1：全量预探测候选（不登录、不动网盘、不读凭据），全部无候选就直接退出 ----
  log.section('阶段 1：预探测候选');
  const pending = [];
  for (const sw of SOFTWARES) {
    log.group(`预探测 id=${sw.softwareId}（${sw.githubRepo}）`);
    try {
      const { latest: dsLatest, entries: origEntries } = parseDataSourceIndex(sw.softwareId);
      const releases = await fetchReleases(sw.githubRepo, !!sw.includePrerelease);
      log.info(`数据源最新 ${dsLatest || '（无）'}｜Releases ${releases.length} 条`);
      if (!releases.length) {
        log.info('无 Release，跳过');
        addResult(sw, [], '无 Release');
        continue;
      }

      const versioned = releases
        .map((r) => ({ version: versionFromTag(r.tag_name), release: r }))
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
        log.info('已是最新');
        addResult(sw, [], '已是最新');
        continue;
      }
      const versions = candidates.map((c) => c.version);
      log.ok(`需同步 ${candidates.length} 个：${versions.join(', ')}`);
      pending.push({ sw, dsLatest, origEntries, candidates });
      addResult(sw, versions, '待同步');
    } catch (e) {
      overallFailed = true;
      log.fail(`预探测失败：${e.message}`);
      addResult(sw, [], `❌ ${e.message}`);
    } finally {
      log.end();
    }
  }

  if (!pending.length) {
    renderSummary();
    log.info(`结束：${overallFailed ? '存在失败项' : '全部最新，无需登录'}`);
    log.flush();
    process.exit(overallFailed ? 1 : 0);
  }

  // ---- 阶段 2：校验凭据 + 一次性登录 + 同步有候选的软件 ----
  if (!ENV.USER || !ENV.PASSWORD) {
    overallFailed = true;
    log.fail('缺少凭据：请设置环境变量 H1111_USER / H1111_PASSWORD');
    renderSummary();
    log.flush();
    process.exit(2);
  }
  log.section(`阶段 2：登录并同步 ${pending.length} 个软件`);
  try {
    await h1.login(ENV.USER, ENV.PASSWORD);
  } catch (e) {
    overallFailed = true;
    log.fail(`登录失败：${e.message}`);
    renderSummary();
    log.flush();
    process.exit(1);
  }

  for (const { sw, origEntries, candidates } of pending) {
    const result = resultBySw.get(sw.softwareId);
    const synced = [];
    let prepared = false; // updateIndex/校验/清理全部成功后才允许提交（与原实现一致：中途失败不提交）
    // 捕获该软件同步期间的详细日志，作为 commit body
    const body = await log.capture(async () => {
      log.group(`软件 id=${sw.softwareId}（${sw.githubRepo}）`);
      try {
        for (const cand of candidates) {
          if (versionKnown(origEntries, cand.version)) {
            log.detail(`版本 ${cand.version} 已在数据源，跳过`);
            continue;
          }
          try {
            const r = await syncVersion(sw, cand.version, cand.release);
            if (r) synced.push(r);
          } catch (e) {
            overallFailed = true;
            log.fail(`版本 ${cand.version} 同步失败：${e.message}`);
          }
        }
        if (!synced.length) {
          log.info('本次无成功同步的版本');
          if (result) result.status = '无成功同步';
          return;
        }
        // 更新 index.json + 提交前校验 + keepLatest 保留清理
        updateIndex(sw.softwareId, origEntries, synced);
        log.detail(`已更新 index.json（+${synced.length} 个版本）`);
        verifySyncedData(sw, synced);
        log.detail('提交前校验通过');
        const pruned = await pruneSoftware(sw);
        if (pruned.length) log.detail(`[清理] 已从 index.json 移除 ${pruned.length} 个条目`);
        prepared = true;
      } catch (e) {
        overallFailed = true;
        log.fail(`软件处理失败：${e.message}`);
        if (result) result.status = `❌ ${e.message}`;
      } finally {
        log.end();
      }
    });

    if (!prepared) continue;

    const versionList = synced.map((s) => s.version).sort(compareVersionsDescending).join('&');
    try {
      if (commitSoftware(sw.softwareId, versionList, body)) {
        anyCommit = true;
        if (result) result.status = '✅ 已同步';
        log.ok(`资源id-${sw.softwareId} 已提交：${versionList}`);
      } else {
        if (result) result.status = '已同步（无变更）';
        log.info(`资源id-${sw.softwareId} 无文件变更，跳过提交`);
      }
    } catch (e) {
      overallFailed = true;
      log.fail(`提交失败：${e.message}`);
      if (result) result.status = '❌ 提交失败';
    }
  }

  // push（有提交才推）
  if (anyCommit) {
    log.section('推送远程');
    try {
      const branch = currentBranch();
      push();
      log.ok(`已推送 origin/${branch}`);
    } catch (e) {
      overallFailed = true;
      log.fail(`push 失败：${e.message}`);
    }
  } else {
    log.info('无提交，跳过 push');
  }

  renderSummary();
  log.info(`结束：${overallFailed ? '存在失败项' : '全部成功'}`);
  log.flush();
  process.exit(overallFailed ? 1 : 0);
}

// 直接执行本文件（node scripts/auto-sync/sync.mjs）才进入主流程；
// 被 import（如验证脚本）时仅暴露纯函数，便于白盒测试
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    log.fail(`脚本异常：${e.message}`);
    log.flush();
    process.exit(1);
  });
}

export { compareVersionsDescending, datePathFromRelease, entryVersionKey, entrySortKey, isPinnedEntry, normalizeVersionText, versionFromTag };

// 供本地交互式手动同步工具（.tmp/manual-sync.mjs）复用：
// 「下载 → 直链 → 写 JSON → 更新 index → 清理 → 提交 → push」全链路与 GHA 共用同一份实现，避免逻辑漂移
export { syncVersion, updateIndex, verifySyncedData, pruneSoftware, commitSoftware, push };