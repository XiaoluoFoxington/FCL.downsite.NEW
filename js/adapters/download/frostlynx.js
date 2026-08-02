/**
 * frostlynx 线路适配器。
 * 将 { versions: { [version]: asset[] } } 格式的响应转为统一下载节点。
 */
import { normalizeDownloadItem } from './common.js';

/**
 * 适配 frostlynx API 响应。
 * @param {object} payload frostlynx 返回的 { versions: { 版本号: 文件数组 } }
 * @param {{source: string, latestVersion?: string|null}} context 线路显示名与默认版本
 * @returns {Array<object>} 按版本分组的下载节点
 */
export function adaptFrostlynx(payload, context) {
  return Object.entries(payload?.versions || {}).map(([version, items]) => ({
    name: version,
    default: version === context.latestVersion,
    children: (items || []).map((item) => normalizeDownloadItem(item, context.source, version)),
  }));
}
