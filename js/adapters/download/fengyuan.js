import { compareVersionsDescending, normalizeDownloadItem } from './common.js';
import { t } from '../../common/i18n.js';

/**
 * 枫源线路适配器。
 * API 将文件平铺在 data.assets 中，本适配器按版本重新组成选择器树。
 */

/**
 * 适配枫源 API 响应。
 * 版本节点 -> 统一下载项，最高版本自动成为默认版本。
 * @param {object} payload 枫源返回的 { data: { assets: [] } }
 * @param {{source: string, baseUrl: string}} context 线路显示名与 API 所在域名
 * @returns {Array<object>} 按版本排序的分组节点
 */
export function adaptFengyuan(payload, context) {
  const grouped = new Map();
  for (const asset of payload?.data?.assets || []) {
    const version = asset.version || t('common.adapters.unknownVersion');
    if (!grouped.has(version)) grouped.set(version, []);
    // 枫源只返回相对 download_path，必须以 API 所在站点为基准补成绝对下载地址。
    grouped.get(version).push(normalizeDownloadItem({
      ...asset,
      architecture: asset.architecture === 'None' && asset.file_name?.includes('Zalith')
        ? 'all'
        : asset.architecture,
      downloadUrl: new URL(asset.download_path, context.baseUrl).href,
    }, context.source, version));
  }
  // 不依赖 API 返回顺序，防止“旧版本排在第一项”导致默认下载错误。
  const versions = [...grouped.keys()].sort(compareVersionsDescending);
  return versions.map((version, index) => ({
    name: version,
    default: index === 0,
    children: grouped.get(version),
  }));
}
