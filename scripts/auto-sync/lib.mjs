// lib.mjs — 线路1 自动同步：纯函数 + 共享状态
// 供 sync.mjs（正式同步）与 probe.mjs（预探测）复用，不含任何 h1 / git / 写文件的副作用
import { existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ENV, RETRY } from './config.mjs';

// ---------- 路径 ----------
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..', '..');
const SOFTWARES = JSON.parse(readFileSync(join(HERE, 'softwares.json'), 'utf8'));

// ---------- 日志（可变 ctx.log 以便调用方在作用域内拦截） ----------
export const ctx = {
  runLog: [],
  log(msg) {
    const line = `[${new Date().toISOString().replace('T', ' ').slice(0, 19)}] ${msg}`;
    this.runLog.push(line);
    console.log(line);
  },
};

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

// ---------- 从 index.json 条目 nextUrl 反解版本名 ----------
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

// ---------- 数据源基线（读本地 data/down/{id}/index.json） ----------
export function parseDataSourceIndex(softwareId) {
  const indexPath = join(ROOT, 'data', 'down', String(softwareId), 'index.json');
  if (!existsSync(indexPath)) return { latest: null, entries: [] };
  let entries = [];
  try {
    entries = JSON.parse(readFileSync(indexPath, 'utf8'));
  } catch (e) {
    throw new Error(`解析 ${indexPath} 失败：${e.message}`);
  }
  if (!Array.isArray(entries)) entries = [];
  const versions = [];
  for (const e of entries) {
    const key = entryVersionKey(e.nextUrl);
    if (key != null) versions.push(key);
  }
  if (!versions.length) return { latest: null, entries };
  versions.sort(compareVersionsDescending);
  return { latest: versions[0], entries };
}

// ---------- 判定版本是否已在数据源内 ----------
export function versionKnown(entries, version) {
  return entries.some((e) => entryVersionKey(e.nextUrl) === version);
}

// ---------- GitHub Releases ----------
export async function fetchReleases(githubRepo, includePrerelease) {
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
      if (attempt < RETRY.GENERIC_ATTEMPTS) ctx.log(`  [GitHub] 拉取失败（第${attempt}次）：${e.message}，重试…`);
    }
  }
  throw new Error(`GitHub 拉取失败：${lastErr?.message || '未知'}`);
}

// ---------- 资产 → 版本文件条目 ----------
// mode=arch：按 archNames 顺序输出 [{arch,url,size}]；无法按后缀识别的 .apk 归入 fallbackArch
// mode=name：按资产名排序输出 [{name,url,size}]
export function mapAssetsToEntries(mode, archNames, fallbackArch, assets) {
  if (mode === 'name') {
    const out = [];
    for (const a of assets) {
      const name = String(a.name).replace(/\.apk$/i, '');
      out.push({ name, url: a.browser_download_url, _file: a.name });
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
    if (a) out.push({ arch, url: a.browser_download_url, _file: a.name });
  }
  // fallback 命中且 archNames 不含该架构时，额外输出
  if (fallbackUsed && !archNames.includes(fallbackArch)) {
    const a = byArch.get(fallbackArch);
    if (a) out.push({ arch: fallbackArch, url: a.browser_download_url, _file: a.name });
  }
  return out;
}

// 重导出路径常量
export { ROOT, SOFTWARES };

// 保留 fileURLToPath 以兼容原有 import
export { fileURLToPath };
