import { renderStatus, setFilterIndicator } from './commonView.js';
import { readPreference } from '../domain/preferences.js';
import { isBookmarked, toggleBookmark } from '../domain/bookmarks.js';
import { t, translateTag } from '../common/i18n.js';

/** 显示目录加载状态。 */
export function renderListLoading(elements) {
  renderStatus(elements.list, 'loading', { message: t('list.loadingCatalog') });
  setFilterIndicator(elements.filterIndicatorOn, elements.filterIndicatorOff, false);
}

/** 目录加载失败时显示错误与重试按钮。 */
export function renderListError(elements, error, onRetry) {
  renderStatus(elements.list, 'error', { message: error.message, onRetry });
  setFilterIndicator(elements.filterIndicatorOn, elements.filterIndicatorOff, false);
}

/**
 * 为筛选帮助面板中的可点击文本（[data-insert] 按钮）绑定插入行为。
 * 点击/回车/空格后在输入框光标处插入 data-insert 文本，并派发 input 事件让筛选重新解析；
 * 输入框未聚焦时插入到末尾。
 */
export function enableFilterHelpInserts(container, input) {
  if (!container || !input) return;

  const insert = (event) => {
    const token = event.target.closest('[data-insert]');
    if (!token) return;
    insertFilterText(input, token.dataset.insert);
  };
  const insertOnKeydown = (event) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    const token = event.target.closest('[data-insert]');
    if (!token) return;
    event.preventDefault();
    insertFilterText(input, token.dataset.insert);
  };

  container.addEventListener('click', insert);
  container.addEventListener('keydown', insertOnKeydown);
}

/** 把文本插入输入框：聚焦时在光标处插入，否则追加到末尾，然后触发 input 事件。 */
function insertFilterText(input, text) {
  if (document.activeElement === input && typeof input.setRangeText === 'function') {
    input.setRangeText(text, input.selectionStart ?? 0, input.selectionEnd ?? 0, 'end');
  } else {
    input.value += text;
  }
  input.focus();
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * 在筛选帮助面板中列出所有可用标签，点击/回车可插入 `tag: <标签名>` 到筛选输入框。
 * 按钮由 enableFilterHelpInserts 的事件委托统一接管，无需单独绑定。
 * 插入值使用标签原始名（筛选匹配以 tag.json 的原始名为准），与表格中翻译后的展示名区分。
 * @param {HTMLElement} container 标签列表容器（filter-help-tags）
 * @param {Array<{id: number, name: string}>} tags 标签数组
 */
export function renderFilterHelpTags(container, tags) {
  if (!container || !Array.isArray(tags)) return;
  const fragment = document.createDocumentFragment();
  const label = document.createElement('span');
  label.textContent = t('list.filterHelpTags');
  fragment.appendChild(label);
  tags.forEach((tag, index) => {
    const insert = `tag: ${tag.name}`;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'xf-inline-code xf-list-table-th-sortable';
    button.dataset.insert = insert;
    button.textContent = insert;
    fragment.appendChild(button);
    if (index < tags.length - 1) fragment.appendChild(document.createTextNode(', '));
  });
  container.replaceChildren(fragment);
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
    table.className = 'mdui-table mdui-table-hoverable xf-list-table xf-nowrap';
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


