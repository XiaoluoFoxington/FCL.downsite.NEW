/**
 * 可见性控制。
 * 数据源（software.json 等）中的条目可带 `hidden: true`，
 * 表示默认从列表中隐藏，且各详情页需要显式携带 `showHidden=1` 查询参数才允许访问。
 *
 * 该模块不碰 DOM、不发请求，只做纯粹的判断与数组过滤，供 controller 与 repository 共用。
 */

/** 允许显式显示隐藏条目的查询参数名。 */
export const SHOW_HIDDEN_PARAM = 'showHidden';

/**
 * 判断某个查询参数值是否表示「开启」。
 * 接受 `1` 与 `true`（忽略大小写与首尾空白），其余一律视为关闭。
 * @param {string|null|undefined} value 查询参数原始值
 * @returns {boolean}
 */
export function isTruthyFlag(value) {
  if (value === null || value === undefined) return false;
  const normalized = String(value).trim().toLowerCase();
  return normalized === '1' || normalized === 'true';
}

/**
 * 当前页面是否要求显示隐藏条目。
 * 默认读取 window.location.search；测试或特殊场景可显式传入查询串。
 * @param {string} [search] 形如 `?id=3&showHidden=1` 的查询串
 * @returns {boolean}
 */
export function isShowHiddenEnabled(search) {
  const source = typeof search === 'string' ? search : (typeof window !== 'undefined' ? window.location.search : '');
  try {
    return isTruthyFlag(new URLSearchParams(source).get(SHOW_HIDDEN_PARAM));
  } catch (error) {
    // 极端环境下 URLSearchParams 不可用时按「不显示隐藏条目」处理，保证页面仍可用。
    return false;
  }
}

/**
 * 条目是否被标记为隐藏。
 * 只认严格的布尔 true，避免 `"false"` 这类字符串被误判为隐藏。
 * @param {{hidden?: boolean}} item 数据源条目
 * @returns {boolean}
 */
export function isHiddenItem(item) {
  return item?.hidden === true;
}

/**
 * 按可见性过滤条目：showHidden 为 false 时剔除 `hidden: true` 的条目。
 * 不修改入参数组。
 * @param {Array<object>} items 数据源条目数组
 * @param {boolean} showHidden 是否保留隐藏条目
 * @returns {Array<object>}
 */
export function filterHiddenItems(items, showHidden) {
  if (!Array.isArray(items)) return [];
  if (showHidden) return items;
  return items.filter((item) => !isHiddenItem(item));
}

/**
 * 给站内链接补上 `showHidden=1`（仅在当前页面已开启显示隐藏条目时）。
 * 用于详情页跳转到下载/介绍/版本历史等子页面时保留可见性状态，
 * 避免从隐藏条目的详情页点进子页面后被判定为「找不到软件」。
 * @param {string} url 原始站内链接
 * @param {string} [search] 当前页面查询串，默认取 window.location.search
 * @returns {string} 追加参数后的链接
 */
export function withShowHidden(url, search) {
  if (!url || !isShowHiddenEnabled(search)) return url;
  // 已经是绝对外链时不做处理，避免污染第三方地址。
  if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
  const hashIndex = url.indexOf('#');
  const hash = hashIndex >= 0 ? url.slice(hashIndex) : '';
  const base = hashIndex >= 0 ? url.slice(0, hashIndex) : url;
  const separator = base.includes('?') ? '&' : '?';
  if (new RegExp(`[?&]${SHOW_HIDDEN_PARAM}=`).test(base)) return url;
  return `${base}${separator}${SHOW_HIDDEN_PARAM}=1${hash}`;
}