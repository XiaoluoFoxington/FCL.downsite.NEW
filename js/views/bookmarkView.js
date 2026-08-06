/**
 * 收藏资源视图。
 * 负责在主页和抽屉中渲染收藏资源列表。
 * 导出可复用的渲染函数。
 */

import { getBookmarks, onBookmarkChange, offBookmarkChange } from '../domain/bookmarks.js';

/**
 * 创建单个收藏按钮链接。
 * @param {{id: number, name: string, icon?: string}} item
 * @returns {HTMLAnchorElement}
 */
export function createBookmarkButton(item) {
  const btn = document.createElement('a');
  btn.className = 'mdui-btn mdui-btn-block mdui-btn-raised mdui-ripple';
  btn.href = `/html/detail.html?id=${item.id}`;

  const img = document.createElement('img');
  img.className = 'xf-bookmark-icon';
  img.src = item.icon || '/media/img/picMissing.webp';
  img.alt = item.name;
  img.width = 24;
  img.height = 24;
  img.loading = 'lazy';

  btn.append(img, document.createTextNode(` ${item.name}`));
  return btn;
}

/**
 * 渲染收藏列表。
 * @param {HTMLElement} container
 * @returns {number} 收藏数量
 */
export function renderBookmarkList(container) {
  const bookmarks = getBookmarks();
  const fragment = document.createDocumentFragment();
  bookmarks.forEach((item) => fragment.appendChild(createBookmarkButton(item)));
  container.replaceChildren(fragment);
  return bookmarks.length;
}

/**
 * 切换收藏面板的可见性（无收藏项时隐藏整个面板）。
 * @param {HTMLElement} container 收藏列表容器
 */
function syncPanelVisibility(container) {
  const panel = container.closest('.mdui-panel-item');
  if (!panel) return;
  const count = getBookmarks().length;
  panel.hidden = count === 0;
}

/**
 * 在容器中挂载收藏资源列表，自动监听变更并更新。
 * 同时控制所在面板的可见性（无收藏项时隐藏整个面板）。
 * @param {HTMLElement} container
 * @returns {Function} 清理函数
 */
export function mountBookmarkList(container) {
  renderBookmarkList(container);
  syncPanelVisibility(container);
  window.mdui?.mutation();
  const handler = () => {
    renderBookmarkList(container);
    syncPanelVisibility(container);
    window.mdui?.mutation();
  };
  onBookmarkChange(handler);
  return () => offBookmarkChange(handler);
}