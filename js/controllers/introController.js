import { getSoftware } from '../repositories/siteRepository.js';
import { getLocalizedText } from '../http/client.js';
import { createSafeContent } from '../security/content.js';
import {
  renderDocument,
  renderDocumentError,
  renderDocumentLoading,
  renderIntroError,
  renderIntroLoading,
  renderIntroPanels,
} from '../views/introView.js';
import { logError } from '../common/logger.js';

/**
 * 拼接介绍文档的完整 URL。
 * @param {{url?: string, file?: string}} item 文档配置项
 * @returns {string} 完整文档 URL
 */
function documentUrl(item) {
  // 数据文件习惯将 url 与 file 分开保存；手工拼接可保留 url 中可能存在的路径前缀。
  return `${String(item.url || '').replace(/\/$/, '')}/${String(item.file || '').replace(/^\//, '')}`;
}

/**
 * 介绍页 controller。
 * container 是整个正文区域；states 的值只会是 loading、ready、error 或 undefined，
 * 分别表示请求中、已缓存、上次失败、从未展开。
 */
export function createIntroController(container, softwareId) {
  // body 元素作为 WeakMap 键，页面销毁后状态可随 DOM 一起被回收。
  const states = new WeakMap();

  async function loadDocument(item, body) {
    const state = states.get(body);
    // 首次展开才加载；已经成功的正文不重复请求，正在加载时也不重复发起。
    if (state === 'loading' || state === 'ready') return;
    states.set(body, 'loading');
    renderDocumentLoading(body);
    try {
      const url = documentUrl(item);
      // 此请求发生在用户展开面板后，因此首屏不会下载 README/截图等非必要内容。
      // 本地文档优先取当前语言版本（如 intro.en-US.html），远程 README 保持原文。
      const rawContent = await getLocalizedText(url, { timeoutMs: 20000 });
      // 返回 DocumentFragment 而非 HTML 字符串，view 可以直接安全地替换正文节点。
      const fragment = await createSafeContent(rawContent, {
        type: item.type === 'md' ? 'md' : 'html',
        baseUrl: item.url,
      });
      renderDocument(body, fragment);
      states.set(body, 'ready');
    } catch (error) {
      logError(error, '介绍文档');
      states.set(body, 'error');
      renderDocumentError(body, error, () => loadDocument(item, body));
    }
  }

  async function load() {
    // 首屏只取软件元数据与文档目录；实际正文留给 loadDocument 懒加载。
    renderIntroLoading(container);
    try {
      const { basic, detail } = await getSoftware(softwareId);
      renderIntroPanels(container, basic, detail.intro || [], loadDocument);
    } catch (error) {
      logError(error, '介绍页');
      renderIntroError(container, error, load);
    }
  }
  return { load };
}
