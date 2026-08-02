import { getSoftware } from '../repositories/siteRepository.js';
import { getJSON } from '../http/client.js';
import { renderReleases, renderRhError, renderRhLoading } from '../views/rhView.js';

/**
 * 版本历史页 controller。
 * container：Release 面板挂载点；softwareId：URL 校验后的整数 ID。
 */
export function createRhController(container, softwareId) {
  async function load() {
    renderRhLoading(container);
    try {
      const { basic, detail } = await getSoftware(softwareId);

      // 从详情 JSON 中读取 GitHub API 地址
      const releaseUrl = detail.releaseHistoryUrl;
      if (!releaseUrl || typeof releaseUrl !== 'string') {
        throw new Error('未配置 Release 历史地址（releaseHistoryUrl）');
      }
      if (!releaseUrl.startsWith('https://api.github.com/')) {
        throw new Error('Release 历史地址格式不正确');
      }

      const releases = await getJSON(releaseUrl, { timeoutMs: 20000 });
      if (!Array.isArray(releases)) {
        throw new Error('返回了不正确的 Release 历史记录 JSON 格式');
      }

      await renderReleases(container, basic, releases);
    } catch (error) {
      console.error('版本历史加载失败', error);
      // 将 GitHub API 的状态码错误转为可读消息
      const message = translateError(error);
      renderRhError(container, new Error(message), load);
    }
  }

  return { load };
}

/**
 * 将网络错误转译为用户可读的消息。
 * @param {Error} error 网络或解析错误
 * @returns {string} 用户可读的错误消息
 */
function translateError(error) {
  const msg = error.message;

  // 本项目 HttpError 携带 status
  if (error.status === 404) return '未找到 Release 数据，请确认软件配置正确';
  if (error.status === 403) return 'GitHub API 请求频率超限，请稍后再试';
  if (error.status === 500) return 'GitHub 服务暂时不可用';

  if (msg.includes('超时') || msg.includes('timeout')) return '请求超时，请检查网络连接';

  return msg || '加载版本历史时发生未知错误';
}