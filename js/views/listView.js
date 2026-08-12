import { renderStatus } from './commonView.js';
import { readPreference } from '../domain/preferences.js';
import { isBookmarked, toggleBookmark } from '../domain/bookmarks.js';
import { t, translateTag } from '../common/i18n.js';

/** 切换筛选面板标题中“已有筛选条件”图标的显示。 */
export function setFilterIndicator(on, off, active) {
  if (active) {
    on?.removeAttribute('hidden');
    off?.setAttribute('hidden', '');
  } else {
    on?.setAttribute('hidden', '');
    off?.removeAttribute('hidden');
  }
}

/** 同时显示目录与标签两个并行请求的加载状态。 */
export function renderListLoading(elements) {
  renderStatus(elements.list, 'loading', { message: t('list.loadingCatalog') });
  renderStatus(elements.tags, 'loading', { message: t('list.loadingTags') });
  setFilterIndicator(elements.filterIndicatorOn, elements.filterIndicatorOff, false);
}

/** 目录失败时清空标签区，防止保留上一次加载的筛选按钮。 */
export function renderListError(elements, error, onRetry) {
  renderStatus(elements.list, 'error', { message: error.message, onRetry });
  elements.tags.replaceChildren();
  setFilterIndicator(elements.filterIndicatorOn, elements.filterIndicatorOff, false);
}

/**
 * 渲染可多选的标签按钮。
 * onChange 收到 Set<string>，空集合代表“显示所有”。
 */
export function renderFilterTags(container, tags, onChange) {
  // 事件委托只绑定在容器一次，后续按钮的视觉状态由 activeTagIds 单一来源驱动。
  // 重试场景下会再次调用本函数：先 abort 上一次的 AbortController，
  // 让旧监听器停止响应，避免一次点击触发多次 onChange（旧闭包仍指向已废弃的 Set）。
  if (container._tagFilterAbort) container._tagFilterAbort.abort();
  const ac = new AbortController();
  container._tagFilterAbort = ac;

  const activeTagIds = new Set();
  const fragment = document.createDocumentFragment();
  const allButton = createTagButton(t('common.showAll'), '', true);
  fragment.appendChild(allButton);
  tags.forEach((tag) => fragment.appendChild(createTagButton(translateTag(tag.name), String(tag.id))));
  container.replaceChildren(fragment);

  container.addEventListener('click', (event) => {
    const button = event.target.closest('button[data-tag-id]');
    if (!button) return;
    const tagId = button.dataset.tagId;
    // “显示所有”不是一个普通标签：它清空集合，其他标签则允许多选。
    if (!tagId) activeTagIds.clear();
    else if (activeTagIds.has(tagId)) activeTagIds.delete(tagId);
    else activeTagIds.add(tagId);

    container.querySelectorAll('button[data-tag-id]').forEach((candidate) => {
      const id = candidate.dataset.tagId;
      candidate.classList.toggle('mdui-color-theme-accent', id ? activeTagIds.has(id) : activeTagIds.size === 0);
      candidate.setAttribute('aria-pressed', id ? String(activeTagIds.has(id)) : String(activeTagIds.size === 0));
    });
    // 传副本而非内部 Set，防止 controller 意外修改 view 持有的状态。
    onChange(new Set(activeTagIds));
  }, { signal: ac.signal });

  // 垂直滚动时改为水平滚动
  container.addEventListener('wheel', function (e) {
    // 如果用户按了 Shift 键，浏览器会原生处理水平滚动，我们就不干预
    if (e.shiftKey) return;

    // 阻止页面上下滚动
    e.preventDefault();

    // 把垂直滚动增量 deltaY 转为水平滚动增量
    container.scrollBy({
      left: e.deltaY,
      behavior: 'smooth'
    });
  }, { passive: false, signal: ac.signal });
}

/** 创建单个可访问的 button，不使用无 href 的 a 标签模拟按钮。 */
function createTagButton(label, tagId, selected = false) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mdui-btn mdui-btn-raised mdui-ripple mdui-m-a-1';
  button.classList.toggle('mdui-color-theme-accent', selected);
  button.textContent = label;
  button.dataset.tagId = tagId;
  button.setAttribute('aria-pressed', String(selected));
  return button;
}

/** 打开方式值到页面路径的映射。 */
const OPEN_METHOD_PAGE_MAP = {
  detail: '/html/detail.html',
  download: '/html/down.html',
  doc: '/html/intro.html',
  history: '/html/rh.html',
};

/** 排序状态 */
let sortKey = 'id';
let sortDirection = 'asc';

/** 缓存当前渲染数据，避免排序时重复传参 */
let _software = [];
let _tagMap = new Map();
let _openMethod = 'detail';
let _pagePath = '';
let _container = null;

/**
 * 对软件列表进行排序（不修改原数组）。
 */
function sortSoftware() {
  if (!sortKey) return _software;
  const sorted = [..._software];
  sorted.sort((a, b) => {
    let cmp;
    if (sortKey === 'name') {
      cmp = a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    } else {
      cmp = a.id - b.id;
    }
    return sortDirection === 'asc' ? cmp : -cmp;
  });
  return sorted;
}

/** 创建表头（仅首次调用）。 */
function createThead() {
  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  const headers = [
    { text: t('list.header.icon'), sortable: false, key: null },
    { text: t('list.header.name'), sortable: true, key: 'name' },
    { text: 'ID', sortable: true, key: 'id' },
    { text: t('list.header.tags'), sortable: false, key: null },
    { text: t('list.header.bookmark'), sortable: false, key: null },
  ];
  headers.forEach(({ text, sortable, key }) => {
    const th = document.createElement('th');
    th.textContent = text;
    if (sortable) {
      th.className = 'xf-list-table-th-sortable';
      th.dataset.sortKey = key;
      th.tabIndex = 0;
      th.setAttribute('aria-label', t('common.sortBy', { text }));
    }
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  return thead;
}

/** 更新表头排序指示符（▲/▼）。 */
function updateSortIndicators(thead) {
  thead.querySelectorAll('th[data-sort-key]').forEach((th) => {
    const isActive = th.dataset.sortKey === sortKey;
    th.classList.toggle('xf-list-table-th-sorted', isActive);
    th.setAttribute('aria-sort', isActive ? (sortDirection === 'asc' ? 'ascending' : 'descending') : 'none');
    let indicator = th.querySelector('.xf-list-table-sort-indicator');
    if (isActive) {
      if (!indicator) {
        indicator = document.createElement('span');
        indicator.className = 'xf-list-table-sort-indicator';
        th.appendChild(indicator);
      }
      indicator.textContent = sortDirection === 'asc' ? ' ▲' : ' ▼';
    } else {
      indicator?.remove();
    }
  });
}

/** 渲染 tbody 行（排序后的数据）。 */
function renderTableBody(tbody, iconSize) {
  const sorted = sortSoftware();
  const fragment = document.createDocumentFragment();
  sorted.forEach((item) => {
    const row = document.createElement('tr');
    row.className = 'xf-list-table-row';
    row.dataset.href = `${_pagePath}?id=${item.id}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'link');

    // 图标单元格
    const iconCell = document.createElement('td');
    const img = document.createElement('img');
    img.src = item.icon || '/media/img/picMissing.webp';
    img.alt = item.name;
    img.width = iconSize;
    img.height = iconSize;
    img.loading = 'lazy';
    img.className = 'xf-list-table-icon';
    iconCell.appendChild(img);
    iconCell.classList.add('xf-list-table-col-icon');
    row.appendChild(iconCell);

    // 名称单元格
    const nameCell = document.createElement('td');
    nameCell.textContent = item.name;
    row.appendChild(nameCell);

    // ID 单元格
    const idCell = document.createElement('td');
    idCell.textContent = item.id;
    row.appendChild(idCell);

    // 标签单元格
    const tagsCell = document.createElement('td');
    const tagNames = item.tagIds.map((id) => translateTag(_tagMap.get(id) || String(id)));
    tagsCell.textContent = tagNames.join(', ');
    row.appendChild(tagsCell);

    // 收藏单元格
    const bookmarkCell = document.createElement('td');
    bookmarkCell.dataset.bookmarkId = item.id;
    bookmarkCell.classList.add('mdui-typo');
    const bookmarkLink = document.createElement('a');
    bookmarkLink.className = 'xf-bookmark-link';
    bookmarkLink.href = 'javascript:void(0)';
    bookmarkLink.textContent = isBookmarked(item.id) ? t('common.yes') : t('common.no');
    bookmarkCell.appendChild(bookmarkLink);
    row.appendChild(bookmarkCell);

    fragment.appendChild(row);
  });
  tbody.replaceChildren(fragment);
}

/** 表格点击事件委托：排序（表头）/ 导航（数据行）/ 收藏（切换）。 */
function handleTableClick(event) {
  const bookmarkLink = event.target.closest('.xf-bookmark-link');
  if (bookmarkLink) {
    event.stopPropagation();
    const cell = bookmarkLink.closest('[data-bookmark-id]');
    const id = Number(cell.dataset.bookmarkId);
    const item = _software.find((s) => s.id === id);
    if (item) {
      const nowBookmarked = toggleBookmark({ id: item.id, name: item.name, icon: item.icon });
      bookmarkLink.textContent = nowBookmarked ? t('common.yes') : t('common.no');
    }
    return;
  }

  const th = event.target.closest('th[data-sort-key]');
  if (th) {
    const key = th.dataset.sortKey;
    if (sortKey === key) {
      sortDirection = sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      sortKey = key;
      sortDirection = 'asc';
    }
    renderSoftwareList(_container, _software, _tagMap, _openMethod);
    return;
  }
  const row = event.target.closest('tr[data-href]');
  if (row) {
    window.location.href = row.dataset.href;
  }
}

/** 表格键盘事件委托：Enter/Space 导航或排序。 */
function handleTableKeydown(event) {
  if (event.key === 'Enter' || event.key === ' ') {
    // 焦点在收藏链接上时只切换收藏，不能触发整行跳转。
    const bookmarkLink = event.target.closest('.xf-bookmark-link');
    if (bookmarkLink) {
      event.preventDefault();
      bookmarkLink.click();
      return;
    }
    event.preventDefault();
    const th = event.target.closest('th[data-sort-key]');
    if (th) {
      th.click();
      return;
    }
    const row = event.target.closest('tr[data-href]');
    if (row) {
      window.location.href = row.dataset.href;
    }
  }
}

/**
 * 将 controller 已筛选好的软件目录渲染为表格。
 * 首次渲染创建完整表格，后续排序只更新 tbody 和表头指示符，避免不必要的 DOM 重建。
 * tagMap 的键为数值 tag ID，值为标签名；没有标签时保留原 ID 便于发现配置问题。
 * openMethod 控制行点击后的默认跳转页面，来自用户行为设置偏好。
 */
export function renderSoftwareList(container, software, tagMap, openMethod = 'detail') {
  _software = software;
  _tagMap = tagMap;
  _openMethod = openMethod;
  _pagePath = OPEN_METHOD_PAGE_MAP[openMethod] || OPEN_METHOD_PAGE_MAP.detail;
  _container = container;

  if (!software.length) {
    renderStatus(container, 'empty', { message: t('list.noMatch') });
    return;
  }

  let table = container.querySelector('.xf-list-table');
  if (!table) {
    // 首次：创建完整表格，事件委托绑定在 table 上，避免重复绑定
    table = document.createElement('table');
    table.className = 'mdui-table mdui-table-hoverable xf-list-table';
    table.appendChild(createThead());
    table.appendChild(document.createElement('tbody'));
    container.replaceChildren(table);
    table.addEventListener('click', handleTableClick);
    table.addEventListener('keydown', handleTableKeydown);
  }

  // 后续：只更新表头指示符和 tbody
  updateSortIndicators(table.querySelector('thead'));
  const iconSize = readPreference('fdn-list-icon-size', 32);
  renderTableBody(table.querySelector('tbody'), iconSize);
}


