// scheduler.mjs — 调度、暂停/恢复、立即同步、互斥、休眠唤醒补跑
//
// 设计 §10：
//   · 不用永久 setInterval：每轮结束后按「完成时间 + intervalMinutes」安排下一轮
//   · intervalMinutes 是**本轮结束后等待的分钟数**（12:00 开始、12:01 结束、间隔 10 → 12:11）
//   · 暂停只取消下一轮定时器，不中止当前同步；手动同步不受暂停限制
//   · 同步中拒绝重复启动，并回报当前状态
//   · 唤醒后最多补跑一轮（不按错过的时间连续补跑）
//   · 单实例 + 同步互斥：本对象是唯一入口，running 期间任何触发都被拒绝

/**
 * @param {object} opts
 * @param {object} opts.config 当前配置（读 scheduler.intervalMinutes / catchUpOnWake）
 * @param {(trigger:'timer'|'manual'|'wake'|'start')=>Promise<object>} opts.runRound 真正执行一轮
 * @param {(info:object)=>void} [opts.onState] 状态变化回调（宿主据此刷新菜单/图标）
 * @param {object} [opts.log]
 * @param {() => number} [opts.now] 可注入时钟（测试用）
 * @param {{setTimeout:Function, clearTimeout:Function}} [opts.timers] 可注入定时器（测试用）
 */
export function createScheduler(opts) {
  const {
    config,
    runRound,
    onState = () => {},
    log = { info: () => {}, warn: () => {}, error: () => {} },
    now = () => Date.now(),
    timers = { setTimeout, clearTimeout },
  } = opts;

  let timer = null;
  let nextAt = null;          // 计划执行时间（ms epoch）
  let running = false;
  let paused = false;
  let stopped = false;
  let intervalMinutes = Math.max(1, Number((config.scheduler || {}).intervalMinutes || 10));

  const emit = () => {
    try {
      onState({ running, paused, nextRunAt: nextAt ? new Date(nextAt).toISOString() : null });
    } catch { /* UI 回调异常不能影响调度 */ }
  };

  const clearTimer = () => {
    if (timer) {
      timers.clearTimeout(timer);
      timer = null;
    }
  };

  const scheduleAt = (ms) => {
    clearTimer();
    nextAt = ms;
    if (stopped || paused || ms === null) {
      nextAt = paused ? null : nextAt;
      emit();
      return;
    }
    const delay = Math.max(0, ms - now());
    timer = timers.setTimeout(() => {
      timer = null;
      // 定时器可能因休眠而延迟：到这里只跑一轮，跑完再按完成时间重新排
      runOnce('timer');
    }, delay);
    log.info('Scheduler', `下一轮：${new Date(ms).toLocaleString('zh-CN', { hour12: false })}（${Math.round(delay / 60000)} 分钟后）`);
    emit();
  };

  /** 本轮结束后安排下一轮（暂停时不安排） */
  const scheduleAfterFinish = () => {
    if (stopped || paused) {
      nextAt = null;
      emit();
      return;
    }
    scheduleAt(now() + intervalMinutes * 60 * 1000);
  };

  async function runOnce(trigger) {
    if (running) {
      log.warn('Scheduler', `忽略 ${trigger} 触发：已有同步在运行`);
      return { ok: false, reason: 'running' };
    }
    if (stopped) return { ok: false, reason: 'stopped' };

    running = true;
    clearTimer();
    nextAt = null;
    log.info('Scheduler', `开始同步（触发：${trigger}）`);
    emit();

    let result = null;
    try {
      result = await runRound(trigger);
    } catch (e) {
      log.error('Scheduler', `同步流程抛出未捕获异常：${e && e.stack ? e.stack : e}`);
      result = {
        status: 'internal-error',
        startedAt: null,
        finishedAt: new Date().toISOString(),
        durationMs: 0,
        message: e && e.message ? e.message : String(e),
        stats: null,
        error: { stage: 'scheduler', code: 'UNEXPECTED_ERROR', message: e && e.message ? e.message : String(e) },
        stages: [],
        committed: false,
        pushed: false,
        aheadAtEnd: null,
        warnings: [],
      };
    } finally {
      running = false;
      scheduleAfterFinish();
      log.info('Scheduler', `本轮结束：${result ? result.status : 'unknown'}`);
    }
    return { ok: true, result };
  }

  return {
    /** 启动调度；runOnStart=true 时立即跑一轮 */
    start({ runOnStart = true } = {}) {
      stopped = false;
      paused = false;
      if (runOnStart) {
        // 先 emit 再异步跑，避免宿主启动竞态
        emit();
        setImmediate(() => { runOnce('start'); });
      } else {
        scheduleAt(now() + intervalMinutes * 60 * 1000);
      }
    },

    /** 从持久化状态恢复（paused=true 时不排定时器） */
    restore({ paused: wasPaused = false, runOnStart = false } = {}) {
      stopped = false;
      paused = Boolean(wasPaused);
      if (paused) {
        nextAt = null;
        emit();
        return;
      }
      if (runOnStart) {
        emit();
        setImmediate(() => { runOnce('start'); });
      } else {
        scheduleAt(now() + intervalMinutes * 60 * 1000);
      }
    },

    stop() {
      stopped = true;
      clearTimer();
      nextAt = null;
      emit();
    },

    /** 暂停：取消下一轮定时器，不中止当前同步 */
    pause() {
      if (paused) return { ok: true, alreadyPaused: true };
      paused = true;
      clearTimer();
      nextAt = null;
      log.info('Scheduler', '已暂停自动同步（当前同步不受影响）');
      emit();
      return { ok: true, alreadyPaused: false };
    },

    /** 恢复：从当前时间重新安排下一轮 */
    resume() {
      if (!paused) return { ok: true, alreadyRunning: true };
      paused = false;
      log.info('Scheduler', '已恢复自动同步');
      scheduleAt(now() + intervalMinutes * 60 * 1000);
      return { ok: true, alreadyRunning: false };
    },

    /** 立即同步：不受暂停状态限制；正在同步时拒绝 */
    async syncNow() {
      if (running) return { ok: false, reason: 'running' };
      return runOnce('manual');
    },

    /** 系统唤醒：计划已错过则最多补跑一轮 */
    async wake() {
      if (stopped || paused || running) return { ok: true, action: 'ignored' };
      const catchUp = (config.scheduler || {}).catchUpOnWake !== false;
      if (!catchUp) {
        scheduleAt(now() + intervalMinutes * 60 * 1000);
        return { ok: true, action: 'rescheduled' };
      }
      if (nextAt !== null && now() >= nextAt) {
        log.warn('Scheduler', '唤醒后发现已错过计划时间，补跑一轮（只补一轮）');
        return runOnce('wake');
      }
      return { ok: true, action: 'on-time' };
    },

    /** 修改同步间隔（不打断正在运行的一轮，下一轮生效） */
    setIntervalMinutes(min) {
      const raw = Number(min);
      if (!Number.isFinite(raw) || raw < 1) return intervalMinutes; // 非法值忽略，别把间隔改成 1 分钟
      const v = Math.max(1, Math.min(1440, Math.floor(raw)));
      intervalMinutes = v;
      if (!running && !paused) scheduleAt(now() + intervalMinutes * 60 * 1000);
      return intervalMinutes;
    },

    setTimers(t) {
      if (t && typeof t.setTimeout === 'function') timers.setTimeout = t.setTimeout;
      if (t && typeof t.clearTimeout === 'function') timers.clearTimeout = t.clearTimeout;
    },

    getStatus() {
      return {
        running,
        paused,
        stopped,
        intervalMinutes,
        nextRunAt: nextAt ? new Date(nextAt).toISOString() : null,
      };
    },
  };
}
