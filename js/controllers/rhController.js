import { getSoftware } from '../repositories/siteRepository.js';
import { getJSON } from '../http/client.js';
import { renderReleases, renderRhError, renderRhLoading } from '../views/rhView.js';
import { logError } from '../common/logger.js';
import { t } from '../common/i18n.js';

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
        throw new Error(t('rh.noReleaseUrl'));
      }
      if (!releaseUrl.startsWith('https://api.github.com/')) {
        throw new Error(t('rh.invalidReleaseUrl'));
      }

      const releases = await getJSON(releaseUrl, { timeoutMs: 20000 });
      if (!Array.isArray(releases)) {
        throw new Error(t('rh.invalidReleaseData'));
      }

      await renderReleases(container, basic, releases);
    } catch (error) {
      logError(error, '版本历史');
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

  if (error.kind === 'timeout') return t('rh.timeout');
  // 本项目 HttpError 携带 status
  if (error.status === 404) return t('rh.notFound');
  if (error.status === 403) return t('rh.rateLimited');
  if (error.status === 500) return t('rh.serverError');

  if (msg.includes('超时')) return t('rh.timeout');

  return msg || t('rh.unknownError');
}
