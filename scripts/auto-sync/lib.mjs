// lib.mjs — 线路1 自动同步：纯函数 + 共享常量
// 供 sync.mjs / probe.mjs / plan.mjs 复用，不含任何 h1 / git / 写文件的副作用。
//
// ⚠ 2026-10 日志全量重构：本文件**不再持有任何日志状态**（旧的可变 ctx 已整体删除）。
//   日志实现只有一处 —— logger.mjs。需要打日志的函数改为**接收回调**（见 fetchReleasesPage
//   的 onLog 参数），由调用方决定挂到哪个作用域上；这样再也没有「全局可变 log 被猴补丁替换」的脏东西。
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV, RETRY } from './config.mjs';

// ---------- 路径 ----------
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOFTWARES = JSON.parse(readFileSync(join(HERE, 'softwares.json'), 'utf8'));

// ---------- 不完整守护 ----------
// Release 刚发布时，资产可能还没传齐、直链也可能尚未生效；本轮先跳过，
// 等发布满 guardMinutes 分钟后再同步（下一轮自动重试）。
// 每个软件可在 softwares.json 里用 guardMinutes 单独覆盖；0 = 关闭守护。
export const DEFAULT_GUARD_MINUTES = 10;
export function guardMinutesOf(sw) {
  const raw = sw ? sw.guardMinutes : undefined;
  if (raw === undefined || raw === null || raw === '') return DEFAULT_GUARD_MINUTES;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_GUARD_MINUTES;
}

// ---------- 版本比较（与前端 js/adapters/download/common.js 一致） ----------
const VERSION_NUMBER = /\d+/g;
export function compareVersionsDescending(left, right) {
  const leftParts = String(left).match(VERSION_NUMBER)?.map(Number) || [];
  const rightParts = String(right).match(VERSION_NUMBER)?.map(Number) || [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

// ---------- 版本名归一化（保留 v/V 前缀，非法字符 → _，连续点塌缩，去首尾点） ----------
export function versionFromTag(tag) {
  return String(tag || '')
    .trim()
    .replace(/[\\/:*?"<>|\s]+/g, '_')
    .replace(/^\.+|\.+$/g, '')
    .replace(/\.{2,}/g, '.');
}

// ---------- Release 发布时间 → UTC+8 日期目录（年/月/日，不补零） ----------
export function datePathFromRelease(release) {
  const shifted = new Date(new Date(release.published_at).getTime() + 8 * 3600 * 1000);
  return `${shifted.getUTCFullYear()}/${shifted.getUTCMonth() + 1}/${shifted.getUTCDate()}`;
}

// ---------- 从 index.json 条目反解版本名 ----------
// 新格式（日期归档）：/data/down/{id}/auto/{年}/{月}/{日}/{版本名}.json
// 旧格式（版本逐位拆分）：/data/down/{id}/{段...}.json
const AUTO_DIR_RE = /^\/data\/down\/\d+\/auto\/\d+\/\d+\/\d+\/([^/]+)\.json$/;
const OLD_DIR_RE = /^\/data\/down\/\d+\/([0-9A-Za-z_/]+)\.json$/;
export function entryVersionKey(nextUrl) {
  const next = String(nextUrl || '');
  const m = AUTO_DIR_RE.exec(next);
  if (m) return m[1];
  const o = OLD_DIR_RE.exec(next);
  if (o) {
    // auto 是保留命名空间：旧格式首段不可能以 auto 开头（版本名以 v/V/数字开头）
    const segs = o[1].split('/');
    if (segs[0] !== 'auto' && segs.length >= 2 && segs.every((s) => /^[0-9A-Za-z_]+$/.test(s))) return segs.join('.');
  }
  return null;
}

// ---------- 条目版本号解析（路径优先，其次 name/version/tag 文本） ----------
// 背景（2026-10-02 修订）：旧实现只看 nextUrl，凡是"路径反解不出版本号"的条目一律
// 当手动条目隔离到最前。这带来两个副作用：
//   ① id0 的 /data/down/0/boat.json（"最后一个有Boat后端的版本"）靠这条规则意外置顶；
//   ② id12 那类 { name, children } 内联形态的手写版本条目也被判为手动，永远压在
//     自动同步的新版本之前，导致新版本反而排到列表最底（版本顺序错乱）。
// 现在改为显式声明：置顶/特殊条目必须在 JSON 里写 pinned: true，其余条目一律尝试
// 从 name / version / tag 文本中提取版本号并参与统一排序。
const VERSION_TEXT_RE = /^[vV]?\d+(?:\.\d+)*$/;
export function normalizeVersionText(text) {
  const s = String(text ?? '').trim().replace(/^[vV](?=\d)/, '');
  return VERSION_TEXT_RE.test(s) ? s : null;
}
// 返回版本号字符串，或 null（无法识别 → 视为需原样保留的 pinned/特殊条目）
export function entrySortKey(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const fromPath = entryVersionKey(entry.nextUrl);
  if (fromPath != null) return fromPath;
  return normalizeVersionText(entry.tag) ?? normalizeVersionText(entry.version) ?? normalizeVersionText(entry.name);
}
// 是否置顶条目：显式 pinned: true，或既无 nextUrl 又解析不出版本号（历史遗留兜底，
// 保证旧数据里那些真正无法归类的条目不会被误排进版本序列）
export function isPinnedEntry(entry) {
  if (!entry || typeof entry !== 'object') return true;
  if (entry.pinned === true) return true;
  return entrySortKey(entry) == null;
}

// ---------- 数据源基线（读本地 data/down/{id}/index.json） ----------
// 版本范围只统计"非置顶且版本号可解析"的条目：pinned/特殊条目（如 id0 的 Boat 版）
// 不代表数据源最新版本，不能参与"落后几个版本"的判定。
export function parseDataSourceIndex(softwareId) {
  const indexPath = join(ROOT, 'data', 'down', String(softwareId), 'index.json');
  if (!existsSync(indexPath)) return { latest: null, entries: [], versionCount: 0 };
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    throw new Error(`解析 ${indexPath} 失败：${e.message}`);
  }
  if (!Array.isArray(entries)) entries = [];
  const versions = [];
  for (const e of entries) {
    if (isPinnedEntry(e)) continue;
    const key = entrySortKey(e);
    if (key != null) versions.push(key);
  }
  if (!versions.length) return { latest: null, entries, versionCount: 0 };
  versions.sort(compareVersionsDescending);
  return { latest: versions[0], entries, versionCount: versions.length };
}

// ---------- 判定版本是否已在数据源内 ----------
export function versionKnown(entries, version) {
  const target = normalizeVersionText(version) ?? String(version);
  return entries.some((e) => {
    if (isPinnedEntry(e)) return false;
    const key = entrySortKey(e);
    if (key == null) return false;
    // 比较前统一去 v/V 前缀，避免 v1.0.5 与 1.0.5 被当成两个版本重复同步
    return (normalizeVersionText(key) ?? key) === target;
  });
}

// ---------- GitHub Releases ----------
// 拉取一页 Release（per_page=100）。返回 { releases: 过滤后的列表, hasNext: 是否还有下一页 }：
//   · 过滤口径与改造前完全一致：非 draft、（可选）非 prerelease、tag 含数字
//   · hasNext 依据响应头 Link 的 rel="next"（比"是否满页"可靠：draft/prerelease 过滤不影响判断）
//
// onLog：可选回调，接收单行字符串。日志实现由调用方（logger.mjs 的作用域）提供，
//        本文件不持有任何日志状态 —— 这是 2026-10 日志重构的核心约束。
export async function fetchReleasesPage(githubRepo, includePrerelease, page = 1, onLog = null) {
  const say = (m) => { if (typeof onLog === 'function') onLog(m); };
  const url = `https://api.github.com/repos/${githubRepo}/releases?per_page=100&page=${page}`;
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
      return {
        releases: list.filter(
          (r) => !r.draft && (includePrerelease || !r.prerelease) && /[0-9]/.test(r.tag_name || ''),
        ),
        hasNext: /rel="next"/.test(res.headers.get('link') || ''),
      };
    } catch (e) {
      lastErr = e;
      if (attempt < RETRY.GENERIC_ATTEMPTS) {
        say(`GitHub 拉取失败（第 ${attempt}/${RETRY.GENERIC_ATTEMPTS} 次）：${e.message}，重试…`);
      }
    }
  }
  throw new Error(`GitHub 拉取失败：${lastErr?.message || '未知'}`);
}

// 返回第一页过滤后的 Releases 数组（口径与改造前一致）
export async function fetchReleases(githubRepo, includePrerelease, onLog = null) {
  return (await fetchReleasesPage(githubRepo, includePrerelease, 1, onLog)).releases;
}

// ---------- 资产 → 版本文件条目 ----------
// mode=arch：按 archNames 顺序输出 [{arch,url,size,_file}]；无法按后缀识别的 .apk 归入 fallbackArch
// mode=name：按资产名排序输出 [{name,url,size,_file}]
// size 为 GitHub asset 的精确字节数，用于离线下载成功后与网盘目录里的文件大小做精确比对
export function mapAssetsToEntries(mode, archNames, fallbackArch, assets) {
  if (mode === 'name') {
    const out = [];
    for (const a of assets) {
      const name = String(a.name).replace(/\.apk$/i, '');
      out.push({ name, url: a.browser_download_url, _file: a.name, size: a.size });
    }
    out.sort((x, y) => x.name.localeCompare(y.name));
    return out;
  }
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
  const fallbackUsed = fallbackArch && !byArch.get(fallbackArch) && leftover.length;
  if (fallbackUsed) byArch.set(fallbackArch, leftover[0]);
  const out = [];
  for (const arch of archNames) {
    const a = byArch.get(arch);
    if (a) out.push({ arch, url: a.browser_download_url, _file: a.name, size: a.size });
  }
  // fallback 命中且 archNames 不含该架构时，额外输出
  if (fallbackUsed && !archNames.includes(fallbackArch)) {
    const a = byArch.get(fallbackArch);
    if (a) out.push({ arch: fallbackArch, url: a.browser_download_url, _file: a.name, size: a.size });
  }
  return out;
}

// 重导出路径常量
export { ROOT, SOFTWARES };

// 保留 fileURLToPath 以兼容原有 import
export { fileURLToPath };
