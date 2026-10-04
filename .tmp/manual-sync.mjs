// manual-sync.mjs — 线路1 本地交互式手动同步（临时工具，放在 .tmp/，不参与 GHA）
//
// 与 GHA 的关系：复用 scripts/auto-sync 的正式实现，逻辑完全同源 ——
//   · h1api.mjs  → 登录 / captcha policy v2 验证链路 / 离线下载 / 取直链
//   · sync.mjs   → syncVersion / updateIndex / verifySyncedData / pruneSoftware / commitSoftware / push
// 与 GHA 唯一的区别：版本候选由你在 Release 列表中手动选择，而非按 index.json 基线自动判定。
//
// 用法：node .tmp/manual-sync.mjs
// 流程：仓库地址 → huang1111 账号密码 →（未收录仓库时补充参数）→ 分页浏览 Release 并选择
//       （n/p 翻页、more 加载更早、数字=全局序号多选（可跨页）、all=全选已加载、q=退出）
//       → 已同步版本询问「强制重跑 / 跳过」→ 选择 git 操作 → 确认 → 登录并同步
//
// 说明：
//   · 凭据只驻留内存，不落盘；可选环境变量 GITHUB_TOKEN 可提高 GitHub API 限额
//   · 未收录仓库的补充参数仅本次运行使用，不写入 softwares.json
//   · 同步完成后的 git 操作三选一：a=提交+推送（完整 GHA 流程）/ c=仅本地提交 / n=不提交

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { emitKeypressEvents } from 'node:readline';

import * as h1 from '../scripts/auto-sync/h1api.mjs';
import { log } from '../scripts/auto-sync/log.mjs';
import {
  ROOT, SOFTWARES,
  parseDataSourceIndex, versionKnown, versionFromTag, compareVersionsDescending, fetchReleasesPage,
} from '../scripts/auto-sync/lib.mjs';
import {
  syncVersion, updateIndex, verifySyncedData, pruneSoftware, commitSoftware, push,
} from '../scripts/auto-sync/sync.mjs';

// ============================ 交互输入 ============================
const input = process.stdin;
const output = process.stdout;

class InputEnded extends Error {
  constructor(message = '交互输入已结束（stdin 已关闭）') {
    super(message);
    this.name = 'InputEnded';
  }
}

emitKeypressEvents(input);
// 兜底：无论以何种方式退出，都恢复终端模式
process.on('exit', () => {
  try { if (input.isTTY) input.setRawMode(false); } catch { /* ignore */ }
});

// 非 TTY（管道/重定向）：一次性读完 stdin，按行排队弹出
let pipeQueue = null;
async function nextPipeLine() {
  if (!pipeQueue) {
    input.setEncoding('utf8');
    let raw = '';
    for await (const chunk of input) raw += chunk;
    pipeQueue = raw.split(/\r?\n/);
    if (pipeQueue.length && pipeQueue[pipeQueue.length - 1] === '') pipeQueue.pop();
  }
  return pipeQueue.length ? pipeQueue.shift() : null;
}

// TTY：raw 模式逐键读取，支持掩码（密码）、退格、Ctrl+C
function readLineTTY(prompt, mask) {
  return new Promise((resolve) => {
    output.write(prompt);
    input.setRawMode(true);
    input.resume();
    let buf = '';
    const onKey = (str, key) => {
      if (key?.ctrl && key?.name === 'c') {
        cleanup();
        output.write('\n');
        console.log('已取消（Ctrl+C）');
        process.exit(130);
      } else if (key?.name === 'return' || key?.name === 'enter') {
        cleanup();
        output.write('\n');
        resolve(buf);
      } else if (key?.name === 'backspace') {
        if (buf.length) {
          buf = buf.slice(0, -1);
          output.write('\b \b');
        }
      } else if (str && str >= ' ' && !key?.ctrl && !key?.meta && key?.name !== 'escape') {
        buf += str;
        output.write(mask ? '*' : str);
      }
    };
    const cleanup = () => {
      input.removeListener('keypress', onKey);
      input.setRawMode(false);
      input.pause();
    };
    input.on('keypress', onKey);
  });
}

// 读取一行；非 TTY 时输入耗尽抛 InputEnded
async function readLine(prompt, { mask = false } = {}) {
  if (!input.isTTY) {
    output.write(prompt);
    const line = await nextPipeLine();
    output.write(line === null ? '（输入结束）\n' : '（非交互输入）\n');
    if (line === null) throw new InputEnded();
    return line;
  }
  return readLineTTY(prompt, mask);
}

// 读取一个非空文本；def 非 null 时允许空回车取默认值（def 可为空串）
async function askText(prompt, { mask = false, def = null, validate = null } = {}) {
  for (;;) {
    const line = await readLine(prompt, { mask });
    const v = mask ? line : line.trim(); // mask（密码）保留原样：首尾空格可能是密码的一部分
    if (v === '') {
      if (def !== null) return def;
      console.log('  ⚠ 不能为空，请重新输入');
      continue;
    }
    if (validate && !validate(v)) {
      console.log('  ⚠ 输入无效，请重新输入');
      continue;
    }
    return v;
  }
}

// ============================ 小工具 ============================
// 显示宽度（CJK 记 2 列），用于表格对齐
function dispWidth(s) {
  let w = 0;
  for (const c of String(s)) w += /[\u1100-\uFFE6]/.test(c) ? 2 : 1;
  return w;
}
const padEndW = (s, n) => String(s) + ' '.repeat(Math.max(0, n - dispWidth(s)));
function truncateW(s, n) {
  const str = String(s);
  const cw = (c) => (/[\u1100-\uFFE6]/.test(c) ? 2 : 1);
  let w = 0;
  let out = '';
  for (const c of str) {
    if (w + cw(c) > n) {
      // 需要截断：回退到 n-3 宽再加 ASCII 省略号，保证结果宽度不超过 n（终端对 … 的渲染宽度不一致）
      let out2 = '';
      let w2 = 0;
      for (const c2 of str) {
        if (w2 + cw(c2) > n - 3) break;
        w2 += cw(c2);
        out2 += c2;
      }
      return out2 + '...';
    }
    w += cw(c);
    out += c;
  }
  return out;
}

// Release 发布时间 → UTC+8 展示串
function fmtDateCST(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 仓库地址解析：接受 owner/repo、https://github.com/owner/repo(/…)、git@github.com:owner/repo.git
function parseRepo(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s#?]+)/i.exec(s);
  if (m) return `${m[1]}/${m[2].replace(/\.git$/i, '')}`;
  const m2 = /^([\w.-]+)\/([\w.-]+)$/.exec(s);
  if (m2) return `${m2[1]}/${m2[2].replace(/\.git$/i, '')}`;
  return null;
}

// ============================ 配置匹配 / 询问 ============================
function findSoftware(repo) {
  const lower = repo.toLowerCase();
  return SOFTWARES.find((s) => String(s.githubRepo).toLowerCase() === lower) || null;
}

// 未收录仓库：交互补充本次运行参数（不写回 softwares.json）
async function askSoftwareConfig(repo) {
  console.log(`ℹ 仓库 ${repo} 未在 softwares.json 收录，请补充本次同步参数（仅本次运行使用，不写入配置文件）`);
  const idRaw = await askText('  站内软件 id（对应 data/down/{id}）：', { validate: (v) => /^\d+$/.test(v) });
  const filterRaw = await askText('  资产过滤正则（回车默认 \\.apk$；输入 - 表示不过滤全部资产）：', {
    def: '\\.apk$',
    validate: (v) => {
      if (v === '-') return true;
      try { new RegExp(v); return true; } catch { return false; }
    },
  });
  const mode = await askText('  输出模式（arch=按架构出条目 / name=按文件名出条目；回车默认 name）：', {
    def: 'name',
    validate: (v) => v === 'arch' || v === 'name',
  });
  let archNames = [];
  let fallbackArch = null;
  if (mode === 'arch') {
    for (;;) {
      const archRaw = await askText('  架构列表（逗号分隔，如 all,arm64-v8a；可回车留空）：', { def: '' });
      archNames = archRaw ? archRaw.split(/[,，]/).map((s) => s.trim()).filter(Boolean) : [];
      const fb = await askText('  fallback 架构（无法识别的 .apk 归入此架构；可回车留空）：', { def: '' });
      fallbackArch = fb || null;
      if (archNames.length || fallbackArch) break;
      console.log('  ⚠ arch 模式至少需要「架构列表」或「fallback 架构」其一，请重填');
    }
  }
  const keepRaw = await askText('  keepLatest（保留最新 N 个版本，0=不清理；回车默认 0）：', {
    def: '0',
    validate: (v) => /^\d+$/.test(v),
  });
  return {
    softwareId: Number(idRaw),
    githubRepo: repo,
    assetFilter: filterRaw === '-' ? null : filterRaw,
    mode,
    archNames,
    fallbackArch,
    keepLatest: Number(keepRaw),
    includePrerelease: false,
  };
}

// ============================ Release 列表 ============================
const PAGE_SIZE = 20; // 分页浏览每屏条数

// 把一页 Releases 转为展示行（跨页按归一化版本名去重），返回新增行
function buildReleaseRows(releases, filterRe, entries, seen) {
  const out = [];
  for (const r of releases) {
    const version = versionFromTag(r.tag_name);
    if (seen.has(version)) continue; // 归一化后重名（如 v1.0 与 "v1.0"）只保留第一个
    seen.add(version);
    const all = r.assets || [];
    const matched = filterRe ? all.filter((a) => filterRe.test(a.name || '')) : all;
    out.push({
      release: r,
      version,
      prerelease: !!r.prerelease,
      assetsMatched: matched.length,
      assetsTotal: all.length,
      known: versionKnown(entries, version),
    });
  }
  return out;
}

// 打印一页（序号为跨页连续的全局序号；offset 为当前页起始偏移）
function printReleasePage(slice, offset, total, pageNo, totalPages, hasMore) {
  console.log('');
  console.log('  ' + padEndW('序号', 6) + padEndW('Tag', 30) + padEndW('标题', 38) + padEndW('发布时间(UTC+8)', 18) + padEndW('匹配资产', 10) + '状态');
  console.log('  ' + '-'.repeat(110));
  slice.forEach((row, i) => {
    const tag = truncateW(String(row.release.tag_name) + (row.prerelease ? ' [pre]' : ''), 28);
    const title = truncateW(row.release.name || '—', 36);
    const assets = `${row.assetsMatched}/${row.assetsTotal} 个`;
    const state = row.known ? '✅ 已同步' : '🆕 未同步';
    console.log(
      `  ${padEndW(String(offset + i + 1), 6)}${padEndW(tag, 30)}${padEndW(title, 38)}${padEndW(fmtDateCST(row.release.published_at), 18)}${padEndW(assets, 10)}${state}`,
    );
  });
  console.log(`  第 ${pageNo}/${totalPages} 页 · 共 ${total} 条已加载${hasMore ? ' · GitHub 上还有更早的（可 more）' : ''} · 最新在前`);
  console.log('');
}

// 选择输入解析：支持 1 / 1,3 / 2-4 / all / q
function parseSelection(text, max) {
  const t = String(text || '').trim().toLowerCase();
  if (t === 'q' || t === 'quit' || t === 'exit') return { quit: true, items: [] };
  if (t === 'all' || t === 'a' || t === '*') {
    return { quit: false, items: Array.from({ length: max }, (_, i) => i + 1) };
  }
  const out = new Set();
  for (const part of t.split(/[,，\s]+/).filter(Boolean)) {
    const m = /^(\d+)(?:\s*[-~]\s*(\d+))?$/.exec(part);
    if (!m) return null;
    const a = Number(m[1]);
    const b = m[2] ? Number(m[2]) : a;
    if (a < 1 || b > max || a > b) return null;
    for (let i = a; i <= b; i += 1) out.add(i);
  }
  return out.size ? { quit: false, items: [...out].sort((x, y) => x - y) } : null;
}

// ============================ 执行同步（复用 GHA 逻辑） ============================
const GIT_MODE_TEXT = {
  a: '提交 + 推送（完整 GHA 流程）',
  c: '仅本地提交（不推送）',
  n: '不提交（只写文件）',
};

async function runSync({ sw, entries, todo, gitMode, user, password }) {
  log.section(`同步 ${sw.githubRepo}（资源id-${sw.softwareId}）`);
  try {
    await h1.login(user, password);
  } catch (e) {
    log.fail(`登录失败：${e.message}`);
    process.exitCode = 1;
    return;
  }

  let failed = false;
  const synced = [];
  let prepared = false; // updateIndex/校验/清理全部成功后才允许提交（与原实现一致：中途失败不提交）
  // 捕获本次同步详细日志，作为 commit body（与 GHA 的每软件 commit 正文一致）
  const body = await log.capture(async () => {
    log.group(`软件 id=${sw.softwareId}（${sw.mode} 模式）`);
    try {
      for (const item of todo) {
        try {
          const result = await syncVersion(sw, item.version, item.release);
          if (result) synced.push(result);
        } catch (e) {
          failed = true;
          log.fail(`版本 ${item.version} 同步失败：${e.message}`);
        }
      }

      if (synced.length) {
        mkdirSync(join(ROOT, 'data', 'down', String(sw.softwareId)), { recursive: true });
        updateIndex(sw.softwareId, entries, synced);
        log.detail(`已更新 index.json（+${synced.length} 个版本）`);
        verifySyncedData(sw, synced);
        log.detail('提交前校验通过');
        const pruned = await pruneSoftware(sw);
        if (pruned.length) log.detail(`[清理] 已移除 ${pruned.length} 个条目`);
        prepared = true;
      }
    } catch (e) {
      failed = true;
      log.fail(`同步处理失败：${e.message}`);
    } finally {
      log.end();
    }
  });

  if (prepared && gitMode !== 'n') {
    const versionList = synced.map((s) => s.version).sort(compareVersionsDescending).join('&');
    try {
      const committed = commitSoftware(sw.softwareId, versionList, body);
      if (committed && gitMode === 'a') {
        push();
        log.ok('已推送');
      }
    } catch (e) {
      failed = true;
      log.fail(`git 操作失败：${e.message}`);
    }
  }

  if (failed) process.exitCode = 1;
}

// ============================ 主流程 ============================
async function main() {
  console.log('==================================================');
  console.log(' 线路1 本地交互式手动同步（复用 GHA 正式逻辑）');
  console.log('==================================================');
  console.log('提示：Ctrl+C 随时取消；可选环境变量 GITHUB_TOKEN 提高 GitHub API 限额\n');

  // 1) 仓库地址
  let repo = null;
  for (;;) {
    const s = await askText('请输入 GitHub 仓库（owner/repo 或仓库 URL）：');
    repo = parseRepo(s);
    if (repo) break;
    console.log('  ⚠ 无法解析，示例：FCL-Team/FoldCraftLauncher 或 https://github.com/FCL-Team/FoldCraftLauncher');
  }
  console.log(`→ 仓库：${repo}`);

  // 2) huang1111 凭据
  const user = await askText('请输入 huang1111 账号：');
  const password = await askText('请输入 huang1111 密码（输入不回显）：', { mask: true });

  // 3) 软件配置（匹配 softwares.json，未收录则补充参数）
  let sw = findSoftware(repo);
  if (sw) {
    console.log(`ℹ 已收录：softwareId=${sw.softwareId}，mode=${sw.mode}${sw.assetFilter ? `，assetFilter=${sw.assetFilter}` : '，不过滤资产'}${sw.keepLatest ? `，keepLatest=${sw.keepLatest}` : ''}`);
  } else {
    sw = await askSoftwareConfig(repo);
  }

  // 4) 数据源基线（data/down/{id}/index.json）
  let entries = [];
  try {
    entries = parseDataSourceIndex(sw.softwareId).entries;
    console.log(`数据源基线：data/down/${sw.softwareId}/index.json 读取成功（${entries.length} 个条目）`);
  } catch (e) {
    console.log(`⚠ 读取 data/down/${sw.softwareId}/index.json 失败：${e.message}（按空基线处理）`);
  }

  // 5) 拉取第一页 Release，建立分页浏览状态
  const filterRe = sw.assetFilter ? new RegExp(sw.assetFilter) : null;
  const rows = [];
  const seen = new Set();
  let hasMore = true;  // GitHub 上是否还有更早的页
  let nextApiPage = 1; // 下一次 loadMoreReleases 拉取的 API 页码

  async function loadMoreReleases() {
    const { releases, hasNext } = await fetchReleasesPage(repo, true, nextApiPage);
    const added = buildReleaseRows(releases, filterRe, entries, seen);
    rows.push(...added);
    hasMore = hasNext;
    nextApiPage += 1;
    return added.length;
  }

  try {
    await loadMoreReleases();
  } catch (e) {
    console.log('❌ 拉取 GitHub Releases 失败：' + e.message);
    process.exitCode = 1;
    return;
  }
  if (!rows.length) {
    console.log('该仓库没有可选 Release（draft / tag 不含数字的会被排除）');
    return;
  }
  console.log(`\n共 ${rows.length} 条 Release（含预发布，标 [pre]；「已同步」按 index.json 判定）`);

  // 6) 分页浏览并选择：n/p 翻页，more 加载更早，数字=全局序号（可跨页），all=全选已加载，q=退出
  let pageNo = 1;
  let sel = null;
  while (!sel) {
    const totalPages = Math.max(1, Math.ceil(rows.length / PAGE_SIZE));
    if (pageNo > totalPages) pageNo = totalPages;
    const start = (pageNo - 1) * PAGE_SIZE;
    printReleasePage(rows.slice(start, start + PAGE_SIZE), start, rows.length, pageNo, totalPages, hasMore);

    const cmds = [];
    if (pageNo < totalPages) cmds.push('n=下一页');
    if (pageNo > 1) cmds.push('p=上一页');
    if (hasMore) cmds.push('more=加载更早');
    cmds.push('数字=选择（如 1,3-5，可跨页）', 'all=全选已加载', 'q=退出');
    console.log('  命令：' + cmds.join('  '));

    let line;
    try {
      line = (await readLine('> ')).trim().toLowerCase();
    } catch (e) {
      if (e instanceof InputEnded) break; // 输入结束 → 取消
      throw e;
    }

    if (line === '' || line === 'n') {
      if (pageNo < totalPages) pageNo += 1;
      else console.log(hasMore ? '  已是最后一页；输入 more 加载更早的 Release' : '  已是最后一页');
    } else if (line === 'p') {
      if (pageNo > 1) pageNo -= 1;
      else console.log('  已是第一页');
    } else if (line === 'more' || line === 'm') {
      if (!hasMore) {
        console.log('  没有更早的 Release 了');
      } else {
        const before = rows.length;
        console.log(`  正在加载更早的 Release（API 第 ${nextApiPage} 页）…`);
        try {
          const added = await loadMoreReleases();
          console.log(`  ✅ 新增 ${added} 条（共 ${rows.length} 条）`);
          pageNo = Math.floor(before / PAGE_SIZE) + 1; // 跳到新加载内容的第一页
        } catch (e) {
          console.log('  ❌ 加载失败：' + e.message);
        }
      }
    } else {
      const s = parseSelection(line, rows.length);
      if (s) sel = s;
      else console.log(`  ⚠ 无法识别（当前已加载 ${rows.length} 条${hasMore ? '，可 more 加载更早' : ''}）：可用 n / p / more / all / q，或输入序号如 1,3-5`);
    }
  }
  if (!sel || sel.quit) {
    console.log('已取消');
    return;
  }
  const chosen = sel.items.map((i) => rows[i - 1]);

  // 7) 已同步版本 → 询问强制重跑 / 跳过
  for (const item of chosen) {
    if (!item.known) continue;
    let ans = '';
    try {
      ans = await readLine(`  版本 ${item.version} 已同步过：[f] 强制重跑 / [s] 跳过（回车默认跳过）：`);
    } catch (e) {
      if (!(e instanceof InputEnded)) throw e;
    }
    item.force = /^f/i.test(ans.trim());
  }
  const todo = chosen.filter((x) => !x.known || x.force);
  const skipped = chosen.length - todo.length;
  if (!todo.length) {
    console.log('\n所选版本全部跳过（均已同步过），无事可做。');
    return;
  }

  // 8) git 操作
  console.log('\n同步完成后的 git 操作（GHA 完整流程 = 分软件提交 + push）：');
  console.log('  a) 提交 + 推送');
  console.log('  c) 仅本地提交（不推送）');
  console.log('  n) 不提交（只写 data/down 文件）');
  let gitMode = '';
  try {
    gitMode = (await readLine('请选择（回车默认 a）：')).trim().toLowerCase();
  } catch (e) {
    if (!(e instanceof InputEnded)) throw e;
  }
  if (!['a', 'c', 'n'].includes(gitMode)) gitMode = 'a';

  // 9) 摘要确认
  console.log('\n================ 执行计划 ================');
  console.log(` 仓库      ：${repo}`);
  console.log(` 软件 id   ：${sw.softwareId}（${sw.mode} 模式${sw.assetFilter ? `，资产过滤 ${sw.assetFilter}` : '，不过滤资产'}）`);
  console.log(` 待同步版本：${todo.map((t) => t.version + (t.force ? '（强制重跑）' : '')).join('、')}`);
  if (skipped) console.log(` 跳过版本  ：${skipped} 个（已同步）`);
  console.log(` git 操作  ：${GIT_MODE_TEXT[gitMode]}`);
  console.log(` 登录账号  ：${user}（登录需解 PoW，可能耗时数十秒）`);
  console.log('==========================================');
  let confirm = '';
  try {
    confirm = await readLine('回车开始同步；输入 n 取消：');
  } catch (e) {
    if (!(e instanceof InputEnded)) throw e;
    confirm = 'n';
  }
  if (/^n/i.test(confirm.trim())) {
    console.log('已取消');
    return;
  }

  // 10) 执行
  await runSync({ sw, entries, todo, gitMode, user, password });
}

main().catch((e) => {
  if (e instanceof InputEnded) {
    console.log('\n已取消：输入结束');
    process.exitCode = 1;
    return;
  }
  process.exitCode = 1;
});