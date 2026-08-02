/**
 * cxsjmc 线路适配器。
 * 将 [{ arch, url, ... }] 格式的响应转为统一下载叶子节点。
 */
import { normalizeDownloadItem } from './common.js';

/**
 * 适配 cxsjmc API 响应。
 * API 已直接返回文件数组，此处仅做字段归一化，不引入额外网络请求。
 * @param {Array<object>} payload cxsjmc 返回的文件数组
 * @param {{source: string}} context 线路显示名
 * @returns {Array<object>} 统一下载叶子节点数组
 */
export function adaptCxsjmc(payload, context) {
  return (Array.isArray(payload) ? payload : []).map((item) => normalizeDownloadItem(item, context.source));
}
