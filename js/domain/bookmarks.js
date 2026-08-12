import { logWarn } from '../common/logger.js';

/**
 * 收藏资源管理器。
 * 封装 localStorage 的收藏读写，支持事件通知。
 */

const STORAGE_KEY = 'fdn-bookmarks';
const CHANGE_EVENT = 'bookmark-change';

/**
 * 默认收藏（替代"快速访问"）。
 * 收藏夹为空（首次访问、从未保存过收藏）时自动收藏 FCL 与 MG，
 * 让"资源收藏"面板直接充当快速访问入口，而不是空空如也。
 */
const DEFAULT_BOOKMARKS = [
  { id: 0, name: 'Fold Craft Launcher', icon: '/data/software/0/icon.avif' },
  { id: 1, name: 'MobileGlues', icon: '/data/software/1/icon.avif' },
];

/**
 * 获取所有收藏资源。
 * @returns {Array<{id: number, name: string, icon: string}>}
 */
export function getBookmarks() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    // localStorage 被篡改/写坏时降级为空列表，避免后续方法抛 TypeError。
    return Array.isArray(parsed) ? parsed : [];
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
 * 确保默认收藏已写入。
 * 仅在 localStorage 从未写入过收藏键（即收藏夹为空、首次访问）时，
 * 自动写入 FCL 与 MG 作为快速访问替代；用户手动清空（键存在但为空数组）
 * 后不再自动补回，尊重用户选择。
 * @returns {boolean} 是否写入了默认收藏
 */
export function ensureDefaultBookmarks() {
  try {
    if (localStorage.getItem(STORAGE_KEY) !== null) return false;
    saveBookmarks(DEFAULT_BOOKMARKS);
    notifyChange();
    return true;
  } catch (error) {
    logWarn(error, '写入默认收藏');
    return false;
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
