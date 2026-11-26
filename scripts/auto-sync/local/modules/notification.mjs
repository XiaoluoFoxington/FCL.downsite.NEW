// notification.mjs — 标准 / 累积通知文案与发送决策
//
// 设计 §11：
//   · 标准模式：按结果类型 + 勾选项决定是否通知
//   · 累积模式：自上次成功发送累积通知以来计数，达到 everyRuns 后发汇总；内部错误可「始终单独通知」
//   · 通知失败不能改变同步结果，也不能让同步任务失败；**只有发送成功才清零计数**
//   · Toast 不含任何 Token / Cookie / 密码

const STAGE_TEXT = {
  prepare: '准备',
  pull: 'Pull',
  sync: 'Sync',
  commit: '提交',
  push: '推送',
  finish: '收尾',
  unknown: '未知',
};

function pad(n) {
  return String(n).padStart(2, '0');
}

/** 本地时间 HH:MM */
export function hhmm(iso) {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return '';
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function clean(message) {
  return String(message || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);
}

/**
 * 单轮结果 → 标准通知文案。
 * @returns {{title:string, text:string}}
 */
export function buildStandard(result, { nextRunAt = null } = {}) {
  const status = result.status;
  const nextText = hhmm(nextRunAt);
  const nextSuffix = nextText ? `，下次同步时间：${nextText}` : '';

  if (status === 'success') {
    const stats = result.stats || {};
    const text = stats.versions
      ? `同步了 ${stats.resources} 个资源，共 ${stats.versions} 个版本。`
      : `${clean(result.message) || '同步完成'}。`;
    return { title: '自动同步成功', text: `${text}${nextSuffix}` };
  }
  if (status === 'up-to-date') {
    return { title: '自动同步完成', text: `当前已是最新${nextSuffix}。` };
  }
  if (status === 'failure') {
    const err = result.error || {};
    const stage = STAGE_TEXT[err.stage] || STAGE_TEXT.unknown;
    const detail = clean(err.message || result.message) || '未知错误';
    return { title: '自动同步失败', text: `${stage}阶段失败：${detail}` };
  }
  // internal-error
  const detail = clean((result.error || {}).message || result.message) || '程序内部错误';
  return { title: '自动同步内部错误', text: `${detail}。请查看日志。` };
}

/** 累积汇总文案 */
export function buildCumulative(state, everyRuns) {
  const n = state.notification || {};
  const total = Number(n.pendingRuns || 0);
  const text = [
    `自上次通知后共运行 ${total} 次：`,
    `成功：${n.success || 0} 次`,
    `已是最新：${n['up-to-date'] || 0} 次`,
    `失败：${n.failure || 0} 次`,
    `内部错误：${n['internal-error'] || 0} 次`,
  ].join('\n');
  return { title: '自动同步运行汇总', text };
}

/**
 * 决定本轮要不要发通知、发什么。
 *
 * @param {{result:object, config:object, state:object, nextRunAt?:string|null}} opts
 *        `state` 必须是**已 recordResult 之后**的状态（累积计数已 +1）
 * @returns {{send:boolean, title:string, text:string, mode:'standard'|'cumulative'|'none', reset:boolean}}
 */
export function decideNotification({ result, config, state, nextRunAt = null }) {
  const cfg = (config && config.notifications) || {};
  const mode = cfg.mode === 'cumulative' ? 'cumulative' : 'standard';
  const status = result.status;

  if (mode === 'standard') {
    const options = cfg.standard || {};
    const wanted = options[status] === true;
    if (!wanted) return { send: false, title: '', text: '', mode: 'none', reset: true };
    const { title, text } = buildStandard(result, { nextRunAt });
    // 标准模式不使用累积计数，发完就清零（避免以后切到累积模式时带旧账）
    return { send: true, title, text, mode: 'standard', reset: true };
  }

  // 累积模式
  const cumulative = cfg.cumulative || {};
  if (status === 'internal-error' && cumulative.internalErrorMode !== 'never') {
    const { title, text } = buildStandard(result, { nextRunAt });
    return { send: true, title, text, mode: 'cumulative', reset: false };
  }

  const everyRuns = Math.max(1, Number(cumulative.everyRuns || 7));
  const pending = Number((state.notification || {}).pendingRuns || 0);
  if (pending >= everyRuns) {
    const { title, text } = buildCumulative(state, everyRuns);
    return { send: true, title, text, mode: 'cumulative', reset: true };
  }
  return { send: false, title: '', text: '', mode: 'none', reset: false };
}
