import { renderStatus, setErrorTitle, setSoftwareHeader } from './commonView.js';
import { createPanel, createPanelItem } from './uiComponents.js';
import { t } from '../common/i18n.js';

/** 介绍目录仍在请求时显示的首屏状态。 */
export function renderIntroLoading(container) {
  renderStatus(container, 'loading', { message: t('intro.loadingDocList') });
}

/** 目录请求失败时的错误状态；重试只重新获取目录，不会预取正文。 */
export function renderIntroError(container, error, onRetry) {
  setErrorTitle();
  renderStatus(container, 'error', { message: error.message, onRetry });
}

/**
 * 创建每篇文档的 MDUI 折叠面板。
 * items 项结构为 { title, url, file, type }；onOpen 由 controller 提供，
 * 负责首次点击时的真实网络请求，view 本身不读取 item.url。
 */
export function renderIntroPanels(container, basic, items, onOpen) {
  setSoftwareHeader(basic, {
    titlePrefix: t('intro.title'),
    detailButton: document.getElementById('detailBtn'),
  });
  if (!items.length) {
    renderStatus(container, 'empty', { message: t('intro.noDocs') });
    return;
  }

  const fragment = document.createDocumentFragment();

  // 这里只创建折叠外壳；正文请求由 header 点击后的 onOpen 回调延后触发。
  const panel = createPanel();
  items.forEach((item, index) => {
    const { element: panelItem, header, body } = createPanelItem(
      item.title || t('intro.docN', { index: index + 1 }),
      { bodyClass: 'mdui-typo' },
    );
    // 空闲提示能让用户理解首次展开可能需要等待，而不是误以为内容丢失。
    renderStatus(body, 'idle', { message: t('intro.idle') });
    panel.appendChild(panelItem);
    header.addEventListener('click', () => onOpen(item, body));
  });
  fragment.appendChild(panel);
  container.replaceChildren(fragment);
  // 动态插入的面板需要通知 MDUI 重新扫描 data 属性。
  window.mdui?.mutation();
}

/** 单个已展开文档正在下载时的局部加载态。 */
export function renderDocumentLoading(container) {
  renderStatus(container, 'loading', { message: t('intro.loadingDoc') });
}

/** 将已经净化的 DocumentFragment 插入单个文档面板。 */
export function renderDocument(container, fragment) {
  container.replaceChildren(fragment);
  window.mdui?.mutation();
}

/** 单篇文档的错误不会影响其他面板；用户可只重试这一篇。 */
export function renderDocumentError(container, error, onRetry) {
  renderStatus(container, 'error', { message: t('intro.docLoadError', { message: error.message }), onRetry });
}
