import { getMirrors } from '../repositories/siteRepository.js';
import { getJSON } from '../http/client.js';
import {
  renderDownloadLines,
  renderContributors,
  renderUsedProjects,
  renderAboutLoading,
  renderAboutError,
} from '../views/aboutView.js';

/**
 * 关于页面 controller。
 * elements.downloadLines / contributors / usedProjects 分别对应页面中的三个挂载点。
 */
export function createAboutController(elements) {
  async function load() {
    renderAboutLoading(elements.downloadLines, 2);
    renderAboutLoading(elements.contributors);
    renderAboutLoading(elements.usedProjects, 6);

    try {
      const [mirrors, contributors, usedProjects] = await Promise.all([
        getMirrors(),
        getJSON('/data/contribute.json', { cache: true }),
        getJSON('/data/usedProj.json', { cache: true }),
      ]);

      // 三个渲染函数内部需要加载 DOMPurify 等依赖，必须 await 才能被外层 try/catch 统一捕获。
      await renderDownloadLines(elements.downloadLines, mirrors, contributors);
      await renderContributors(elements.contributors, contributors, mirrors);
      await renderUsedProjects(elements.usedProjects, usedProjects);
    } catch (error) {
      console.error('关于页面加载失败', error);
      renderAboutError(elements.downloadLines, error, load, 2);
      renderAboutError(elements.contributors, error, load);
      renderAboutError(elements.usedProjects, error, load, 6);
    }
  }

  return { load };
}