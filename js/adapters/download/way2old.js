import { normalizeDownloadItem } from './common.js';

/**
 * Way2old 线路适配器。
 * 以 type=directory/file 表示树结构，未知节点静默忽略，防止上游新增字段破坏线路。
 */

/**
 * 适配 Way2old API 响应。
 * 递归遍历 directory/file 树，转为统一下载节点。
 * @param {object|Array<object>} payload Way2old 根节点或 children 数组
 * @param {{source: string, latestVersion?: string|null}} context 线路名与默认版本
 * @returns {Array<object>} 统一下载节点数组
 */
export function adaptWay2old(payload, context) {
  const visit = (items, version = '') => (Array.isArray(items) ? items : items?.children || []).flatMap((item) => {
    if (item.type === 'directory') {
      return [{
        name: item.name,
        default: item.name === context.latestVersion,
        description: item.description || '',
        children: visit(item.children, item.name),
      }];
    }
    if (item.type === 'file') return [normalizeDownloadItem(item, context.source, version)];
    return [];
  });
  return visit(payload);
}
