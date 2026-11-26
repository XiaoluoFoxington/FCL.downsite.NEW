// scheduler.test.mjs — 调度：间隔基准、暂停/恢复、互斥、唤醒补跑
//
// 对应设计文档 §20.2「调度测试」与 PROTOCOL.md §4（intervalMinutes 语义）：
//   · 同步间隔从**本轮结束时间**起算（12:00 开始、12:01 结束、间隔 10 → 12:11）
//   · 暂停后不再自动同步；恢复后从当前时间重新安排
//   · 手动同步不受暂停限制，但暂停期间同步完不安排下一轮
//   · 同步中重复触发被拒绝（{ok:false, reason:'running'}）
//   · 任务结束后重新安排下一轮；休眠唤醒最多补跑一轮
//   · 开机后立即同步 / 不立即同步（start.runOnStart）
// 全部用**假时钟 + 假定时器**注入，不依赖真实时间、不真实等待。

import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { createScheduler } from '../modules/scheduler.mjs';

const MINUTE = 60 * 1000;
const T0 = Date.UTC(2026, 10, 26, 4, 0, 0); // 固定基准时刻（本地无关）

/** 假时钟：只有显式 advance 才前进 */
function fakeClock(start = T0) {
  const clock = {
    t: start,
    now: () => clock.t,
    advance(ms) { clock.t += ms; },
  };
  return clock;
}

/** 假定时器：记录每次 setTimeout 的延迟，可手动触发最新一个 */
function fakeTimers() {
  let seq = 0;
  const active = new Map();
  const history = [];
  return {
    setTimeout(fn, delay) {
      seq += 1;
      active.set(seq, { fn, delay });
      history.push({ id: seq, delay });
      return seq;
    },
    clearTimeout(handle) { active.delete(handle); },
    get count() { return active.size; },
    get lastDelay() { return history.length ? history[history.length - 1].delay : null; },
    get pendingDelays() { return [...active.values()].map((e) => e.delay); },
    /** 触发当前最新的一个定时器（模拟到点） */
    fireLatest() {
      const ids = [...active.keys()];
      assert.ok(ids.length > 0, '没有待触发定时器');
      const id = ids[ids.length - 1];
      const entry = active.get(id);
      active.delete(id);
      entry.fn();
      return id;
    },
    history,
  };
}

const flush = async (rounds = 6) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((r) => setImmediate(r));
};

/**
 * 组装一台被测调度器。
 * @param {{intervalMinutes?:number, catchUpOnWake?:boolean, roundMs?:number,
 *          runRoundImpl?:(trigger:string)=>Promise<object>}} [opts]
 */
function harness(opts = {}) {
  const {
    intervalMinutes = 10,
    catchUpOnWake = true,
    roundMs = 0,
    runRoundImpl = async () => ({ status: 'success', message: '同步完成' }),
  } = opts;

  const clock = fakeClock();
  const timers = fakeTimers();
  const config = { scheduler: { intervalMinutes, catchUpOnWake } };
  const calls = [];
  const states = [];
  let impl = runRoundImpl;

  const runRound = async (trigger) => {
    calls.push(trigger);
    if (roundMs) clock.advance(roundMs); // 模拟这一轮耗时
    return impl(trigger);
  };

  const scheduler = createScheduler({
    config,
    runRound,
    onState: (s) => states.push({ ...s }),
    log: { info() {}, warn() {}, error() {} },
    now: clock.now,
    timers,
  });

  return {
    clock, timers, config, calls, states, scheduler,
    setImpl(fn) { impl = fn; },
  };
}

const iso = (ms) => new Date(ms).toISOString();

// ---------------------------------------------------------------------------
// 间隔基准
// ---------------------------------------------------------------------------

describe('同步间隔从本轮结束时间起算（PROTOCOL §4 / 设计 §20.2）', () => {
  test('本轮在 T+60s 结束、间隔 10 分钟 → 下一次延迟恰好 10 分钟', () => {
    const h = harness({ intervalMinutes: 10, roundMs: 60 * 1000 });

    const res = h.scheduler.syncNow(); // 不 await，先看运行态
    assert.equal(h.scheduler.getStatus().running, true);
    assert.equal(h.scheduler.getStatus().nextRunAt, null, '运行中不显示计划时间');

    return res.then((r) => {
      assert.equal(r.ok, true);
      assert.equal(r.result.status, 'success');

      const finishedAt = T0 + 60 * 1000;
      assert.equal(h.clock.t, finishedAt);
      // 下一轮 = 结束时间 + 10 分钟，不是开始时间 + 10 分钟
      assert.equal(h.scheduler.getStatus().nextRunAt, iso(finishedAt + 10 * MINUTE));
      assert.equal(h.timers.lastDelay, 10 * MINUTE);
      assert.equal(h.timers.count, 1, '只应有一个待触发定时器');
      assert.equal(h.scheduler.getStatus().running, false);
    });
  });

  test('onState 依次收到「开始运行（无计划时间）」与「结束（有计划时间）」', async () => {
    const h = harness({ roundMs: 60 * 1000 });
    await h.scheduler.syncNow();

    const runningState = h.states.find((s) => s.running === true);
    assert.deepEqual(runningState, { running: true, paused: false, nextRunAt: null });
    const last = h.states[h.states.length - 1];
    assert.deepEqual(last, {
      running: false,
      paused: false,
      nextRunAt: iso(T0 + 60 * 1000 + 10 * MINUTE),
    });
  });

  test('间隔可通过 setIntervalMinutes 改，下一轮按新间隔安排（1–1440 夹取）', () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });

    assert.equal(h.scheduler.setIntervalMinutes(30), 30);
    assert.equal(h.timers.lastDelay, 30 * MINUTE);
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 30 * MINUTE));

    assert.equal(h.scheduler.setIntervalMinutes(99999), 1440, '上限夹到 1440');
    assert.equal(h.scheduler.setIntervalMinutes('abc'), 1440, '非数字保留当前间隔，不产生 NaN');
    // 负数/0 属于非法值：忽略并保留当前间隔（配置校验本身也不允许 0/负数）
    assert.equal(h.scheduler.setIntervalMinutes(-5), 1440, '负数忽略，保留当前间隔');
  });
});

// ---------------------------------------------------------------------------
// 暂停 / 恢复
// ---------------------------------------------------------------------------

describe('暂停 / 恢复（设计 §20.2）', () => {
  test('pause() 清掉定时器并把 nextRunAt 置空；重复 pause 幂等', () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });
    assert.equal(h.timers.count, 1);
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 10 * MINUTE));

    assert.deepEqual(h.scheduler.pause(), { ok: true, alreadyPaused: false });
    assert.equal(h.timers.count, 0, '暂停必须清掉定时器（不能留着到点触发）');
    assert.equal(h.scheduler.getStatus().nextRunAt, null);
    assert.equal(h.scheduler.getStatus().paused, true);

    assert.deepEqual(h.scheduler.pause(), { ok: true, alreadyPaused: true });
    assert.equal(h.timers.count, 0);
  });

  test('暂停期间 syncNow() 仍执行，但执行完**不**安排下一轮', async () => {
    const h = harness({ intervalMinutes: 10, roundMs: 5000 });
    h.scheduler.start({ runOnStart: false });
    const scheduledBeforePause = h.timers.history.length;

    h.scheduler.pause();
    const res = await h.scheduler.syncNow();

    assert.equal(res.ok, true, '手动同步不受暂停限制');
    assert.deepEqual(h.calls, ['manual']);
    assert.equal(h.timers.count, 0, '暂停期间不得留下定时器');
    assert.equal(h.timers.history.length, scheduledBeforePause, '暂停期间不得新安排定时器');
    assert.equal(h.scheduler.getStatus().nextRunAt, null);
  });

  test('resume() 从当前时间重新安排（不是沿用暂停前的旧计划）', () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });
    h.scheduler.pause();

    h.clock.advance(3 * MINUTE); // 暂停了 3 分钟
    assert.deepEqual(h.scheduler.resume(), { ok: true, alreadyRunning: false });

    assert.equal(h.timers.count, 1);
    assert.equal(h.timers.lastDelay, 10 * MINUTE, '恢复后完整等一个间隔');
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 3 * MINUTE + 10 * MINUTE));
    assert.equal(h.scheduler.getStatus().paused, false);

    assert.deepEqual(h.scheduler.resume(), { ok: true, alreadyRunning: true });
  });

  test('定时器到点会真的跑一轮（trigger = timer）', async () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });

    h.clock.advance(10 * MINUTE);
    h.timers.fireLatest(); // 到点
    await flush();

    assert.deepEqual(h.calls, ['timer']);
    assert.equal(h.scheduler.getStatus().running, false);
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 10 * MINUTE + 10 * MINUTE), '跑完再按完成时间重排');
  });
});

// ---------------------------------------------------------------------------
// 互斥
// ---------------------------------------------------------------------------

describe('同步互斥（设计 §20.2「同步中重复触发会被拒绝」）', () => {
  test('运行中再次 syncNow() → {ok:false, reason:\'running\'}，且只跑一轮', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = harness({
      runRoundImpl: async () => {
        await gate;
        return { status: 'success' };
      },
    });

    const first = h.scheduler.syncNow(); // 进入运行态
    assert.deepEqual(await h.scheduler.syncNow(), { ok: false, reason: 'running' });
    assert.equal(h.calls.length, 1, '重复触发不能真的再跑一轮');

    release();
    const done = await first;
    assert.equal(done.ok, true);
    assert.equal(h.calls.length, 1);
  });

  test('运行中 wake() 被忽略（不叠加补跑）', async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    const h = harness({
      runRoundImpl: async () => {
        await gate;
        return { status: 'success' };
      },
    });
    const first = h.scheduler.syncNow();
    assert.deepEqual(await h.scheduler.wake(), { ok: true, action: 'ignored' });
    release();
    await first;
    assert.equal(h.calls.length, 1);
  });
});

// ---------------------------------------------------------------------------
// 唤醒补跑
// ---------------------------------------------------------------------------

describe('wake()（PROTOCOL §3.2 / 设计 §20.2「休眠唤醒最多补跑一轮」）', () => {
  test('计划已错过 → 补跑恰好一轮，并按完成时间重排', async () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 10 * MINUTE));

    h.clock.advance(11 * MINUTE); // 休眠导致定时器没跑，恢复时已过点 1 分钟
    const res = await h.scheduler.wake();

    assert.equal(res.ok, true);
    assert.equal(res.result.status, 'success');
    assert.deepEqual(h.calls, ['wake'], '只补一轮，绝不按错过的时间连续补');
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 11 * MINUTE + 10 * MINUTE));
    assert.equal(h.timers.count, 1);
  });

  test('暂停时 wake 被忽略（不偷偷跑一轮）', async () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });
    h.scheduler.pause();
    h.clock.advance(60 * MINUTE);

    assert.deepEqual(await h.scheduler.wake(), { ok: true, action: 'ignored' });
    assert.equal(h.calls.length, 0);
    assert.equal(h.scheduler.getStatus().nextRunAt, null);
  });

  test('未错过计划时间 → 不跑（action=on-time，定时器不变）', async () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });

    assert.deepEqual(await h.scheduler.wake(), { ok: true, action: 'on-time' });
    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.count, 1);
    assert.equal(h.timers.lastDelay, 10 * MINUTE);
  });

  test('catchUpOnWake=false → 不补跑，只按当前时间重排', async () => {
    const h = harness({ intervalMinutes: 10, catchUpOnWake: false });
    h.scheduler.start({ runOnStart: false });
    h.clock.advance(30 * MINUTE);

    assert.deepEqual(await h.scheduler.wake(), { ok: true, action: 'rescheduled' });
    assert.equal(h.calls.length, 0);
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 30 * MINUTE + 10 * MINUTE));
  });
});

// ---------------------------------------------------------------------------
// 启动 / 停止
// ---------------------------------------------------------------------------

describe('start / restore / stop（设计 §20.2「开机后立即同步 / 不立即同步」）', () => {
  test('start({runOnStart:true}) 会触发一轮', async () => {
    const h = harness({ roundMs: MINUTE });
    h.scheduler.start(); // 默认 runOnStart = true
    assert.equal(h.calls.length, 0, 'start 内部用 setImmediate 异步起跑，避免宿主启动竞态');

    await flush();
    assert.deepEqual(h.calls, ['start']);
    assert.equal(h.scheduler.getStatus().running, false);
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + MINUTE + 10 * MINUTE));
  });

  test('start({runOnStart:false}) 不跑，直接排 10 分钟后', async () => {
    const h = harness({ intervalMinutes: 10 });
    h.scheduler.start({ runOnStart: false });
    await flush();

    assert.equal(h.calls.length, 0);
    assert.equal(h.timers.count, 1);
    assert.equal(h.timers.lastDelay, 10 * MINUTE);
  });

  test('restore({paused:true}) 不排定时器（重启后仍是暂停态）', async () => {
    const h = harness();
    h.scheduler.restore({ paused: true, runOnStart: true });
    await flush();

    assert.equal(h.calls.length, 0, '暂停状态下即使 runOnStart 也不跑');
    assert.equal(h.timers.count, 0);
    assert.equal(h.scheduler.getStatus().paused, true);
    assert.equal(h.scheduler.getStatus().nextRunAt, null);
  });

  test('restore({paused:false, runOnStart:true}) 立即跑一轮', async () => {
    const h = harness();
    h.scheduler.restore({ paused: false, runOnStart: true });
    await flush();
    assert.deepEqual(h.calls, ['start']);
  });

  test('stop() 清定时器、nextRunAt 置空，此后 syncNow 返回 stopped', async () => {
    const h = harness();
    h.scheduler.start({ runOnStart: false });
    h.scheduler.stop();

    assert.equal(h.timers.count, 0);
    assert.equal(h.scheduler.getStatus().nextRunAt, null);
    assert.equal(h.scheduler.getStatus().stopped, true);
    assert.deepEqual(await h.scheduler.syncNow(), { ok: false, reason: 'stopped' });
    assert.equal(h.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// 异常与健壮性
// ---------------------------------------------------------------------------

describe('异常兜底（PROTOCOL §10 internal-error）', () => {
  test('runRound 抛异常 → 记为 internal-error，running 复位且照常排下一轮', async () => {
    const h = harness({
      runRoundImpl: async () => { throw new Error('boom'); },
    });

    const res = await h.scheduler.syncNow();
    assert.equal(res.ok, true);
    assert.equal(res.result.status, 'internal-error');
    assert.match(res.result.message, /boom/);
    assert.equal(res.result.error.code, 'UNEXPECTED_ERROR');
    assert.equal(res.result.error.stage, 'scheduler');
    assert.equal(h.scheduler.getStatus().running, false, '异常后必须复位 running，否则永久卡死');
    assert.equal(h.timers.count, 1, '异常后仍要安排下一轮');
    assert.equal(h.scheduler.getStatus().nextRunAt, iso(T0 + 10 * MINUTE));
  });

  test('onState 回调抛异常不影响调度', async () => {
    const clock = fakeClock();
    const timers = fakeTimers();
    const s = createScheduler({
      config: { scheduler: { intervalMinutes: 10 } },
      runRound: async () => ({ status: 'success' }),
      onState: () => { throw new Error('UI 崩了'); },
      log: { info() {}, warn() {}, error() {} },
      now: clock.now,
      timers,
    });

    const res = await s.syncNow();
    assert.equal(res.ok, true);
    assert.equal(res.result.status, 'success');
    assert.equal(timers.count, 1);
  });
});
