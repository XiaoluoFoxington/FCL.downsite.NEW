import { logWarn } from '../common/logger.js';

/**
 * 收藏资源管理器。
 * 封装 localStorage 的收藏读写，支持事件通知。
 */

const STORAGE_KEY = 'fdn-bookmarks';
const CHANGE_EVENT = 'bookmark-change';

/**
 * 获取所有收藏资源。
 * @returns {Array<{id: number, name: string, icon: string}>}
 */
export function getBookmarks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    logWarn(error, '读取收藏');
    return [];
  }
}

/**
 * 保存收藏列表。
 * @param {Array} bookmarks
 */
function saveBookmarks(bookmarks) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bookmarks));
  } catch (error) {
    logWarn(error, '保存收藏');
  }
}

/**
 * 添加收藏。
 * @param {{id: number, name: string, icon?: string}} item
 */
export function addBookmark(item) {
  const bookmarks = getBookmarks();
  if (bookmarks.some((b) => b.id === item.id)) return;
  bookmarks.push({ id: item.id, name: item.name, icon: item.icon || '' });
  saveBookmarks(bookmarks);
  notifyChange();
}

/**
 * 移除收藏。
 * @param {number} id
 */
export function removeBookmark(id) {
  const bookmarks = getBookmarks().filter((b) => b.id !== id);
  saveBookmarks(bookmarks);
  notifyChange();
}

/**
 * 检查是否已收藏。
 * @param {number} id
 * @returns {boolean}
 */
export function isBookmarked(id) {
  return getBookmarks().some((b) => b.id === id);
}

/**
 * 切换收藏状态。
 * @param {{id: number, name: string, icon?: string}} item
 * @returns {boolean} 新状态（true=已收藏）
 */
export function toggleBookmark(item) {
  if (isBookmarked(item.id)) {
    removeBookmark(item.id);
    return false;
  }
  addBookmark(item);
  return true;
}

/**
 * 触发收藏变更事件。
 */
function notifyChange() {
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
}

/**
 * 监听收藏变更。
 * @param {Function} callback
 */
export function onBookmarkChange(callback) {
  window.addEventListener(CHANGE_EVENT, callback);
}

/**
 * 取消监听收藏变更。
 * @param {Function} callback
 */
export function offBookmarkChange(callback) {
  window.removeEventListener(CHANGE_EVENT, callback);
}