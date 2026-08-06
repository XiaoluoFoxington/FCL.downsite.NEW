import { mountBookmarkList } from './views/bookmarkView.js';

/**
 * 主页入口：在"网站导航"下方渲染收藏资源列表。
 */
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('home-bookmarks');
  if (container) mountBookmarkList(container);
});