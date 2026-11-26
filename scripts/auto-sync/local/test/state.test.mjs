// state.test.mjs — state.json 读写、结果记账、通知累积计数
//
// 对应设计文档 §20.1 / §20.2 与 PROTOCOL.md §5：
//   · 损坏 JSON → 备份 + 恢复默认值（记录错误，不静默清空）
//   · totalRuns 每轮只 +1（全局只在一处记账）
//   · stats / lastRun / nextRunAt / 通知累积计数按轮更新
//   · 四种状态之外的 status 一律归一为 internal-error（绝不记为成功）
//   · 原子保存、落盘可读回
// 所有读写都在 os.tmpdir() 下的临时目录里做，**绝不碰真实 local/state.json**。

import { describe, test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  STATUS_VALUES,
  defaultState,
  normalizeState,
  loadState,
  saveState,
  recordResult,
  resetNotification,
} from '../modules/state.mjs';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'fdn-state-'));
let caseSeq = 0;

function freshFile(name = 'state.json') {
  caseSeq += 1;
  const dir = path.join(tmpRoot, `case-${caseSeq}`);
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, name);
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function listDir(file) {
  return fs.readdirSync(path.dirname(file));
}

/** 一个典型的「同步成功」结果（结构见 PROTOCOL §10） */
function successResult(over = {}) {
  return {
    status: 'success',
    startedAt: '2026-11-26T12:00:00.000Z',
    finishedAt: '2026-11-26T12:00:18.000Z',
    durationMs: 18000,
    message: '同步了 2 个资源，共 3 个版本',
    stats: { resources: 2, versions: 3 },
    error: null,
    ...over,
  };
}

after(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

describe('defaultState（PROTOCOL §5 结构）', () => {
  test('结构与契约一致：无虚假历史、计数全 0', () => {
    assert.deepEqual(defaultState(), {
      version: 1,
      locked: false,
      paused: false,
      totalRuns: 0,
      lastRun: null,
      nextRunAt: null,
      stats: { success: 0, 'up-to-date': 0, failure: 0, 'internal-error': 0 },
      notification: { pendingRuns: 0, success: 0, 'up-to-date': 0, failure: 0, 'internal-error': 0 },
    });
    // 首次同步前不得有任何虚构的上次同步信息（设计 §21）
    assert.equal(defaultState().lastRun, null);
  });

  test('每次返回新对象', () => {
    const a = defaultState();
    a.stats.success = 99;
    assert.equal(defaultState().stats.success, 0);
  });

  test('STATUS_VALUES 就是契约里的四种状态', () => {
    assert.deepEqual(STATUS_VALUES, ['success', 'up-to-date', 'failure', 'internal-error']);
  });
});

// ---------------------------------------------------------------------------
// 读盘
// ---------------------------------------------------------------------------

describe('loadState（PROTOCOL §5 损坏恢复）', () => {
  test('文件不存在 → 默认值、不报错、也不主动写盘', () => {
    const file = freshFile();
    const res = loadState(file);
    assert.deepEqual(res.state, defaultState());
    assert.equal(res.recovered, false);
    assert.equal(res.backup, null);
    assert.equal(res.error, null);
    assert.equal(fs.existsSync(file), false, 'loadState 不负责落盘');
  });

  test('JSON 损坏 → 备份 *.corrupt-*、恢复默认、给出错误说明', () => {
    const file = freshFile();
    fs.writeFileSync(file, '{"totalRuns": 3, oops}', 'utf8');

    const res = loadState(file);
    assert.equal(res.recovered, true);
    assert.deepEqual(res.state, defaultState(), '损坏后回到干净默认值（不虚构历史）');
    assert.match(res.error, /状态文件损坏/);
    assert.match(res.error, /已备份并恢复默认值/);

    const backups = listDir(file).filter((n) => n.startsWith('state.json.corrupt-'));
    assert.equal(backups.length, 1);
    assert.match(backups[0], /^state\.json\.corrupt-\d{8}-\d{6}$/);
    assert.equal(res.backup, path.join(path.dirname(file), backups[0]));
    assert.equal(fs.readFileSync(res.backup, 'utf8'), '{"totalRuns": 3, oops}');
  });

  test('读取失败（路径是目录）→ 默认值 + 可读错误，不抛异常', () => {
    const dir = path.join(tmpRoot, 'state-as-dir');
    fs.mkdirSync(dir, { recursive: true });
    const res = loadState(dir);
    assert.equal(res.recovered, false);
    assert.match(res.error, /无法读取状态文件/);
    assert.deepEqual(res.state, defaultState());
  });
});

// ---------------------------------------------------------------------------
// 归一化
// ---------------------------------------------------------------------------

describe('normalizeState（字段缺失/类型不对都不抛）', () => {
  test('字符串布尔与负数计数被纠正', () => {
    const s = normalizeState({
      locked: 'true',
      paused: 'false',
      totalRuns: '-3',
      stats: { success: '5', failure: 2.9 },
      notification: { pendingRuns: 'x' },
    });
    assert.equal(s.locked, true);
    assert.equal(s.paused, false);
    assert.equal(s.totalRuns, 0, '负数计数归零');
    assert.equal(s.stats.success, 5);
    assert.equal(s.stats.failure, 2, '向下取整');
    assert.equal(s.notification.pendingRuns, 0);
  });

  test('lastRun 状态非法 → 丢弃 lastRun（不保留半截脏数据）', () => {
    assert.equal(normalizeState({ lastRun: { status: 'ok', message: 'x' } }).lastRun, null);
    assert.equal(normalizeState({ lastRun: 'not-an-object' }).lastRun, null);
  });

  test('lastRun 合法 → 字段被规范（缺的补空、错的归零）', () => {
    const s = normalizeState({
      lastRun: {
        status: 'failure',
        startedAt: '2026-11-26T12:00:00.000Z',
        finishedAt: '2026-11-26T12:00:18.000Z',
        durationMs: 18000,
        message: '远端拒绝',
        stats: { resources: 1, versions: 2 },
        error: { stage: 'push', code: 'GIT_PUSH_REJECTED', message: '远端拒绝了推送' },
      },
      nextRunAt: '2026-11-26T12:10:18.000Z',
    });
    assert.deepEqual(s.lastRun, {
      status: 'failure',
      startedAt: '2026-11-26T12:00:00.000Z',
      finishedAt: '2026-11-26T12:00:18.000Z',
      durationMs: 18000,
      message: '远端拒绝',
      stats: { resources: 1, versions: 2 },
      error: { stage: 'push', code: 'GIT_PUSH_REJECTED', message: '远端拒绝了推送' },
    });
    assert.equal(s.nextRunAt, '2026-11-26T12:10:18.000Z');

    const bare = normalizeState({ lastRun: { status: 'success' } });
    assert.equal(bare.lastRun.startedAt, null);
    assert.equal(bare.lastRun.durationMs, 0);
    assert.equal(bare.lastRun.message, '');
    assert.equal(bare.lastRun.stats, null);
    assert.equal(bare.lastRun.error, null);
  });

  test('非字符串 nextRunAt → null', () => {
    assert.equal(normalizeState({ nextRunAt: 12345 }).nextRunAt, null);
  });
});

// ---------------------------------------------------------------------------
// 结果记账
// ---------------------------------------------------------------------------

describe('recordResult（PROTOCOL §5「totalRuns 全局只在一处加一」）', () => {
  test('一次记账只让 totalRuns +1，并同步 stats/lastRun/nextRunAt/通知计数', () => {
    const base = defaultState();
    base.totalRuns = 11;
    base.stats = { success: 5, 'up-to-date': 6, failure: 0, 'internal-error': 0 };

    const nextRunAt = '2026-11-26T12:10:18.000Z';
    const s = recordResult(base, successResult(), nextRunAt);

    assert.equal(s.totalRuns, 12, '只加 1，不能重复记账');
    assert.deepEqual(s.stats, { success: 6, 'up-to-date': 6, failure: 0, 'internal-error': 0 });
    assert.equal(s.lastRun.status, 'success');
    assert.equal(s.lastRun.finishedAt, '2026-11-26T12:00:18.000Z');
    assert.equal(s.lastRun.durationMs, 18000);
    assert.deepEqual(s.lastRun.stats, { resources: 2, versions: 3 });
    assert.equal(s.nextRunAt, nextRunAt);
    // 通知累积计数 +1（发送成功后由 resetNotification 清零）
    assert.equal(s.notification.pendingRuns, 1);
    assert.equal(s.notification.success, 1);

    // 输入对象不被原地修改（recordResult 返回新状态）
    assert.equal(base.totalRuns, 11);
    assert.equal(base.lastRun, null);
  });

  test('四种合法状态各自累加到对应计数', () => {
    let s = defaultState();
    s = recordResult(s, successResult());
    s = recordResult(s, successResult({ status: 'up-to-date', stats: null, message: '当前已是最新' }));
    s = recordResult(s, successResult({ status: 'failure', error: { stage: 'push', code: 'X', message: 'y' } }));
    s = recordResult(s, successResult({ status: 'internal-error', error: { stage: 'state', code: 'Z', message: 'w' } }));
    assert.equal(s.totalRuns, 4);
    assert.deepEqual(s.stats, { success: 1, 'up-to-date': 1, failure: 1, 'internal-error': 1 });
    assert.equal(s.notification.pendingRuns, 4);
    assert.deepEqual(
      {
        success: s.notification.success,
        'up-to-date': s.notification['up-to-date'],
        failure: s.notification.failure,
        'internal-error': s.notification['internal-error'],
      },
      { success: 1, 'up-to-date': 1, failure: 1, 'internal-error': 1 },
    );
    assert.equal(s.lastRun.status, 'internal-error');
  });

  test('四种非法 status 一律归一到 internal-error（绝不记为成功）', () => {
    const illegal = ['ok', 'SUCCESS', 'error', ''];
    for (const status of illegal) {
      const s = recordResult(defaultState(), successResult({ status }));
      assert.equal(s.lastRun.status, 'internal-error', `status=${JSON.stringify(status)} 应归一为 internal-error`);
      assert.equal(s.stats['internal-error'], 1);
      assert.equal(s.stats.success, 0);
      assert.equal(s.notification['internal-error'], 1);
      assert.equal(s.totalRuns, 1);
    }
    // status 直接缺失也一样
    const missing = recordResult(defaultState(), { message: 'no status' });
    assert.equal(missing.lastRun.status, 'internal-error');
  });

  test('durationMs / message 非数值或非字符串时安全兜底', () => {
    const s = recordResult(defaultState(), successResult({ durationMs: 'slow', message: 42, startedAt: undefined }));
    assert.equal(s.lastRun.durationMs, 0);
    assert.equal(s.lastRun.message, '');
    assert.equal(s.lastRun.startedAt, null);
  });

  test('nextRunAt 缺省 → null（暂停/停止时不留陈旧计划时间）', () => {
    const s = recordResult(defaultState(), successResult());
    assert.equal(s.nextRunAt, null);
  });
});

// ---------------------------------------------------------------------------
// 通知计数清零
// ---------------------------------------------------------------------------

describe('resetNotification（只有发送成功才清零）', () => {
  test('累积计数全部归零，其它字段不受影响', () => {
    let s = recordResult(defaultState(), successResult());
    s = recordResult(s, successResult({ status: 'failure' }));
    s.totalRuns = 7;
    s.locked = true;
    s.paused = true;
    s.nextRunAt = '2026-11-26T12:20:00.000Z';

    const r = resetNotification(s);
    assert.deepEqual(r.notification, {
      pendingRuns: 0, success: 0, 'up-to-date': 0, failure: 0, 'internal-error': 0,
    });
    assert.equal(r.totalRuns, 7);
    assert.equal(r.locked, true);
    assert.equal(r.paused, true);
    assert.equal(r.nextRunAt, '2026-11-26T12:20:00.000Z');
    assert.equal(r.lastRun.status, 'failure', '清零不影响上次结果');
  });
});

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

describe('saveState（原子保存 + 可读回）', () => {
  test('写盘后 loadState 能原样读回', () => {
    const file = freshFile();
    let s = recordResult(defaultState(), successResult(), '2026-11-26T12:10:18.000Z');
    s.locked = true;
    s.paused = false;

    const saved = saveState(s, file);
    assert.equal(saved.ok, true);
    assert.equal(fs.existsSync(file), true);

    const back = loadState(file);
    assert.equal(back.recovered, false);
    assert.equal(back.error, null);
    assert.equal(back.state.totalRuns, 1);
    assert.equal(back.state.locked, true);
    assert.equal(back.state.lastRun.status, 'success');
    assert.deepEqual(back.state.stats, s.stats);
    assert.deepEqual(back.state.notification, s.notification);
    assert.equal(back.state.nextRunAt, '2026-11-26T12:10:18.000Z');
    // 目录里不留临时文件
    assert.deepEqual(listDir(file), ['state.json']);
  });

  test('保存时先归一化：非法字段不会落进文件', () => {
    const file = freshFile();
    const res = saveState({ totalRuns: 'abc', locked: 'yes', lastRun: { status: 'weird' } }, file);
    assert.equal(res.ok, true);
    const onDisk = readJson(file);
    assert.equal(onDisk.totalRuns, 0);
    assert.equal(onDisk.locked, false);
    assert.equal(onDisk.lastRun, null);
    assert.equal(onDisk.version, 1);
  });

  test('同一份状态重复保存是幂等的', () => {
    const file = freshFile();
    const s = recordResult(defaultState(), successResult());
    saveState(s, file);
    const first = fs.readFileSync(file, 'utf8');
    saveState(s, file);
    assert.equal(fs.readFileSync(file, 'utf8'), first);
  });
});
