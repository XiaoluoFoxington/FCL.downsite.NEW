import { renderStatus } from './commonView.js';

/** 切换筛选面板标题中“已有筛选条件”图标的显示。 */
export function setFilterIndicator(element, active) {
  element?.classList.toggle('xf-hide', !active);
}

/** 同时显示目录与标签两个并行请求的加载状态。 */
export function renderListLoading(elements) {
  renderStatus(elements.list, 'loading', { message: '正在加载软件目录……' });
  renderStatus(elements.tags, 'loading', { message: '正在加载标签……' });
  setFilterIndicator(elements.filterIndicator, false);
}

/** 目录失败时清空标签区，防止保留上一次加载的筛选按钮。 */
export function renderListError(elements, error, onRetry) {
  renderStatus(elements.list, 'error', { message: error.message, onRetry });
  elements.tags.replaceChildren();
  setFilterIndicator(elements.filterIndicator, false);
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
  const allButton = createTagButton('显示所有', '', true);
  fragment.appendChild(allButton);
  tags.forEach((tag) => fragment.appendChild(createTagButton(tag.name, String(tag.id))));
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

/**
 * 将 controller 已筛选好的软件目录渲染为表格。
 * tagMap 的键为数值 tag ID，值为标签名；没有标签时保留原 ID 便于发现配置问题。
 * openMethod 控制行点击后的默认跳转页面，来自用户行为设置偏好。
 */
export function renderSoftwareList(container, software, tagMap, openMethod = 'detail') {
  if (!software.length) {
    renderStatus(container, 'empty', { message: '没有符合条件的软件' });
    return;
  }
  const pagePath = OPEN_METHOD_PAGE_MAP[openMethod] || OPEN_METHOD_PAGE_MAP.detail;

  const table = document.createElement('table');
  table.className = 'mdui-table mdui-table-hoverable';

  const thead = document.createElement('thead');
  const headerRow = document.createElement('tr');
  ['图标', '名称', 'ID', '标签'].forEach((text) => {
    const th = document.createElement('th');
    th.textContent = text;
    headerRow.appendChild(th);
  });
  thead.appendChild(headerRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  software.forEach((item) => {
    const row = document.createElement('tr');
    row.className = 'xf-list-table-row';
    row.dataset.href = `${pagePath}?id=${item.id}`;
    row.tabIndex = 0;
    row.setAttribute('role', 'link');

    // 图标单元格
    const iconCell = document.createElement('td');
    const img = document.createElement('img');
    img.src = item.icon || '/media/img/picMissing.webp';
    img.alt = item.name;
    img.width = 64;
    img.height = 64;
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
    const tagNames = item.tagIds.map((id) => tagMap.get(id) || String(id));
    tagsCell.textContent = tagNames.join(', ');
    row.appendChild(tagsCell);

    tbody.appendChild(row);
  });
  table.appendChild(tbody);
  container.replaceChildren(table);

  // 事件委托：点击行跳转
  tbody.addEventListener('click', (event) => {
    const row = event.target.closest('tr');
    if (row?.dataset.href) {
      window.location.href = row.dataset.href;
    }
  });

  // 键盘支持：Enter 键触发跳转
  tbody.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') {
      const row = event.target.closest('tr');
      if (row?.dataset.href) {
        window.location.href = row.dataset.href;
      }
    }
  });
}


