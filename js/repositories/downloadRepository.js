import { getJSON, getText } from '../http/client.js';
import { adaptDownloadData, randomlySelectDefault } from '../adapters/download/index.js';
import { logWarn } from '../common/logger.js';

/**
 * 下载数据仓库。
 * 它负责请求外部镜像与补充接口；adapter 只负责把已获得的 payload 转为统一节点。
 * 统一的叶子下载项字段为：name、version、architecture、size、description、downloadUrl、available、source。
 */
// 只有少数旧协议需要额外访问 GitHub 才能标记“最新版本”；映射集中在此处，
// adapter 保持纯函数，便于用固定输入测试。
const GITHUB_REPOSITORIES = {
  'Fold Craft Launcher': 'FCL-Team/FoldCraftLauncher',
  'Zalith Launcher 2': 'ZalithLauncher/ZalithLauncher2',
};

/**
 * 获取旧协议的最新版本标记。
 * @param {string} apiVersion 线路协议版本
 * @param {string} softwareName 软件名称（用于 GitHub 仓库映射）
 * @param {object} payload 上游镜像 API 返回的 payload
 * @param {AbortSignal} signal 取消信号
 * @returns {Promise<string|null>} 无法取得时返回镜像 payload 自带的 latest，非异常降级
 */
async function getLatestVersion(apiVersion, softwareName, payload, signal) {
  if (apiVersion !== 'Way2old' && apiVersion !== 'frostlynx') return payload?.latest || null;
  const repository = GITHUB_REPOSITORIES[softwareName];
  if (!repository) return payload?.latest || null;
  try {
    const release = await getJSON(`https://api.github.com/repos/${repository}/releases/latest`, {
      signal,
      timeoutMs: 12000,
    });
    return release.tag_name || payload?.latest || null;
  } catch (error) {
    // 用户切换线路时必须继续向上抛出取消；普通 GitHub 故障则降级为镜像响应中的版本。
    if (error.kind === 'abort') throw error;
    logWarn(error, '获取最新版本失败，使用镜像返回的版本');
    return payload?.latest || null;
  }
}

/**
 * 获取并适配一个选择器节点的下级数据。
 * @param {{url?: string, apiVersion?: string, softwareName?: string, sourceName?: string, random?: boolean, notJoinRandom?: boolean, signal?: AbortSignal}} options
 * @returns {Promise<Array<object>>} 可继续选择的分组节点，或可直接渲染的统一下载叶子节点
 */
export async function loadDownloadNodes({
  url,
  apiVersion,
  softwareName,
  sourceName,
  random = false,
  notJoinRandom = false,
  signal,
}) {
  // cxsjmc 的旧协议没有可请求的目录 URL，而是由 GitHub 最新 Release 拼出直链。
  if (!url) {
    if (apiVersion === 'cxsjmc') {
      const release = await getJSON('https://api.github.com/repos/FCL-Team/FoldCraftLauncher/releases/latest', { signal });
      const payload = (release.assets || []).map((asset) => ({
        name: asset.name,
        url: `https://fcl.cxsjmc.cn/FCL/${asset.name}`,
      }));
      return adaptDownloadData(payload, apiVersion, { source: sourceName });
    }
    return [];
  }

  // 镜像数据不做页面级长期复用：用户重新选择线路时应能获取最新目录。
  const payload = await getJSON(url, { signal, timeoutMs: 20000 });
  const latestVersion = await getLatestVersion(apiVersion, softwareName, payload, signal);
  const nodes = adaptDownloadData(payload, apiVersion, {
    source: sourceName,
    baseUrl: new URL(url, window.location.href).origin,
    latestVersion,
    notJoinRandom,
  });
  return random ? randomlySelectDefault(nodes) : nodes;
}

/**
 * 读取线路配置的远程说明文本；是否富文本由上层配置决定。
 * @param {string} url 说明文本 URL
 * @param {AbortSignal} [signal] 取消信号
 * @returns {Promise<string>} 文本内容
 */
export function loadDescription(url, signal) {
  // 描述默认按纯文本消费；是否允许 HTML 由 controller 中的 descriptionFormat 明确决定。
  return getText(url, { signal, timeoutMs: 15000 });
}