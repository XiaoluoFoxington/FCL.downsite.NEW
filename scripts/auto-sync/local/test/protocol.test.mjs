// protocol.test.mjs — JSON Lines 协议纯函数：ASCII 转义 + 锁定权限矩阵 + 菜单状态行
//
// 对应 PROTOCOL.md §1.1（ASCII 安全输出）、§3.3（命令表与权限）、§5/§6（状态行文案）：
//   · toProtocolLine：整行纯 ASCII（中文/emoji/控制字符全部 \uXXXX 转义），JSON.parse 回来与原对象一致
//   · isCommandAllowed：未锁定全部允许；锁定时只有白名单允许（Node 端二次校验）
//   · buildStatusLines：尚未同步时不得虚构时间/结果（设计 §21 验收清单）
// 只 import main.mjs 的纯函数；被 import 时不会执行 main()（main.mjs 末尾有 invokedDirectly 判断）。

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';

import { toProtocolLine, isCommandAllowed, buildStatusLines, sessionStatusLine, ctx } from '../main.mjs';

const originalCtx = {
  config: ctx.config,
  state: ctx.state,
  scheduler: ctx.scheduler,
  locked: ctx.locked,
  paused: ctx.paused,
  running: ctx.running,
  stage: ctx.stage,
};

after(() => {
  Object.assign(ctx, originalCtx);
});

/** 造一个能解出签发时间的假会话 cookie（CONTEXT：session.mjs 的 base64url("<ts>|<载荷>|<HMAC>")） */
function fakeSessionCookie({ ageDays = 5 } = {}) {
  const ts = Math.floor(Date.now() / 1000) - ageDays * 86400;
  const body = Buffer.concat([
    Buffer.from(`${ts}|${'A'.repeat(24)}|`, 'latin1'),
    Buffer.alloc(24, 0x5a), // 24 字节 HMAC 占位（不校验签名，只解析结构）
  ]);
  return body.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ---------------------------------------------------------------------------
// §1.1 ASCII 安全协议行
// ---------------------------------------------------------------------------

describe('toProtocolLine（PROTOCOL §1.1：非 ASCII 一律 \\uXXXX 转义）', () => {
  test('中文与 emoji 全部转义，整行是纯 ASCII，JSON.parse 回来与原对象 deepEqual', () => {
    const message = {
      type: 'state',
      data: {
        statusLines: ['自启动后已同步：12 次', '上次结果：成功 · 用时 18 秒', '下次同步：本轮结束后安排'],
        tooltip: 'fdn-autosync-tray · 同步中 · Sync',
        emoji: '✅ 完成 😀🚀',
        nested: { 中文键: '值' },
      },
    };

    const line = toProtocolLine(message);

    // 1) 整行纯 ASCII（没有任何 >0x7e 的字符，也没有 0x7f DEL）
    for (let i = 0; i < line.length; i += 1) {
      const code = line.charCodeAt(i);
      assert.ok(code <= 0x7e && code >= 0x20, `第 ${i} 个字符 0x${code.toString(16)} 不是可打印 ASCII`);
    }
    assert.deepEqual([...line].filter((ch) => ch.charCodeAt(0) > 0x7e), []);

    // 2) 确实产生了 \uXXXX 转义，且没有残留中文
    assert.match(line, /\\u[0-9a-f]{4}/);
    assert.ok(!line.includes('自启动'));
    assert.ok(!line.includes('😀'));

    // 3) 反序列化后与原对象完全一致（emoji 的代理对也要还原）
    assert.deepEqual(JSON.parse(line), message);
  });

  test('含换行/制表/引号的字符串仍编译成单行（JSON Lines 每行一条）', () => {
    const obj = { type: 'notify', text: '第一行\n第二行\t带"引号"和反斜杠\\' };
    const line = toProtocolLine(obj);
    assert.equal(line.includes('\n'), false, '不能出现真实换行');
    assert.equal(line.includes('\t'), false, '不能出现真实制表符');
    assert.deepEqual(JSON.parse(line), obj);
  });

  test('纯 ASCII 对象不做多余转义（与 JSON.stringify 完全一致）', () => {
    const obj = { type: 'ack', id: 'c-7', ok: true, message: '', error: null, data: {} };
    assert.equal(toProtocolLine(obj), JSON.stringify(obj));
  });

  test('DEL（U+007F）与 BMP 边界字符也被转义', () => {
    const line = toProtocolLine({ a: '\u007f', b: '\uffff' });
    assert.ok(!line.includes('\u007f'));
    assert.equal(line, '{"a":"\\u007f","b":"\\uffff"}');
    assert.deepEqual(JSON.parse(line), { a: '\u007f', b: '\uffff' });
  });

  test('协议样例（§3.1 state）转义后仍是合法单行 JSON', () => {
    const state = {
      type: 'state',
      data: {
        locked: false, paused: false, running: true, stage: 'sync', hasRun: true, totalRuns: 12,
        lastRun: { status: 'success', finishedAt: '2026-11-26T12:00:18.000Z', durationMs: 18000, message: '同步完成' },
        nextRunAt: '2026-11-26T12:10:18.000Z',
        counts: { success: 5, 'up-to-date': 6, failure: 1, 'internal-error': 0 },
        statusLines: ['自启动后已同步：12 次', '当前状态：同步中（Sync）'],
        tooltip: 'fdn-autosync-tray · 同步中 · Sync',
      },
    };
    const line = toProtocolLine(state);
    assert.equal(line.split('\u000a').length, 1);
    assert.deepEqual(JSON.parse(line), state);
  });
});

// ---------------------------------------------------------------------------
// §3.3 权限矩阵
// ---------------------------------------------------------------------------

describe('isCommandAllowed（PROTOCOL §3.3 命令表与权限）', () => {
  const ALL_COMMANDS = [
    'get-status', 'get-detail', 'sync-now', 'sync-cancel', 'pause', 'resume', 'lock', 'unlock',
    'open', 'get-config', 'save-config', 'restart', 'exit', 'set-icon', 'reset-icon', 'repair-autostart',
  ];

  test('未锁定：全部命令都允许（含 open 的任意 target）', () => {
    for (const name of ALL_COMMANDS) {
      assert.equal(isCommandAllowed(name, { locked: false }), true, `未锁定应允许 ${name}`);
    }
    for (const target of ['log-folder', 'latest-log', 'project-dir', 'data-dir', 'sync-dir', 'config-file', 'whatever']) {
      assert.equal(isCommandAllowed('open', { locked: false, target }), true, `未锁定应允许 open ${target}`);
    }
    // 默认参数（不传 locked）等价于未锁定
    assert.equal(isCommandAllowed('save-config'), true);
    assert.equal(isCommandAllowed('save-config', {}), true);
  });

  test('锁定时允许：get-status / get-detail / sync-now / sync-cancel / unlock', () => {
    for (const name of ['get-status', 'get-detail', 'sync-now', 'sync-cancel', 'unlock']) {
      assert.equal(isCommandAllowed(name, { locked: true }), true, `锁定应仍允许 ${name}`);
    }
  });

  test('锁定时允许 open 仅限 log-folder / latest-log', () => {
    assert.equal(isCommandAllowed('open', { locked: true, target: 'log-folder' }), true);
    assert.equal(isCommandAllowed('open', { locked: true, target: 'latest-log' }), true);
  });

  test('锁定时拒绝：pause / resume / get-config / save-config / set-icon / reset-icon / restart / exit', () => {
    for (const name of ['pause', 'resume', 'get-config', 'save-config', 'set-icon', 'reset-icon', 'restart', 'exit']) {
      assert.equal(isCommandAllowed(name, { locked: true }), false, `锁定应拒绝 ${name}`);
    }
  });

  test('锁定时拒绝 open project-dir / config-file / data-dir / sync-dir（以及未知 target）', () => {
    for (const target of ['project-dir', 'config-file', 'data-dir', 'sync-dir', '', 'unknown']) {
      assert.equal(isCommandAllowed('open', { locked: true, target }), false, `锁定应拒绝 open ${target}`);
    }
  });

  test('锁定时也拒绝 lock / repair-autostart / 未知命令（白名单之外一律拒绝）', () => {
    assert.equal(isCommandAllowed('lock', { locked: true }), false);
    assert.equal(isCommandAllowed('repair-autostart', { locked: true }), false);
    assert.equal(isCommandAllowed('rm -rf', { locked: true }), false);
    assert.equal(isCommandAllowed('', { locked: true }), false);
  });

  test('target 大小写/空白不放行（严格匹配）', () => {
    assert.equal(isCommandAllowed('open', { locked: true, target: 'LOG-FOLDER' }), false);
    assert.equal(isCommandAllowed('open', { locked: true, target: ' log-folder ' }), false);
  });
});

// ---------------------------------------------------------------------------
// §5 / §6 菜单状态行
// ---------------------------------------------------------------------------

describe('buildStatusLines（PROTOCOL §6 菜单状态区，Node 排版好宿主原样显示）', () => {
  function reset(over = {}) {
    ctx.config = { credentials: { H1111_SESSION: '' } };
    ctx.state = {
      totalRuns: 0,
      lastRun: null,
      stats: { success: 0, 'up-to-date': 0, failure: 0, 'internal-error': 0 },
    };
    ctx.scheduler = null;
    ctx.locked = false;
    ctx.paused = false;
    ctx.running = false;
    ctx.stage = null;
    Object.assign(ctx, over);
  }

  test('尚未同步：诚实文本，不虚构时间与结果', () => {
    reset();
    const lines = buildStatusLines();
    assert.equal(lines[0], '自启动后已同步：0 次');
    assert.equal(lines[1], '当前状态：空闲');
    assert.ok(lines.includes('上次同步：尚未同步'));
    assert.ok(lines.includes('上次结果：—'));
    assert.ok(lines.includes('下次同步：未安排'));
    // 任何一行都不该出现看起来像时间戳的东西
    for (const line of lines) assert.ok(!/\d{4}-\d{2}-\d{2}/.test(line), `不得虚构时间：${line}`);
    assert.ok(!lines.some((l) => l.includes('null') || l.includes('undefined') || l.includes('NaN')));
  });

  test('有历史结果：显示次数、上次时间、结果与用时', () => {
    reset({
      state: {
        totalRuns: 12,
        lastRun: {
          status: 'success',
          startedAt: '2026-11-26T12:00:00.000Z',
          finishedAt: '2026-11-26T12:00:18.000Z',
          durationMs: 18000,
          message: '同步了 2 个资源，共 3 个版本',
        },
      },
    });
    const lines = buildStatusLines();
    assert.equal(lines[0], '自启动后已同步：12 次');
    const lastSync = lines.find((l) => l.startsWith('上次同步：'));
    const lastResult = lines.find((l) => l.startsWith('上次结果：'));
    assert.match(lastSync, /^上次同步：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.equal(lastResult, '上次结果：成功 · 用时 18 秒');
    assert.ok(lines.includes('下次同步：未安排'));
  });

  test('失败结果的文案（失败 + 用时）与内部错误文案', () => {
    reset({
      state: {
        totalRuns: 3,
        lastRun: { status: 'failure', finishedAt: '2026-11-26T12:00:00.000Z', durationMs: 61000 },
      },
    });
    assert.equal(buildStatusLines().find((l) => l.startsWith('上次结果：')), '上次结果：失败 · 用时 1 分 1 秒');

    reset({
      state: {
        totalRuns: 3,
        lastRun: { status: 'internal-error', finishedAt: '2026-11-26T12:00:00.000Z', durationMs: 0 },
      },
    });
    assert.equal(
      buildStatusLines().find((l) => l.startsWith('上次结果：')),
      '上次结果：内部错误',
      'durationMs=0 时不显示用时',
    );
  });

  test('运行中：当前状态显示阶段中文名，下次同步显示「本轮结束后安排」', () => {
    reset({ running: true, stage: 'sync' });
    const lines = buildStatusLines();
    assert.equal(lines[1], '当前状态：同步中（Sync）');

    reset({ running: true, stage: 'prepare' });
    assert.equal(buildStatusLines()[1], '当前状态：同步中（准备）');

    reset({ paused: true });
    assert.equal(buildStatusLines()[1], '当前状态：已暂停');
    assert.ok(buildStatusLines().includes('下次同步：未安排（已暂停）'));
  });

  test('有调度器时下次同步时间取自 scheduler.getStatus().nextRunAt', () => {
    const nextRunAt = new Date(Date.now() + 10 * 60 * 1000).toISOString();
    reset({ scheduler: { getStatus: () => ({ nextRunAt }) } });
    const line = buildStatusLines().find((l) => l.startsWith('下次同步：'));
    assert.match(line, /^下次同步：\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    assert.ok(!line.includes('未安排'));
  });

  test('状态行不含任何凭据（用假会话值验证）', () => {
    reset({
      config: { credentials: { H1111_SESSION: fakeSessionCookie({ ageDays: 5 }) } },
    });
    const lines = buildStatusLines();
    const sessionLine = lines.find((l) => l.startsWith('会话：'));
    assert.ok(sessionLine, '状态区应有一行会话状态');
    for (const line of lines) {
      assert.ok(!line.includes(ctx.config.credentials.H1111_SESSION), '状态行泄露了会话 cookie 原文');
    }
    assert.match(sessionLine, /^会话：剩 \d+ 天$/);
  });
});

describe('sessionStatusLine（PROTOCOL §5：只显示天数/是否失效，绝不显示 cookie 值）', () => {
  test('未配置 → 明确说明未配置', () => {
    ctx.config = { credentials: { H1111_SESSION: '' } };
    assert.equal(sessionStatusLine(), '会话：未配置（H1111_SESSION 为空）');
    ctx.config = { credentials: { H1111_SESSION: '   ' } };
    assert.equal(sessionStatusLine(), '会话：未配置（H1111_SESSION 为空）');
  });

  test('无法解析的假值 → 「已配置（无法解析到期时间）」，且不回显原值', () => {
    ctx.config = { credentials: { H1111_SESSION: 'FAKE-SESSION-VALUE-abcdef' } };
    const line = sessionStatusLine();
    assert.equal(line, '会话：已配置（无法解析到期时间）');
    assert.ok(!line.includes('FAKE-SESSION-VALUE'));
  });

  test('已过期（60 天前签发）→ 提示更新，不显示 cookie 值', () => {
    const cookie = fakeSessionCookie({ ageDays: 61 });
    ctx.config = { credentials: { H1111_SESSION: cookie } };
    const line = sessionStatusLine();
    assert.match(line, /^会话：(已过期|已失效)/);
    assert.ok(!line.includes(cookie));
    assert.ok(line.includes('H1111_SESSION'), '应引导用户更新哪个字段');
  });
});
