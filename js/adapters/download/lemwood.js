import { normalizeDownloadItem } from './common.js';

/**
 * Lemwood 线路适配器。
 * v2 既可能返回 { data: [...] }，也可能直接返回数组/单项，此处兼容三种形态。
 */

/**
 * 适配 Lemwood API 响应。
 * @param {object|Array<object>} payload Lemwood 响应或其 data 信封
 * @param {{source: string}} context 线路显示名
 * @param {{latestOnly?: boolean}} options 是否仅保留第一个发布项
 * @returns {Array<object>} 按版本分组的下载节点
 */
export function adaptLemwood(payload, context, { latestOnly = false } = {}) {
  let releases = payload?.data ?? payload;
  if (!Array.isArray(releases)) releases = releases ? [releases] : [];
  // LemwoodLatest 表示接口只希望展示最新条目，而非强制请求另一套数据。
  if (latestOnly) releases = releases.slice(0, 1);
  return releases.map((release, index) => ({
    name: release.name || release.tag_name || `版本 ${index + 1}`,
    default: index === 0,
    children: (release.assets || []).map((asset) => normalizeDownloadItem(asset, context.source, release.name)),
  }));
}
