// logger.mjs — 线路1 自动同步：唯一日志实现（2026-10 全量重构，与旧 ctx 无任何继承关系）
//
// 设计目标（用户要求）：
//   ① 详细明了           → 关键事实逐条列出，不省略 URL / 字节数 / 版本号
//   ② 结构清晰的缩进     → 树形前缀由 logger 按嵌套自动推导，调用方不手写空格
//   ③ 保留提交正文带日志 → 作用域内自动收集正文行，供 commit body 使用
//   ④ 不在末尾重复整份日志
//   ⑤ 每行不带时间戳（GitHub Actions 自带每行时间）
//   ⑥ 不用 ::group:: 折叠分组
//
// 三个互不重复的输出面：
//   · run     —— 控制台逐行输出，唯一的运行日志（没有末尾重打、没有折叠分组）
//   · commit  —— 每个软件作用域内自动累积的提交正文（干净重建，无过程噪声）
//   · summary —— GITHUB_STEP_SUMMARY 汇总表（Actions 首页概览，与 run 日志分工不同）
//
// ============================ 缩进模型 ============================
//
// 作用域树，**每一行都是一个树节点**，都有分支符：
//
//   标题   prefix + '├─ '            作用域标题（画在本级）
//   正文   prefix + '│  ├─ '         普通行（比标题深一级）
//   清单   prefix + '│  │  · '        items()：再深一级的清单项，'·' 与 '├─' 区分
//   结论   prefix + '│  └─ '          close()：本作用域最后一行
//
// 其中 prefix = '│  ' × (depth - 1)，即所有祖先的续行竖线。
// 根作用域（depth 0）没有树线，散行一律平铺（如开头的标题行与结尾的总用时）。
//
// ⚠ 为什么这样是"流式安全"的（GHA 日志非 TTY，无法 \r 回改已输出的行）：
//   '└─' 只出现在 close() —— 那一刻**在定义上**就是本作用域的最后一行，无需预知未来。
//   普通行用 '├─' 是因为后面确实还可能有内容，这与真实树结构一致。
//   祖先竖线统一画 '│  '（不断言"祖先之后还有没有兄弟"），这是树形输出的通行做法；
//   代价仅仅是最后一个分支下方仍有一条竖线 —— 稳定、可预期，且永不回改。
//
// 例：
//
//   线路1 自动同步 · 7 个软件
//   ├─ 阶段 1：预探测候选
//   │  ├─ 资源 id=0（FCL-Team/FoldCraftLauncher）
//   │  │  ├─ 数据源最新版本：1.3.3.7
//   │  │  ├─ 落后 1 个版本：1.3.3.8
//   │  │  └─ ✅ 需同步 1 个版本
//   │  └─ ✅ 阶段 1 完成｜用时 3.6s
//   └─ 总用时 3.6s｜结果：全部成功

import { appendFileSync } from 'node:fs';

// ============================ 格式化工具 ============================

export function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = Math.round((ms % 60_000) / 1000);
  return `${m}m${s}s`;
}

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v < 0) return '?';
  let x = v;
  let u = 0;
  while (x >= 1024 && u < BYTE_UNITS.length - 1) { x /= 1024; u += 1; }
  return u === 0 ? `${Math.round(x)} B` : `${x.toFixed(1)} ${BYTE_UNITS[u]}`;
}

// UTC+8 展示：Release 发布时间等人类可读场合用；日志行本身一律不带时间戳
export function fmtCST(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '（时间未知）';
  const shifted = new Date(d.getTime() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${shifted.getUTCFullYear()}-${p(shifted.getUTCMonth() + 1)}-${p(shifted.getUTCDate())} ` +
    `${p(shifted.getUTCHours())}:${p(shifted.getUTCMinutes())}`;
}

// markdown 表格单元格转义（换行 → <br>，竖线 → \|）
export function mdCell(v) {
  const s = String(v ?? '').replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|').trim();
  return s || '—';
}

// 统一错误描述（多行错误压成单行，避免打乱缩进）
export function errText(e) {
  if (!e) return '未知错误';
  return String(e.message || e).replace(/\s*\n+\s*/g, ' / ').trim() || '未知错误';
}

// ============================ 作用域 ============================

export class Scope {
  constructor(logger, parent, title, { commit = true } = {}) {
    this.logger = logger;
    this.parent = parent;
    this.title = title;
    // 本作用域（含子树）是否进提交正文。根作用域自身为 true，
    // 但顶层散行由 Logger.line() 直接输出、不经作用域缓冲 → 不会混进提交正文。
    this.commit = commit;
    this.open = true;
    this.startedAt = Date.now();
    this.endedAt = null;
    this._depth = parent ? parent._depth + 1 : 0;
    this._closed = false;
    this._children = [];
    // 提交正文条目：直接登记到 logger 的**全局有序流**里（而不是各自攒各自的），
    // 这样正文顺序 = 实际发生顺序，父子小节天然交错，无需事后重排。
    this._bodySeq = logger ? logger._bodySeq : { v: 0 };
    this._bodyStart = logger ? logger._body.length : 0;
    this._bodyEnd = -1;          // 关闭时写入全局正文流里的结束下标
  }

  // 每层祖先贡献 3 列续线；根（depth 0）不贡献。
  // 标题画在 _prefix()；正文/结论/清单项都画在 _prefix() + '│  '（即"缩进一级"）。
  _prefix() { return '│  '.repeat(Math.max(0, this._depth - 1)); }
  _indent() { return `${this._prefix()}│  `; }

  // 普通行：与所属标题同级缩进后，再画 '├─'（后面还可能有内容）
  line(msg, opts = {}) { this.logger._write(this, msg, this._kind('body'), opts); return this; }

  // 清单项：比普通行再深一层，用 '·' 与 '├─' 区分（适合 URL / 文件名列表）
  items(lines, opts = {}) {
    for (const l of (Array.isArray(lines) ? lines : [lines])) {
      this.logger._write(this, l, this._kind('item'), opts);
    }
    return this;
  }
  // 根作用域没有树线，一律平铺
  _kind(fallback) { return this.parent ? fallback : 'root'; }
  ok(msg, opts = {}) { this.logger._write(this, msg, this._kind('body'), opts); return this; }
  warn(msg, opts = {}) { this.logger._write(this, msg, this._kind('body'), { ...opts, kind: 'warn' }); return this; }
  fail(msg, opts = {}) { this.logger._write(this, msg, this._kind('body'), { ...opts, kind: 'fail' }); return this; }

  child(title, opts = {}) {
    if (this._closed) throw new Error(`作用域已关闭，不能再开子作用域：${this.title}`);
    return this.logger._open(this, title, opts);
  }

  // 关键步骤：开打标题，结束补 ✅/❌ + 用时结论
  async step(title, fn, opts = {}) {
    const s = this.child(title, opts);
    const t0 = Date.now();
    try {
      const out = await fn(s);
      s.close(`✅ ${opts.done || '完成'}｜用时 ${fmtDur(Date.now() - t0)}`);
      return out;
    } catch (e) {
      s.close(`❌ ${opts.failed || '失败'}｜用时 ${fmtDur(Date.now() - t0)}`, { kind: 'fail' });
      throw e;
    }
  }

  // 关闭：打 '└─ ' 结论行；根作用域则直接平铺；重复关闭忽略
  close(text, { kind = 'ok', body = true } = {}) {
    if (this._closed) return this;
    this._closed = true;
    this.open = false;
    this.endedAt = Date.now();
    if (text != null) this.logger._write(this, text, this._kind('close'), { kind, body });
    // 记录本作用域在全局正文流里的结束位置（含刚打的结论行）
    if (this._bodyEnd < 0) this._bodyEnd = this.logger._body.length;
    return this;
  }

  // 整段从提交正文里剔除：run 日志照旧，但正文里不留这个空壳小节。
  // 用途：进入作用域时还不知道会不会有事发生（如「保留清理」可能无事可做），
  // 事后确认无事时把这一节抹掉，避免正文出现只有标题、没有内容的空小节。
  dropFromBody() {
    const all = this.logger._body;
    const end = this._bodyEnd >= 0 ? this._bodyEnd : all.length;
    for (let i = this._bodyStart; i < end; i += 1) all[i].body = false;
    return this;
  }

  // ---- 提交正文：本作用域整棵树，按**实际发生顺序** ----
  // logger 维护一个全局有序流，每条可入正文的日志行都带自己所属作用域的 depth 与 kind。
  // 这里只截取 [本作用域起点, 结束) 这一段，并把 depth 归一化成相对缩进。
  // 于是「父的前言 → 子小节 → 父的后续」这种交错能被原样保留。
  //
  // 缩进规则（2 空格一级，适合 git log 阅读，比树线更省横向空间）：
  //   作用域标题           → 本级
  //   该作用域的正文/结论   → 本级 + 1
  //   清单项（items）      → 本级 + 2，并保留 '·' 前缀（与正文行区分）
  collectBody() {
    if (!this.commit) return [];
    const all = this.logger._body;
    const start = this._bodyStart;
    // 作用域关闭时会把结束位置记录下来；未关闭则取到当前末尾
    const end = this._bodyEnd >= 0 ? this._bodyEnd : all.length;
    const base = this._depth;
    const out = [];
    for (let i = start; i < end; i += 1) {
      const e = all[i];
      if (e.body === false) continue;
      const rel = (e.depth - base)
        + (e.kind === 'open' ? 0 : 1)     // 正文/结论比所属标题深一级
        + (e.kind === 'item' ? 1 : 0);    // 清单项再深一级
      const bullet = e.kind === 'item' ? '· ' : '';
      out.push('  '.repeat(Math.max(0, rel)) + bullet + e.text);
    }
    return out;
  }
}

// ============================ Logger ============================

export class Logger {
  constructor({ echo = true, rootTitle = null } = {}) {
    this.echo = echo;
    this.lines = [];        // run 日志全文（供测试/导出；绝不二次输出）
    this.summaryRows = [];  // GITHUB_STEP_SUMMARY 行
    this.failed = false;
    this.warned = false;
    this.createdAt = Date.now();
    this._body = [];        // 全局提交正文流：{ text, depth, isTitle, body, commit }
    this._bodySeq = { v: 0 };
    this.root = new Scope(this, null, rootTitle, { commit: true });
    if (rootTitle != null) this._write(this.root, rootTitle, 'root');
  }

  line(msg) { this.root.line(msg); return this; }
  child(title, opts) { return this.root.child(title, opts); }
  items(lines) { this.root.items(lines); return this; }
  step(title, fn, opts) { return this.root.step(title, fn, opts); }
  ok(msg) { this.root.ok(msg); return this; }
  warn(msg) { this.root.warn(msg); return this; }
  fail(msg) { this.root.fail(msg); return this; }

  _open(parent, title, opts = {}) {
    const scope = new Scope(this, parent, title, { commit: opts.commit ?? parent.commit });
    parent._children.push(scope);
    this._write(scope, title, 'open');
    return scope;
  }

  // kind: 'root' | 'open' | 'body' | 'item' | 'close'；opts.body=false → 该行只进 run 日志
  //
  // 每一行都是树节点，都有分支符：
  //   open   prefix + '├─ '        作用域标题（画在本级）
  //   body   prefix + '│  ├─ '     普通行（缩进一级）
  //   item   prefix + '│  │  · '   清单项（缩进两级）
  //   close  prefix + '│  └─ '     作用域最后一行（缩进一级）
  _write(scope, msg, kind, { kind: level = null, body = true } = {}) {
    const text = String(msg ?? '');
    const base = scope._prefix();
    const deep = scope._indent();
    const pre = kind === 'root' ? ''
      : kind === 'open' ? `${base}├─ `
        : kind === 'close' ? `${deep}└─ `
          : kind === 'item' ? `${deep}│  · `
            : `${deep}├─ `;
    for (const seg of text.split('\n')) {
      const rendered = (pre + seg).replace(/\s+$/, '');
      this.lines.push(rendered);
      if (this.echo) process.stdout.write(rendered + '\n');
    }
    if (level === 'fail') this.failed = true;
    if (level === 'warn') this.warned = true;
    // 登记到全局提交正文流（根作用域的标题/散行 commit=false，不会进任何软件的正文）
    if (kind !== 'root' && scope.commit) {
      this._body.push({ text, depth: scope._depth, kind, body });
    }
    return this;
  }

  // GHA 注解（只发注解，不再抄一遍日志正文）
  annotate(level, message) {
    if (process.env.GITHUB_ACTIONS === 'true') {
      const esc = String(message).replace(/%/g, '%25').replace(/\r?\n/g, '%0A');
      process.stdout.write(`::${level}::${esc}\n`);
    }
    return this;
  }

  // 汇总页
  // 汇总页：接受字符串（按行拆）或字符串数组（如 renderSoftwareTable 的返回值）
  summary(text) {
    const arr = Array.isArray(text) ? text : String(text ?? '').split('\n');
    for (const l of arr) this.summaryRows.push(String(l));
    return this;
  }

  flushSummary() {
    const p = process.env.GITHUB_STEP_SUMMARY;
    if (!p || !this.summaryRows.length) return;
    try { appendFileSync(p, this.summaryRows.join('\n') + '\n'); } catch { /* 汇总页失败不影响主流程 */ }
  }

  elapsed() { return Date.now() - this.createdAt; }
  text() { return this.lines.join('\n'); }
}

// ============================ 汇总表 ============================

// 逐软件结果（run 日志与汇总页共用同一份事实，避免两处各写一遍）
export function newRow(id, sw = {}) {
  return {
    id,
    repo: sw.githubRepo || '—',
    sourceLatest: '—',
    sourceCount: 0,
    releaseCount: 0,
    candidates: [],
    guarded: [],
    taken: [],
    pruned: [],
    result: '—',
    startedAt: Date.now(),
    endedAt: null,
  };
}

// 详细汇总表：一软件一行，各列给出可核对的事实
export function renderSoftwareTable(rows, { title, extra = [] } = {}) {
  const out = [];
  if (title) { out.push(`### ${title}`); out.push(''); }
  out.push('| 资源 id | 仓库 | 数据源最新 | 数据源条目 | GitHub Release | 落后版本 | 本次同步 | 保留清理 | 结果 | 用时 |');
  out.push('|---:|---|---|---:|---:|---|---|---|---|---:|');
  for (const r of rows) {
    out.push(
      `| ${r.id} | ${mdCell(r.repo)} | ${mdCell(r.sourceLatest)} | ${mdCell(r.sourceCount)} | ` +
      `${mdCell(r.releaseCount)} | ${mdCell(r.candidates.length ? r.candidates.join('<br>') : '—')} | ` +
      `${mdCell(r.taken.length ? r.taken.join('<br>') : '—')} | ` +
      `${mdCell(r.pruned.length ? r.pruned.join('<br>') : '—')} | ${mdCell(r.result)} | ` +
      `${fmtDur((r.endedAt || Date.now()) - r.startedAt)} |`,
    );
  }
  out.push('');
  for (const e of extra) out.push(e);
  out.push('');
  return out;
}
