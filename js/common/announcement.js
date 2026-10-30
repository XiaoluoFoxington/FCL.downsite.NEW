import { getLocalizedJSON } from '../http/client.js';
import { readPreference, writePreference } from '../domain/preferences.js';
import { renderStatus } from '../views/commonView.js';
import { createMaterialIcon } from '../views/uiComponents.js';
import { createSafeContent } from '../security/content.js';
import { logWarn, logError } from '../common/logger.js';
import { t, getCurrentLang } from './i18n.js';

/**
 * 网站公告模块。
 * 从 data/announcements.json 读取结构化公告列表，并在侧边栏最顶部渲染公告面板。
 *
 * 相比旧版单条 HTML 公告，本模块支持：
 * - 多条公告、置顶排序、分级（普通/更新/注意/重要）；
 * - 按公告 ID 记录已读状态，面板标题显示未读数量；
 * - 逐条展开阅读并自动标记已读，支持一键全部已读；
 * - 语言切换后按语言分别维护已读状态，并自动迁移旧版哈希已读记录。
 *
 * 数据格式（data/announcements.json，按语言后缀提供本地化版本）：
 * {
 *   "items": [
 *     {
 *       "id": "唯一 ID（字符串）",
 *       "title": "标题",
 *       "summary": "折叠时显示的摘要（可选）",
 *       "content": "展开后显示的 HTML（经 DOMPurify 净化）",
 *       "date": "2026-10-30",
 *       "level": "info | success | warning | danger",
 *       "pinned": true
 *     }
 *   ]
 * }
 */

const ANNOUNCEMENTS_URL = '/data/announcements.json';

/** 已读状态存储键前缀（后接语言代码）。 */
const READ_STORAGE_PREFIX = 'fdn-announcement-read-';

/** 旧版按内容哈希记录已读的存储键前缀，仅用于迁移。 */
const LEGACY_STORAGE_PREFIX = 'fdn-announcement-';

/** 公告分级对应的图标与标题文案。 */
const LEVELS = {
  info: { icon: 'info', labelKey: 'common.announcementLevelInfo' },
  success: { icon: 'check_circle', labelKey: 'common.announcementLevelSuccess' },
  warning: { icon: 'warning', labelKey: 'common.announcementLevelWarning' },
  danger: { icon: 'error', labelKey: 'common.announcementLevelDanger' },
};

/** 当前语言的已读状态存储键。 */
function readStorageKey() {
  return `${READ_STORAGE_PREFIX}${getCurrentLang()}`;
}

/** 旧版当前语言的已读状态存储键。 */
function legacyStorageKey() {
  return `${LEGACY_STORAGE_PREFIX}${getCurrentLang()}`;
}

/**
 * 解析日期字段。纯日期按本地时区构造，避免 Date.parse 将其当作 UTC 导致跨时区偏移一天。
 * @param {string} value 日期字符串
 * @returns {Date|null}
 */
function parseDate(value) {
  if (typeof value !== 'string' || !value) return null;
  const dateOnly = /^(\d{4})-(\d{1,2})-(\d{1,2})/.exec(value);
  if (dateOnly) {
    return new Date(Number(dateOnly[1]), Number(dateOnly[2]) - 1, Number(dateOnly[3]));
  }
  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? null : new Date(timestamp);
}

/**
 * 将日期格式化为当前语言的本地化日期；无法解析时原样返回。
 * @param {string} value 日期字符串
 * @returns {string}
 */
function formatDate(value) {
  const date = parseDate(value);
  if (!date) return value;
  try {
    return new Intl.DateTimeFormat(getCurrentLang(), {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    }).format(date);
  } catch (_) {
    return value;
  }
}

/**
 * 规范化远程公告数据：过滤无效项、去重，并按“置顶优先、日期倒序”排序。
 * @param {unknown} raw 远程 JSON
 * @returns {Array<object>}
 */
function normalizeItems(raw) {
  const source = Array.isArray(raw)
    ? raw
    : (raw && Array.isArray(raw.items) ? raw.items : []);
  const seen = new Set();
  const items = [];

  source.forEach((entry) => {
    if (!entry || typeof entry !== 'object') return;
    const id = String(entry.id ?? '').trim();
    const title = typeof entry.title === 'string' ? entry.title.trim() : '';
    const content = typeof entry.content === 'string' ? entry.content.trim() : '';
    const summary = typeof entry.summary === 'string' ? entry.summary.trim() : '';
    if (!id || !title || (!content && !summary) || seen.has(id)) return;

    seen.add(id);
    items.push({
      id,
      title,
      summary,
      content,
      date: typeof entry.date === 'string' ? entry.date.trim() : '',
      level: LEVELS[entry.level] ? entry.level : 'info',
      pinned: entry.pinned === true,
    });
  });

  items.sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    const aTime = parseDate(a.date)?.getTime() ?? 0;
    const bTime = parseDate(b.date)?.getTime() ?? 0;
    return bTime - aTime;
  });

  return items;
}

/**
 * 解析存储的已读 ID 集合；格式错误时视为没有记录。
 * @param {string|null} raw 原始存储值
 * @returns {Set<string>|null}
 */
function parseStoredIds(raw) {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return new Set(parsed.filter((id) => typeof id === 'string' && id));
    }
  } catch (error) {
    logWarn(error, t('logger.context.announcement'), { noToast: true });
  }
  return null;
}

/**
 * 写入已读 ID，并清理已不在公告列表中的旧 ID，避免存储无限增长。
 * @param {Set<string>} ids 已读 ID 集合
 * @param {Array<object>} items 当前公告列表
 */
function persistReadIds(ids, items) {
  const knownIds = new Set(items.map((item) => item.id));
  const retained = Array.from(ids).filter((id) => knownIds.has(id));
  writePreference(readStorageKey(), JSON.stringify(retained));
}

/**
 * 读取当前语言的已读 ID 集合。
 * 首次升级时若存在旧版内容哈希记录，则把当前公告全部视为已读，实现无感迁移。
 * @param {Array<object>} items 当前公告列表
 * @returns {Set<string>}
 */
function loadReadIds(items) {
  const stored = parseStoredIds(readPreference(readStorageKey()));
  if (stored) return stored;

  if (readPreference(legacyStorageKey())) {
    const migrated = new Set(items.map((item) => item.id));
    persistReadIds(migrated, items);
    // 写入空字符串而非删除：旧版逻辑只在值非空时才判断，等价于已迁移且避免再次触发。
    writePreference(legacyStorageKey(), '');
    return migrated;
  }

  return new Set();
}

/**
 * 获取公告列表（优先当前语言的本地化数据）。
 * @returns {Promise<Array<object>>}
 */
async function fetchAnnouncements() {
  const raw = await getLocalizedJSON(ANNOUNCEMENTS_URL, { cache: true });
  return normalizeItems(raw);
}

/**
 * 提前获取公告并判断是否有未读项（不渲染）。
 * 窄屏下抽屉懒加载，外部可在页面加载时调用此函数提前判断，避免 snackbar 等提醒被延迟。
 *
 * @returns {Promise<{items: Array<object>, readIds: Set<string>, unread: Array<object>, isNew: boolean}|null>}
 *   公告信息，加载失败返回 null
 */
export async function checkNewAnnouncement() {
  try {
    const items = await fetchAnnouncements();
    const readIds = loadReadIds(items);
    const unread = items.filter((item) => !readIds.has(item.id));
    return { items, readIds, unread, isNew: unread.length > 0 };
  } catch (error) {
    logError(error, t('logger.context.announcement'));
    return null;
  }
}

/**
 * 创建公告面板标题。
 * @param {Array<object>} items 公告列表
 * @param {Set<string>} readIds 已读 ID 集合
 * @returns {HTMLDivElement}
 */
function createHeader(items, readIds) {
  const header = document.createElement('div');
  header.className = 'mdui-panel-item-header mdui-ripple';

  const title = document.createElement('div');
  title.className = 'xf-announcement-header-title';
  title.append(
    createMaterialIcon('campaign', { className: 'xf-announcement-header-icon' }),
    document.createTextNode(t('common.nav.announcement'))
  );

  const badge = document.createElement('span');
  badge.className = 'xf-announcement-badge';
  badge.hidden = true;

  const arrow = createMaterialIcon('keyboard_arrow_down', { className: 'mdui-panel-item-arrow mdui-icon' });
  header.append(title, badge, arrow);

  updateUnreadIndicators(header, items, readIds);
  return header;
}

/**
 * 创建公告工具栏（未读状态 + 全部已读按钮）。
 * @returns {{ element: HTMLDivElement, status: HTMLElement, markAll: HTMLButtonElement }}
 */
function createToolbar() {
  const toolbar = document.createElement('div');
  toolbar.className = 'xf-announcement-toolbar';

  const status = document.createElement('span');
  status.className = 'xf-announcement-toolbar-status';
  status.setAttribute('aria-live', 'polite');

  const markAll = document.createElement('button');
  markAll.type = 'button';
  markAll.className = 'mdui-btn mdui-btn-icon mdui-ripple xf-announcement-mark-all';
  markAll.setAttribute('aria-label', t('common.announcementMarkAllRead'));
  markAll.title = t('common.announcementMarkAllRead');
  markAll.appendChild(createMaterialIcon('done_all'));

  toolbar.append(status, markAll);
  return { element: toolbar, status, markAll };
}

/**
 * 创建单条公告的折叠项。
 * @param {object} item 公告数据
 * @param {DocumentFragment|null} contentFragment 净化后的正文
 * @param {boolean} isUnread 是否未读
 * @returns {HTMLDetailsElement}
 */
function createAnnouncementItem(item, contentFragment, isUnread) {
  const level = LEVELS[item.level];
  const details = document.createElement('details');
  details.className = `xf-announcement-item xf-announcement-level-${item.level}`;
  details.dataset.id = item.id;
  details.classList.toggle('xf-announcement-item-unread', isUnread);

  const summary = document.createElement('summary');
  summary.className = 'xf-announcement-item-summary';

  const levelIcon = createMaterialIcon(level.icon, { className: 'xf-announcement-item-icon' });
  levelIcon.setAttribute('aria-hidden', 'true');

  const main = document.createElement('span');
  main.className = 'xf-announcement-item-main';

  const titleLine = document.createElement('span');
  titleLine.className = 'xf-announcement-item-titleline';

  const title = document.createElement('span');
  title.className = 'xf-announcement-item-title';
  title.textContent = item.title;
  titleLine.appendChild(title);

  if (item.pinned) {
    const pin = createMaterialIcon('push_pin', { className: 'xf-announcement-pin' });
    pin.title = t('common.announcementPinned');
    pin.setAttribute('aria-label', t('common.announcementPinned'));
    titleLine.appendChild(pin);
  }

  const unreadDot = document.createElement('span');
  unreadDot.className = 'xf-announcement-unread-dot';
  unreadDot.hidden = !isUnread;
  unreadDot.setAttribute('aria-label', t('common.announcementNew'));
  unreadDot.title = t('common.announcementNew');
  titleLine.appendChild(unreadDot);

  const meta = document.createElement('span');
  meta.className = 'xf-announcement-item-meta';
  const date = document.createElement('span');
  date.className = 'xf-announcement-item-date';
  date.textContent = formatDate(item.date);
  const levelLabel = document.createElement('span');
  levelLabel.className = 'xf-announcement-item-level-label';
  levelLabel.textContent = t(level.labelKey);
  meta.append(date, levelLabel);

  const preview = document.createElement('span');
  preview.className = 'xf-announcement-item-preview';
  preview.textContent = item.summary;
  preview.hidden = !item.summary;

  main.append(titleLine, meta, preview);

  const arrow = createMaterialIcon('expand_more', { className: 'xf-announcement-item-arrow' });
  arrow.setAttribute('aria-hidden', 'true');
  summary.append(levelIcon, main, arrow);

  const body = document.createElement('div');
  body.className = 'xf-announcement-item-content mdui-typo';
  if (contentFragment) {
    body.appendChild(contentFragment);
  } else {
    const fallback = document.createElement('p');
    fallback.textContent = item.summary || item.title;
    body.appendChild(fallback);
  }

  details.append(summary, body);
  return details;
}

/**
 * 更新未读徽标、工具栏状态以及每条公告的未读标记。
 * @param {HTMLElement} root 公告面板容器
 * @param {Array<object>} items 公告列表
 * @param {Set<string>} readIds 已读 ID 集合
 */
function updateUnreadIndicators(root, items, readIds) {
  const unreadCount = items.reduce((count, item) => count + (readIds.has(item.id) ? 0 : 1), 0);

  const badge = root.querySelector('.xf-announcement-badge');
  if (badge) {
    badge.textContent = unreadCount > 99 ? '99+' : String(unreadCount);
    badge.hidden = unreadCount === 0;
    badge.title = t('common.announcementUnreadCount', { count: unreadCount });
    badge.setAttribute('aria-label', badge.title);
  }

  const status = root.querySelector('.xf-announcement-toolbar-status');
  if (status) {
    status.textContent = unreadCount
      ? t('common.announcementUnreadCount', { count: unreadCount })
      : t('common.announcementAllRead');
  }

  const markAll = root.querySelector('.xf-announcement-mark-all');
  if (markAll) {
    markAll.disabled = unreadCount === 0;
    markAll.setAttribute('aria-disabled', String(unreadCount === 0));
  }

  root.querySelectorAll('details.xf-announcement-item').forEach((details) => {
    const unread = !readIds.has(details.dataset.id);
    details.classList.toggle('xf-announcement-item-unread', unread);
    const dot = details.querySelector('.xf-announcement-unread-dot');
    if (dot) dot.hidden = !unread;
  });
}

/**
 * 标记单条公告为已读。
 * @param {string} id 公告 ID
 * @param {Array<object>} items 公告列表
 * @param {Set<string>} readIds 已读 ID 集合
 * @param {HTMLElement} root 公告面板容器
 */
function markItemRead(id, items, readIds, root) {
  if (readIds.has(id)) return;
  readIds.add(id);
  persistReadIds(readIds, items);
  updateUnreadIndicators(root, items, readIds);
}

/**
 * 渲染公告面板。
 * @param {HTMLElement} container 公告容器（mdui-panel-item）
 * @param {Array<object>} items 公告列表
 * @param {Set<string>} readIds 已读 ID 集合
 * @param {AbortController} ac 用于清理事件监听
 * @returns {Promise<void>}
 */
async function renderAnnouncement(container, items, readIds, ac) {
  // 公告正文经 DOMPurify 净化后插入，与介绍页/描述等模块保持安全策略一致。
  const contentFragments = await Promise.all(items.map(async (item) => {
    if (!item.content) return null;
    try {
      return await createSafeContent(item.content, { type: 'html' });
    } catch (error) {
      logWarn(error, t('logger.context.announcement'), { noToast: true });
      return null;
    }
  }));

  if (ac.signal.aborted) return;

  const header = createHeader(items, readIds);
  const { element: toolbar, markAll } = createToolbar();
  const list = document.createElement('div');
  list.className = 'xf-announcement-list';

  const detailsList = items.map((item, index) =>
    createAnnouncementItem(item, contentFragments[index], !readIds.has(item.id))
  );
  list.append(...detailsList);

  const body = document.createElement('div');
  body.className = 'mdui-panel-item-body';
  body.append(toolbar, list);

  container.replaceChildren(header, body);
  updateUnreadIndicators(container, items, readIds);
  window.mdui?.mutation();

  // 展开任一条公告即视为已读；toggle 不冒泡，因此在列表容器上以捕获阶段监听。
  list.addEventListener('toggle', (event) => {
    const details = event.target;
    if (!(details instanceof HTMLDetailsElement) || !details.open) return;
    markItemRead(details.dataset.id, items, readIds, container);
  }, { capture: true, signal: ac.signal });

  markAll.addEventListener('click', () => {
    items.forEach((item) => readIds.add(item.id));
    persistReadIds(readIds, items);
    updateUnreadIndicators(container, items, readIds);
  }, { signal: ac.signal });

  // 用户展开公告面板时，自动打开第一条未读公告，省去再点一次的成本。
  container.addEventListener('open.mdui.panel', () => {
    if (list.querySelector('details.xf-announcement-item[open]')) return;
    const firstUnread = list.querySelector('details.xf-announcement-item-unread');
    if (firstUnread) firstUnread.open = true;
  }, { signal: ac.signal });
}

/**
 * 加载公告内容并渲染到指定容器中。
 * 使用统一状态机：loading → ready / empty / error。
 *
 * @param {HTMLElement} container 公告面板挂载容器
 */
export async function loadAnnouncement(container) {
  if (!container) return;

  // 重试时先取消上一次的事件监听，避免重复绑定。
  container._announcementAbort?.abort();
  const ac = new AbortController();
  container._announcementAbort = ac;

  renderStatus(container, 'loading', { message: t('common.announcementLoading') });
  try {
    const items = await fetchAnnouncements();
    if (ac.signal.aborted) return;
    if (!items.length) {
      renderStatus(container, 'empty', { message: t('common.announcementEmpty') });
      return;
    }
    const readIds = loadReadIds(items);
    await renderAnnouncement(container, items, readIds, ac);
  } catch (error) {
    if (ac.signal.aborted) return;
    logError(error, t('logger.context.announcement'));
    renderStatus(container, 'error', { message: error.message, onRetry: () => loadAnnouncement(container) });
  }
}
