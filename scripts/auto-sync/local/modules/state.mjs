// state.mjs — state.json：少量必要运行状态（不存日志、不存凭据）
//
// 契约见 local/PROTOCOL.md §5：
//   · 原子保存；损坏时备份 + 恢复默认值，并记录错误（不静默清空）
//   · totalRuns 的计数时机统一在 recordResult（每轮结束计一次），不在别处重复加
//   · locked / paused 持久化，重启后沿用
//   · 菜单、详细状态窗口只读本文件，不直接修改

import fs from 'node:fs';

import { STATE_FILE } from './paths.mjs';
import { backupFile, writeJsonAtomic } from './config.mjs';

export const STATUS_VALUES = ['success', 'up-to-date', 'failure', 'internal-error'];

export function defaultState() {
  return {
    version: 1,
    locked: false,
    paused: false,
    totalRuns: 0,
    lastRun: null,
    nextRunAt: null,
    stats: { success: 0, 'up-to-date': 0, failure: 0, 'internal-error': 0 },
    notification: { pendingRuns: 0, success: 0, 'up-to-date': 0, failure: 0, 'internal-error': 0 },
  };
}

function asBool(v, fallback = false) {
  if (typeof v === 'boolean') return v;
  if (v === 'true') return true;
  if (v === 'false') return false;
  return fallback;
}

function asCount(v) {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : 0;
}

/** 归一化任意输入为合法 state（字段缺失/类型不对都不抛） */
export function normalizeState(input) {
  const base = defaultState();
  const src = input && typeof input === 'object' ? input : {};
  const state = base;

  state.locked = asBool(src.locked, false);
  state.paused = asBool(src.paused, false);
  state.totalRuns = asCount(src.totalRuns);

  for (const key of STATUS_VALUES) {
    state.stats[key] = asCount((src.stats || {})[key]);
    state.notification[key] = asCount((src.notification || {})[key]);
  }
  state.notification.pendingRuns = asCount((src.notification || {}).pendingRuns);

  const last = src.lastRun;
  if (last && typeof last === 'object' && STATUS_VALUES.includes(String(last.status))) {
    state.lastRun = {
      status: String(last.status),
      startedAt: typeof last.startedAt === 'string' ? last.startedAt : null,
      finishedAt: typeof last.finishedAt === 'string' ? last.finishedAt : null,
      durationMs: asCount(last.durationMs),
      message: typeof last.message === 'string' ? last.message : '',
      stats: last.stats && typeof last.stats === 'object'
        ? { resources: asCount(last.stats.resources), versions: asCount(last.stats.versions) }
        : null,
      error: last.error && typeof last.error === 'object'
        ? {
          stage: typeof last.error.stage === 'string' ? last.error.stage : '',
          code: typeof last.error.code === 'string' ? last.error.code : '',
          message: typeof last.error.message === 'string' ? last.error.message : '',
        }
        : null,
    };
  }

  state.nextRunAt = typeof src.nextRunAt === 'string' ? src.nextRunAt : null;
  return state;
}

/**
 * 读取状态；不存在则返回默认值（不写盘，交首次保存统一落盘）。
 * @returns {{ state: object, recovered: boolean, backup: string|null, error: string|null }}
 */
export function loadState(file = STATE_FILE) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
  } catch (e) {
    if (e && e.code === 'ENOENT') return { state: defaultState(), recovered: false, backup: null, error: null };
    return { state: defaultState(), recovered: false, backup: null, error: `无法读取状态文件：${e && e.message ? e.message : e}` };
  }

  try {
    const raw = JSON.parse(text);
    return { state: normalizeState(raw), recovered: false, backup: null, error: null };
  } catch (e) {
    const backup = backupFile(file, 'corrupt');
    return {
      state: defaultState(),
      recovered: true,
      backup,
      error: `状态文件损坏，已备份并恢复默认值：${e && e.message ? e.message : e}`,
    };
  }
}

/** 原子保存状态 */
export function saveState(state, file = STATE_FILE) {
  return writeJsonAtomic(file, normalizeState(state));
}

// ---------- 结果 → 状态 ----------

/**
 * 每轮结束记账：totalRuns +1、更新 stats、lastRun、nextRunAt。
 * 注意：永久失败恢复与统计都只在这里改，别处不要重复加。
 */
export function recordResult(state, result, nextRunAt = null) {
  const s = normalizeState(state);
  const status = STATUS_VALUES.includes(result.status) ? result.status : 'internal-error';

  s.totalRuns += 1;
  s.stats[status] += 1;
  s.lastRun = {
    status,
    startedAt: result.startedAt || null,
    finishedAt: result.finishedAt || null,
    durationMs: Number.isFinite(result.durationMs) ? result.durationMs : 0,
    message: typeof result.message === 'string' ? result.message : '',
    stats: result.stats || null,
    error: result.error || null,
  };
  s.nextRunAt = nextRunAt || null;

  // 通知累积计数（每轮都先累计，发送成功后由 resetNotification 清零）
  s.notification.pendingRuns += 1;
  s.notification[status] += 1;

  return s;
}

/** 通知发送成功后清零累积计数 */
export function resetNotification(state) {
  const s = normalizeState(state);
  s.notification = { pendingRuns: 0, success: 0, 'up-to-date': 0, failure: 0, 'internal-error': 0 };
  return s;
}

export { STATE_FILE };
