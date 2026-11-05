// sync.mjs — 线路1 自动同步主流程（GitHub Releases → huang1111 离线下载 → 直链 → 写 JSON → 分软件提交 → push）
// 运行：node scripts/auto-sync/sync.mjs
//   ⚠ 需要环境变量 **H1111_SESSION**（会话 cookie 值）—— 站点自 2026-10-07 起对**登录**
//     启用交互式验证（人眼点选/输入/拖滑块），账号密码登录**已无法自动化**。
//     故 H1111_USER / H1111_PASSWORD 降级为回退（仅在未提供 H1111_SESSION 时尝试，预计失败）。
//     会话取法与有效期说明见 scripts/auto-sync/README.md「会话 cookie」一节。
//
// 检测逻辑（用户确认，与 probe.mjs 共用 plan.mjs 的同一份实现）：
//   1. 取数据源内最新版本（data/down/{id}/index.json 中可解析的版本条目）
//   2. 若数据源没有版本 → 只取 Release 最新一个
//   3. 否则 → 落后 Release 多少版本，就把落后的全部下载
//
// 离线下载成功判据（用户确认）：
//   只看网盘目录（listDir）里是否出现全部期望文件、且每个文件 size 与 GitHub asset 精确相等。
//   不依赖 /aria2/finished 的 status，也不依赖 POST /aria2/url 返回的 code。
//
// 重试策略（用户确认，见 config.mjs RETRY）：
//   登录                        → 不复用重试链路：直接用会话 cookie 认证（见 loginWithSession）
//   验证类失败（取直链）        → 完整验证链路（41700 → PoW → policy → permit）最多 3 次
//   离线下载失败                → 提交+轮询最多 3 次
//   其他任何失败（网络/HTTP）   → 最多 2 次尝试
//   站点验证协议细节见 h1api.mjs 文件头与 docs/huang1111-api-notes.md §0.3 / §0.7 / §0.8
//
// 日志（2026-10 全量重构，见 logger.mjs 文件头）：
//   · 缩进由作用域树自动推导，调用方不手写空格
//   · 无时间戳前缀（GitHub Actions 自带）、无 ::group:: 折叠、末尾不重打整份日志
//   · 提交正文 = 「资源 id=…」作用域整棵树的正文，自动收集，无需猴补丁拦截全局 log
//
// 提交格式（用户确认）：`[GHA] 新增：内容：数据源：资源id-{id}：{版本列表&分隔}呜~` + 正文
// 每个软件一个 commit；全部完成后统一 push。

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { pathToFileURL } from 'node:url';

import { ENV } from './config.mjs';
import * as h1 from './h1api.mjs';
import { H1Error } from './h1api.mjs';
import { sessionInfo, maskSession, fmtUnixCST, fmtRemaining } from './session.mjs';
import {
  ROOT, SOFTWARES,
  compareVersionsDescending, datePathFromRelease,
  entrySortKey, isPinnedEntry, normalizeVersionText, versionKnown,
  mapAssetsToEntries,
} from './lib.mjs';
import { Logger, renderSoftwareTable, newRow, errText, fmtBytes, fmtCST, fmtDur } from './logger.mjs';
import { planAll } from './plan.mjs';

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
// 返回 { version, files:[{arch|name,url,size}], jsonRel, title } 或 null（无可用资产）
// 离线下载成功与否只由 h1.offlineDownload 内部按目录文件列表判定（文件名 + size 精确匹配）
async function syncVersion(sw, version, release, scope) {
  const row = scope;

  // 0) Release 元信息
  row.line(`Release 标题：${release.name || '（无标题）'}`);
  row.line(`tag：${release.tag_name}｜发布时间：${fmtCST(release.published_at)}（UTC+8）`);
  if (release.prerelease) row.line('⚠ 这是 prerelease');

  // 1) 筛选资产（assetFilter 正则）
  const filterRe = sw.assetFilter ? new RegExp(sw.assetFilter) : null;
  const allAssets = release.assets || [];
  const assets = allAssets.filter((a) => !filterRe || filterRe.test(a.name || ''));
  row.line(`资产过滤：${sw.assetFilter ? `/${sw.assetFilter}/` : '（不过滤）'}｜原始 ${allAssets.length} 个 → 匹配 ${assets.length} 个`);

  const entries = mapAssetsToEntries(sw.mode, sw.archNames, sw.fallbackArch, assets);
  if (!entries.length) {
    scope.close('⏭️ 无可用资产，跳过该版本', { kind: 'warn', body: true });
    return null;
  }

  const totalBytes = entries.reduce((s, e) => s + (Number(e.size) || 0), 0);
  row.line(`按 ${sw.mode} 模式解析出 ${entries.length} 个文件（合计 ${fmtBytes(totalBytes)}）：`);
  row.items(entries.map((e) => `${e._file} → ${e.arch || e.name}（${fmtBytes(e.size)}）`));

  // 网盘路径（层级与数据源一致：{id}/{年}/{月}/{日}/{版本号}，
  // 版本号目录下才是文件，避免同一天多个版本互相覆盖）
  const datePath = datePathFromRelease(release);
  const netPath = `foldcraftlauncher_cn_auto/${sw.softwareId}/${datePath}/${version}`;
  row.line(`网盘目标目录：/${netPath}`);

  // 期望文件：文件名 + GitHub asset 的精确字节数；成败只看目录里是否同名且 size 相等
  const wantFiles = entries.map((e) => ({ name: e._file, size: e.size }));

  // 2) 幂等：网盘目录已存在全部期望文件（且 size 匹配）→ 跳过离线下载
  let dir = await h1.listDir(netPath, scope);
  const hadAllFiles = dir.exists && wantFiles.every((w) =>
    dir.objects.some((o) => o.type === 'file' && o.name === w.name && Number(o.size) === Number(w.size)));
  if (hadAllFiles) {
    row.line(`[幂等] 网盘目录已存在全部 ${wantFiles.length} 个文件且 size 匹配，跳过离线下载`);
  } else {
    const dl = row.child('离线下载', { symbol: '▸' });
    dl.line(dir.exists
      ? `网盘目录已存在但文件不全（当前 ${dir.objects.filter((o) => o.type === 'file').length} 个文件），继续下载`
      : '网盘目录不存在，开始下载');
    const dlT0 = Date.now();
    try {
      await h1.offlineDownload(entries.map((e) => e.url), netPath, wantFiles, dl);
      dl.close(`✅ 下载完成｜用时 ${fmtDur(Date.now() - dlT0)}`);
    } catch (e) {
      dl.close(`❌ 下载失败：${errText(e)}｜用时 ${fmtDur(Date.now() - dlT0)}`, { kind: 'fail' });
      throw e;
    }
    dir = await h1.listDir(netPath, scope);
  }
  if (!dir.exists) throw new Error(`下载完成后目录仍不存在：/${netPath}`);

  // 3) 文件 id + size 映射
  const fileMeta = new Map(dir.objects.filter((o) => o.type === 'file').map((o) => [o.name, o]));
  const missing = wantFiles.filter((w) => {
    const o = fileMeta.get(w.name);
    return !o || Number(o.size) !== Number(w.size);
  }).map((w) => w.name);
  if (missing.length) throw new Error(`目录中缺少或 size 不匹配的文件：${missing.join('、')}`);
  row.line(`✅ 目录校验通过：${wantFiles.length} 个文件全部就绪且 size 精确匹配`);

  // 4) 批量取直链（captcha policy v2 验证链路在 h1api 内：41700 → PoW → policy → permit）
  //    响应含 url 与 short_url（2026-09-26 站长确认二者等价：short_url 只是少了末尾文件名段）。
  //    站端 JS 用完整 url，这里保持一致只取 url；两者都满足下方 /f/ 前缀校验。
  const ids = wantFiles.map((w) => fileMeta.get(w.name).id);
  const link = row.child('取直链', { symbol: '▸' });
  const linkT0 = Date.now();
  let sources;
  try {
    sources = await h1.getSources(ids, link);
    link.close(`✅ 取到 ${sources.length} 条直链｜用时 ${fmtDur(Date.now() - linkT0)}`);
  } catch (e) {
    link.close(`❌ 取直链失败：${errText(e)}｜用时 ${fmtDur(Date.now() - linkT0)}`, { kind: 'fail' });
    throw e;
  }
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
  row.line(`✅ 已写 ${jsonRel}（${sized.length} 个文件，共 ${fmtBytes(sized.reduce((s, e) => s + (e.size || 0), 0))}）`);
  row.line('直链：');
  row.items(sized.map((e) => `${e.arch || e.name}：${e.url}（${fmtBytes(e.size)}）`));

  scope.close(`✅ 版本同步完成：${version}`);
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
    versionEntries.push({ key: entrySortKey(e), entry: e });
  }
  let added = 0;
  for (const s of synced) {
    if (versionEntries.some((x) => (normalizeVersionText(x.key) ?? x.key) === (normalizeVersionText(s.version) ?? s.version))) continue;
    // name=发布标题（release.name），tag=版本号；key 仍是版本号，用于排序/去重
    versionEntries.push({
      key: s.version,
      entry: { name: s.title || s.version, nextUrl: '/' + s.jsonRel, tag: s.version },
    });
    added += 1;
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
  return { indexPath, added, total: entries.length, pinned: pinned.length, versions: versionEntries.length };
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
async function pruneSoftware(sw, scope) {
  const keep = Number(sw.keepLatest) || 0;
  if (keep <= 0) return [];
  const indexPath = join(ROOT, 'data', 'down', String(sw.softwareId), 'index.json');
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    scope.warn(`读取 index.json 失败，跳过保留清理：${errText(e)}`);
    return [];
  }
  if (!Array.isArray(entries)) return [];

  // 置顶条目永不参与清理；其余条目按版本号降序参与 keep 保留
  const vers = entries
    .map((entry, idx) => ({ idx, key: isPinnedEntry(entry) ? null : entrySortKey(entry), entry }))
    .filter((x) => x.key != null);
  if (vers.length <= keep) {
    scope.line(`keepLatest=${keep}，现有版本 ${vers.length} 个，无需清理`);
    return [];
  }
  vers.sort((a, b) => compareVersionsDescending(a.key, b.key));

  const toDelete = vers.slice(keep); // 最旧的超出部分
  const keepSet = new Set(vers.slice(0, keep).map((v) => v.key));
  scope.line(`keepLatest=${keep}，现有版本 ${vers.length} 个 → 清理 ${toDelete.length} 个最旧版本`);
  scope.line(`待清理：${toDelete.map((t) => t.key).join('、')}`);
  scope.line(`保留：${vers.slice(0, keep).map((v) => v.key).join('、')}`);

  const pruned = [];
  for (const { key, entry } of toDelete) {
    try {
      const netRel = autoPathFromEntry(entry.nextUrl);
      if (netRel) {
        await h1.deleteDir(`foldcraftlauncher_cn_auto/${sw.softwareId}/${netRel}`, scope);
      } else {
        scope.line(`版本 ${key} 非新格式路径，无法映射网盘目录，跳过网盘删除`);
      }
      // 只删有真实本地路径的条目：手写 children 条目无 nextUrl，绝不能拼出 "undefined" 去删
      if (typeof entry.nextUrl === 'string' && entry.nextUrl) {
        const jsonRel = entry.nextUrl.replace(/^\//, '');
        const localPath = join(ROOT, jsonRel);
        if (existsSync(localPath)) {
          unlinkSync(localPath);
          scope.line(`已删除本地 ${jsonRel}`);
        }
      } else {
        scope.line(`版本 ${key} 无 nextUrl（内联手写条目），仅从 index.json 移除`);
      }
      pruned.push(key);
    } catch (e) {
      scope.warn(`版本 ${key} 清理失败：${errText(e)}`);
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
    scope.line(`✅ 已更新 index.json（移除 ${pruned.length} 个条目）`);
  }
  return pruned;
}

// ---------- 提交前数据校验（JSON 可解析、直链前缀、size、index 一致性） ----------
function verifySyncedData(sw, synced, scope) {
  const errors = [];
  const urlPrefix = ENV.HOST + '/f/';
  for (const s of synced) {
    const jsonRel = s.jsonRel;
    let rows;
    try {
      rows = JSON.parse(readFileSync(join(ROOT, jsonRel), 'utf8'));
    } catch (e) {
      errors.push(`${jsonRel} 解析失败：${errText(e)}`);
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
    errors.push(`data/down/${sw.softwareId}/index.json 解析失败：${errText(e)}`);
  }
  if (Array.isArray(index)) {
    for (const s of synced) {
      const nextUrl = '/' + s.jsonRel;
      if (!index.some((e) => String(e.nextUrl || '') === nextUrl)) errors.push(`index.json 缺少 ${nextUrl}`);
    }
  }
  if (errors.length) throw new Error('提交前数据校验失败：\n  - ' + errors.join('\n  - '));
  scope.line(`✅ 提交前校验通过：${synced.length} 个版本 JSON / URL 前缀 ${urlPrefix} / size 合法 / index.json 条目齐全`);
}

// ---------- 提交单个软件 ----------
function commitSoftware(softwareId, versionList, bodyLines, scope) {
  // 先暂存 data/down/{id} 全部变更
  git(['add', '--', `data/down/${softwareId}`]);
  // 无变更则不提交
  try {
    gitQuiet(['diff', '--cached', '--quiet']);
    scope.line('（无文件变更，跳过提交）');
    return false;
  } catch { /* 有变更 */ }
  const subject = `[GHA] 新增：内容：数据源：资源id-${softwareId}：${versionList}呜~`;
  git([
    '-c', 'user.name=github-actions[bot]',
    '-c', 'user.email=github-actions[bot]@users.noreply.github.com',
    'commit', '-m', subject, '-m', bodyLines.join('\n'),
  ]);
  scope.line(`✅ 已提交：${subject}（正文 ${bodyLines.length} 行）`);
  return true;
}

// ---------- push ----------
function push(scope) {
  const branch = currentBranch();
  if (ENV.GITHUB_TOKEN && ENV.GITHUB_REPOSITORY) {
    git(['remote', 'set-url', 'origin', `https://x-access-token:${ENV.GITHUB_TOKEN}@github.com/${ENV.GITHUB_REPOSITORY}.git`]);
  }
  // push 可能因网络抖动、缺凭据交互而长时间挂起；给个上限，失败信息才能明确落到日志里
  execFileSync('git', ['-C', ROOT, 'push', 'origin', `HEAD:${branch}`], {
    stdio: 'inherit',
    timeout: 5 * 60 * 1000,
  });
  scope.line(`✅ 已推送 origin/${branch}`);
}

// ---------- 主流程 ----------
async function main() {
  const log = new Logger({ rootTitle: `线路1 自动同步 · ${SOFTWARES.length} 个软件` });
  const t0 = Date.now();
  let overallFailed = false;
  let anyCommit = false;

  // ================= 阶段 1：预探测候选（与 probe.mjs 共用 plan.mjs） =================
  const phase1 = log.child('阶段 1：预探测候选');
  const { plans, rows, failed: probeFailed } = await planAll(SOFTWARES, phase1, (sw) => newRow(sw.softwareId, sw));
  overallFailed = overallFailed || probeFailed > 0;
  phase1.close(
    plans.length
      ? `✅ 阶段 1 完成：${rows.length} 个软件｜${plans.length} 个需同步｜用时 ${fmtDur(Date.now() - t0)}`
      : `✅ 阶段 1 完成：${rows.length} 个软件｜全部已是最新｜用时 ${fmtDur(Date.now() - t0)}`,
  );

  // 全部最新 → 不登录、不动网盘，直接结束
  if (!plans.length) {
    const total = fmtDur(Date.now() - t0);
    log.line(`全部软件均已是最新，无需登录 huang1111，直接结束｜总用时 ${total}`);
    log.summary(renderSoftwareTable(rows, {
      title: '线路1 自动同步汇总',
      extra: [
        `- 结果：**全部已是最新，未登录网盘、未产生提交**`,
        `- 总用时：${total}`,
      ],
    }));
    log.annotate('notice', `线路1自动同步：全部软件已是最新（${rows.length} 个），本次无操作`);
    log.flushSummary();
    process.exit(overallFailed ? 1 : 0);
  }

  // ================= 阶段 2：登录 huang1111 =================
  // 优先用会话 cookie（人工登录一次取得，实测 60 天有效、不绑定 UA/IP）；
  // 站点自 2026-10-07 起把登录改成交互式验证，密码登录已无法自动化，仅作回退。
  const phase2 = log.child(`阶段 2：同步 ${plans.length} 个软件`);
  const loginScope = phase2.child('登录 huang1111', { symbol: '▸', commit: false });
  const loginT0 = Date.now();
  loginScope.line(`站点：${ENV.HOST}`);

  const sess = sessionInfo(ENV.SESSION);
  if (sess.present) {
    // 每次运行都汇报会话寿命 —— 这样在 GHA 日志里能一眼看到还剩多久，
    // 不必等失效了才发现（临期告警另由 check-session.mjs 在 probe job 里输出）。
    loginScope.line(
      `会话 cookie：${maskSession(ENV.SESSION)}`
      + `｜签发 ${fmtUnixCST(sess.issuedAt)}｜到期 ${fmtUnixCST(sess.expiresAt)}`
      + `｜剩余 ${fmtRemaining(sess.secondsLeft)}`,
    );
    if (!sess.parseable) loginScope.warn(`⚠ 无法解析签发时间：${sess.reason}（仍会尝试直接使用）`);
    else if (!sess.valid) loginScope.warn(`⚠ ${sess.reason}`);
    else if (sess.band === 1) loginScope.warn('⚠ 会话将在 1 天内过期，请尽快重新登录并更新 H1111_SESSION');
    else if (sess.band) loginScope.warn(`⚠ 会话将在 ${sess.band} 天内过期，建议回家时顺手更新 H1111_SESSION`);
  } else {
    loginScope.line(`未提供会话 cookie（H1111_SESSION 为空）｜账号：${ENV.USER ? `${ENV.USER.slice(0, 2)}***${ENV.USER.slice(-1)}` : '（未设置）'}`);
  }

  try {
    if (sess.present) {
      await h1.loginWithSession(ENV.SESSION, loginScope);
    } else {
      // 回退路径：站点把登录改成交互式验证后这条路必然失败，错误信息会说明原因与替代做法
      if (!ENV.USER || !ENV.PASSWORD) {
        throw new H1Error(
          '缺少凭据：请设置 H1111_SESSION（会话 cookie，推荐），或 H1111_USER / H1111_PASSWORD（回退）。'
          + ' 会话取法见 scripts/auto-sync/README.md',
        );
      }
      loginScope.warn('⚠ 未提供 H1111_SESSION，回退到账号密码登录；站点已启用交互式验证，此路径预计会失败');
      await h1.login(ENV.USER, ENV.PASSWORD, loginScope);
    }
    loginScope.close(`✅ 登录成功｜用时 ${fmtDur(Date.now() - loginT0)}`, { body: false });
  } catch (e) {
    loginScope.close(`❌ 登录失败：${errText(e)}｜用时 ${fmtDur(Date.now() - loginT0)}`, { kind: 'fail', body: false });
    log.summary(renderSoftwareTable(rows, {
      title: '线路1 自动同步汇总',
      extra: [`- 结果：**❌ 登录 huang1111 失败，所有软件均未同步**`, `- 错误：${errText(e)}`],
    }));
    log.annotate('error', `线路1自动同步：登录 huang1111 失败 —— ${errText(e)}`);
    log.flushSummary();
    process.exit(1);
  }

  // ================= 阶段 3：逐软件同步 =================
  for (const plan of plans) {
    const { sw, candidates, entries: origEntries } = plan;
    const row = rows.find((r) => r.id === sw.softwareId);
    const swT0 = Date.now();
    const scope = phase2.child(`资源 id=${sw.softwareId}（${sw.githubRepo}）`);
    // 提交正文 = 本作用域整棵树
    scope.line(`版本模式：${sw.mode}${sw.assetFilter ? `｜资产过滤 /${sw.assetFilter}/` : ''}${sw.keepLatest ? `｜keepLatest=${sw.keepLatest}` : ''}`);
    scope.line(`数据源最新：${plan.dsLatest ?? '（无）'}｜本次候选 ${candidates.length} 个：${candidates.map((c) => c.version).join('、')}`);

    try {
      // ---- 逐版本同步 ----
      const synced = [];
      for (const cand of candidates) {
        if (versionKnown(origEntries, cand.version)) {
          scope.line(`⏭️ 版本 ${cand.version} 已在数据源，跳过`);
          continue;
        }
        const vScope = scope.child(`版本 ${cand.version}`);
        try {
          const result = await syncVersion(sw, cand.version, cand.release, vScope);
          if (result) synced.push(result);
        } catch (e) {
          overallFailed = true;
          const msg = errText(e);
          vScope.close(`❌ 版本 ${cand.version} 同步失败（重试策略已耗尽）：${msg}`, { kind: 'fail' });
          log.annotate('error', `资源 id=${sw.softwareId} 版本 ${cand.version} 同步失败：${msg}`);
        }
      }

      if (!synced.length) {
        scope.close('⚠️ 本次无成功同步的版本，未更新 index.json', { kind: 'warn' });
        if (row) { row.result = '⚠️ 无成功同步'; row.endedAt = Date.now(); }
        continue;
      }

      // ---- 更新 index.json ----
      const idx = updateIndex(sw.softwareId, origEntries, synced);
      scope.line(`✅ 已更新 data/down/${sw.softwareId}/index.json：+${idx.added} 个版本条目（版本条目共 ${idx.versions} 个，置顶 ${idx.pinned} 个，总 ${idx.total} 条）`);

      // ---- 提交前校验 ----
      verifySyncedData(sw, synced, scope);

      // ---- keepLatest 保留清理（联动网盘 + index.json + 本地 JSON） ----
      const prune = scope.child('保留清理', { symbol: '▸' });
      const pruneT0 = Date.now();
      let pruned = [];
      try {
        pruned = await pruneSoftware(sw, prune);
        if (pruned.length) {
          prune.close(`✅ 已清理 ${pruned.length} 个最旧版本｜用时 ${fmtDur(Date.now() - pruneT0)}`);
        } else {
          // 没有可清理的 → run 日志留一行结论，提交正文里不留空小节
          prune.close(`无需清理（keepLatest=${sw.keepLatest || 0}）｜用时 ${fmtDur(Date.now() - pruneT0)}`);
          prune.dropFromBody();
        }
      } catch (e) {
        prune.close(`❌ 清理失败：${errText(e)}｜用时 ${fmtDur(Date.now() - pruneT0)}`, { kind: 'fail' });
      }
      if (row) row.pruned = pruned;

      // ---- 提交 ----
      const versionList = synced.map((s) => s.version).sort(compareVersionsDescending).join('&');
      scope.line(`提交版本列表：${versionList}`);
      try {
        const committed = commitSoftware(sw.softwareId, versionList, scope.collectBody(), scope);
        if (committed) anyCommit = true;
        if (row) {
          row.taken = synced.map((s) => s.version);
          row.result = committed ? '✅ 已同步并提交' : '⚠️ 无文件变更';
        }
        scope.close(
          committed
            ? `✅ 完成：同步 ${synced.length} 个版本并提交｜用时 ${fmtDur(Date.now() - swT0)}`
            : `✅ 完成：同步 ${synced.length} 个版本（无变更，未提交）｜用时 ${fmtDur(Date.now() - swT0)}`,
        );
      } catch (e) {
        overallFailed = true;
        const msg = errText(e);
        if (row) { row.taken = synced.map((s) => s.version); row.result = `❌ 提交失败：${msg}`; }
        scope.close(`❌ 提交失败：${msg}`, { kind: 'fail' });
        log.annotate('error', `资源 id=${sw.softwareId} 提交失败：${msg}`);
      }
    } catch (e) {
      overallFailed = true;
      const msg = errText(e);
      if (row) { row.result = `❌ ${msg}`; }
      scope.close(`❌ 处理失败：${msg}`, { kind: 'fail' });
      log.annotate('error', `资源 id=${sw.softwareId} 处理失败：${msg}`);
    } finally {
      if (row) row.endedAt = Date.now();
    }
  }
  phase2.close(`✅ 阶段 2 完成｜用时 ${fmtDur(Date.now() - t0)}`);

  // ================= 阶段 4：推送 =================
  const phase3 = log.child('阶段 3：推送远程');
  const pushT0 = Date.now();
  if (anyCommit) {
    try {
      push(phase3);
      phase3.close(`✅ 推送完成｜用时 ${fmtDur(Date.now() - pushT0)}`);
    } catch (e) {
      overallFailed = true;
      const msg = errText(e);
      phase3.close(`❌ push 失败：${msg}`, { kind: 'fail' });
      log.annotate('error', `线路1自动同步 push 失败：${msg}`);
    }
  } else {
    phase3.close('⏭️ 本次无提交，跳过 push', { body: false });
  }

  // ================= 收尾 =================
  const total = fmtDur(Date.now() - t0);
  const okCount = rows.filter((r) => r.result.startsWith('✅')).length;
  log.line(`总用时 ${total}｜结果：${overallFailed ? '存在失败项' : '全部成功'}｜成功软件 ${okCount}/${rows.length}`);

  log.summary(renderSoftwareTable(rows, {
    title: '线路1 自动同步汇总',
    extra: [
      `- 整体结果：${overallFailed ? '**⚠️ 存在失败项（详见上方 run 日志）**' : '**✅ 全部成功**'}`,
      `- 成功软件：${okCount} / ${rows.length}｜产生提交：${anyCommit ? '是' : '否'}`,
      `- 总用时：${total}`,
    ],
  }));

  if (overallFailed) {
    log.annotate('error', `线路1自动同步存在失败项，总用时 ${total}，请查看上方日志`);
  } else {
    log.annotate('notice', `线路1自动同步完成：${okCount} 个软件，总用时 ${total}`);
  }
  log.flushSummary();
  process.exit(overallFailed ? 1 : 0);
}

// 直接执行本文件（node scripts/auto-sync/sync.mjs）才进入主流程；
// 被 import（如验证脚本 / 本地手动同步工具）时仅暴露函数，便于复用与白盒测试
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((e) => {
    process.stderr.write('脚本异常：' + (e.stack || e.message) + '\n');
    process.exit(1);
  });
}

export { compareVersionsDescending, datePathFromRelease, entrySortKey, isPinnedEntry, normalizeVersionText };

// 供本地交互式手动同步工具（.tmp/manual-sync.mjs）复用：
// 「下载 → 直链 → 写 JSON → 更新 index → 清理 → 提交 → push」全链路与 GHA 共用同一份实现，避免逻辑漂移
export { syncVersion, updateIndex, verifySyncedData, pruneSoftware, commitSoftware, push };
