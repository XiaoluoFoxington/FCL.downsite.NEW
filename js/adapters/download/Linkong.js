/**
 * Linkong API 适配器。
 * 响应格式：{ releases: [{ version, title, assets: [{ name, size, download_url }] }] }
 * API 换新的了，返回的 download_url 直接就是镜像地址，旧的呢？KV缓存线被剪了
*/
import { normalizeDownloadItem } from './common.js';

/**
 * 适配 Linkong API 响应。
 * @param {object} payload Linkong API 响应
 * @param {{source: string}} context 线路显示名
 * @returns {Array<object>} 按版本分组的下载节点
 */
export function adaptLinkong(payload, context) {
  const releases = payload?.releases || [];
  return releases.map((release, index) => ({
    name: release.version || release.title || `版本 ${index + 1}`,
    default: index === 0,
    children: (release.assets || []).map((asset) =>
      normalizeDownloadItem(
        {
          ...asset,
          downloadUrl: asset.download_url,
        },
        context.source,
        release.version,
      ),
    ),
  }));
}

/**
 * 构造 Linkong 下载 API 的最终 URL。
 * 将 GitHub 原始下载 URL 转为代理 API 路径，自动编码路径段与查询参数。
 * GET /api/releases/:tag/:assetName?owner=<owner>&repo=<repo>
 * @param {string} baseUrl 代理服务基础 URL
 * @param {string} tag Release 版本标签
 * @param {string} assetName 资源文件名
 * @param {string} owner GitHub 仓库所有者
 * @param {string} repo GitHub 仓库名称
 * @returns {string} 最终下载 URL
 */
export function wdfDownUrl(baseUrl, tag, assetName, owner, repo) {
  // 对路径段与查询参数编码，避免 assetName 等字段含特殊字符时破坏 URL。
  const encodedTag = encodeURIComponent(tag);
  const encodedAssetName = encodeURIComponent(assetName);
  const params = new URLSearchParams({ owner, repo });
  return `${baseUrl}/api/releases/${encodedTag}/${encodedAssetName}?${params.toString()}`;
}
