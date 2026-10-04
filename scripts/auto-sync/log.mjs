// log.mjs — 线路1 自动同步：统一分层日志（全仓唯一日志出口）
//
// 设计取舍：
//   · 分层：section（顶级阶段标题）/ group(title)+end()（可折叠分组，维护缩进层级）/
//           info / ok / detail（比 info 更深一级）/ warn / fail
//   · 缩进：行首按当前分组层级缩进（两空格一级），**不加时间戳**，避免噪声
//   · GHA 感知：ENV.IS_GHA 为真时用 ::group::/::endgroup:: 折叠、::warning::/::error::
//     发注解；非 GHA（本地手动）降级为普通标题/分隔行，绝不发 GHA 指令
//   · 绝不重复：每个事件只输出一次。warn/fail 在 GHA 直接用注解承载（注解行本身即含消息），
//     不再另起一行同义日志；非 GHA 才打印带符号的人读行
//   · 概览：summary(mdLine) 收集 + flush() 追加到 $GITHUB_STEP_SUMMARY（只放概览，不放详细日志）
//   · 作用域捕获：capture(fn) 收集该作用域内的人读日志行，作为每软件 commit body
//
// 约定：section 会归零缩进层级并安全收束已打开的分组；每次 group() 必须配对 end()。

import { appendFileSync } from 'node:fs';

import { ENV } from './config.mjs';

const UNIT = '  '; // 每级缩进

let level = 0;            // 当前分组层级（section 归零，group +1，end -1）
const openGroups = [];    // 已打开分组栈（仅用于校验 end 配对，避免 ::endgroup:: 不成对）
let captureBuffer = null; // 捕获缓冲区；null 表示未在捕获
const summaryLines = [];  // $GITHUB_STEP_SUMMARY 收集

// 人读行：缩进 + 前缀 + 消息
const humanLine = (indentLevel, prefix, msg) =>
  UNIT.repeat(Math.max(0, indentLevel)) + prefix + String(msg);

// 普通行：打印到 console，并（若在捕获中）计入 commit body
function out(line) {
  console.log(line);
  if (captureBuffer) captureBuffer.push(line);
}

export const log = {
  // 顶级阶段标题
  section(title) {
    while (openGroups.length) this.end(); // 防御：先收束未闭合分组，保证 ::endgroup:: 配对
    level = 0;
    out(`\n=== ${title} ===`);
  },

  // 可折叠分组：GHA → ::group::，本地 → 普通标题行；随后缩进 +1
  group(title) {
    const human = humanLine(level, '▸ ', title);
    if (ENV.IS_GHA) {
      console.log(`::group::${title}`);   // GHA 指令不加缩进
      if (captureBuffer) captureBuffer.push(human); // commit body 用人读形式
    } else {
      out(human);
    }
    openGroups.push(title);
    level += 1;
  },

  // 结束当前分组（无打开分组时静默忽略，避免多余的 ::endgroup::）
  end() {
    if (!openGroups.length) return;
    openGroups.pop();
    level = Math.max(0, level - 1);
    if (ENV.IS_GHA) console.log('::endgroup::');
  },

  info(msg) {
    out(humanLine(level, '', msg));
  },

  ok(msg) {
    out(humanLine(level, '✓ ', msg));
  },

  // 比当前层级再深一级
  detail(msg) {
    out(humanLine(level + 1, '· ', msg));
  },

  // GHA → ::warning::（注解即人读信息）；本地 → ⚠ 行
  warn(msg) {
    if (ENV.IS_GHA) {
      console.log(`::warning::${msg}`);
      if (captureBuffer) captureBuffer.push(humanLine(level, '⚠ ', msg));
    } else {
      out(humanLine(level, '⚠ ', msg));
    }
  },

  // GHA → ::error::（注解即人读信息）；本地 → ✖ 行
  fail(msg) {
    if (ENV.IS_GHA) {
      console.log(`::error::${msg}`);
      if (captureBuffer) captureBuffer.push(humanLine(level, '✖ ', msg));
    } else {
      out(humanLine(level, '✖ ', msg));
    }
  },

  // 汇总页收集（只放概览）
  summary(mdLine) {
    summaryLines.push(String(mdLine));
  },

  // 落盘概览；无 $GITHUB_STEP_SUMMARY 或无事收集时静默跳过
  flush() {
    const target = process.env.GITHUB_STEP_SUMMARY;
    if (!target || !summaryLines.length) return;
    try {
      appendFileSync(target, summaryLines.join('\n') + '\n');
    } catch {
      /* 汇总落盘失败不影响主流程 */
    }
  },

  // 作用域捕获：执行 fn（可 async），期间的人读日志行收集为数组返回
  async capture(fn) {
    const prev = captureBuffer;
    const buf = [];
    captureBuffer = buf;
    try {
      await fn();
    } finally {
      captureBuffer = prev;
    }
    return buf;
  },
};