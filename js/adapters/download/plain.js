/**
 * 通用兼容适配器。
 * 用于未登记 apiVer 的旧线路，保留已有 children 层级，并将含下载 URL 的项转为统一下载项。
 */
import { normalizeDownloadItem } from './common.js';

/**
 * 适配通用/未登记协议的响应。
 * @param {object|Array<object>} payload 兼容的数组、items 或 children 结构
 * @param {{source: string}} context 线路显示名
 * @returns {Array<object>} 统一节点数组（分组节点或下载叶子）
 */
export function adaptPlain(payload, context) {
  const items = Array.isArray(payload) ? payload : payload?.items || payload?.children || [];
  return items.map((item) => {
    if (item.children) return { ...item, children: adaptPlain(item.children, context) };
    if (item.url || item.downloadUrl || item.link || item.download_link) {
      return normalizeDownloadItem(item, context.source, item.version);
    }
    return { ...item };
  });
}
