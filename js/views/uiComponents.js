/**
 * 通用 UI 控件工厂。
 * 集中管理 MDUI 面板、表格、按钮、链接等常用 DOM 结构的创建，
 * 各视图模块通过组合这些工厂函数构建页面，避免重复拼接相同结构。
 */

/**
 * 创建 MDUI 面板容器。
 * @returns {HTMLDivElement}
 */
export function createPanel() {
  const panel = document.createElement('div');
  panel.className = 'mdui-panel';
  panel.setAttribute('mdui-panel', '');
  return panel;
}

/**
 * 创建 MDUI 面板项。
 * @param {string} title - 面板标题文本
 * @param {object} [options]
 * @param {boolean} [options.isOpen=false] - 是否默认展开
 * @param {string|string[]} [options.summary] - 标题旁的摘要文本
 * @param {string} [options.bodyClass] - 面板内容区额外类名（如 'mdui-typo'）
 * @returns {{ element: HTMLDivElement, header: HTMLDivElement, body: HTMLDivElement }}
 */
export function createPanelItem(title, { isOpen = false, summary, bodyClass } = {}) {
  const item = document.createElement('div');
  item.className = `mdui-panel-item${isOpen ? ' mdui-panel-item-open' : ''}`;

  const header = document.createElement('div');
  header.className = 'mdui-panel-item-header mdui-ripple';

  const titleDiv = document.createElement('div');
  titleDiv.className = 'mdui-panel-item-title';
  titleDiv.textContent = title;
  header.appendChild(titleDiv);

  if (summary != null) {
    const summaries = Array.isArray(summary) ? summary : [summary];
    summaries.forEach((text) => {
      const s = document.createElement('div');
      s.className = 'mdui-panel-item-summary';
      s.textContent = text;
      header.appendChild(s);
    });
  }

  const arrow = document.createElement('i');
  arrow.className = 'mdui-panel-item-arrow mdui-icon material-icons';
  arrow.textContent = 'keyboard_arrow_down';
  header.appendChild(arrow);

  const body = document.createElement('div');
  body.className = `mdui-panel-item-body${bodyClass ? ` ${bodyClass}` : ''}`;

  item.append(header, body);
  return { element: item, header, body };
}

/**
 * 创建外部链接（新窗口打开，安全隔离 opener）。
 * @param {string} href - 链接地址
 * @param {string} [text] - 链接文本，缺省时使用 href
 * @param {object} [options]
 * @param {string} [options.className] - 额外类名
 * @returns {HTMLAnchorElement}
 */
export function createExternalLink(href, text, { className } = {}) {
  const link = document.createElement('a');
  link.href = href;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  text !== undefined ? link.textContent = text : link.textContent = href;
  if (className) link.className = className;
  return link;
}

/**
 * 创建 mdui-typo 排版容器。
 * @returns {HTMLDivElement}
 */
export function createTypoContainer() {
  const div = document.createElement('div');
  div.className = 'mdui-typo';
  return div;
}
/**
 * 创建 MDUI 流体表格（含 thead 与 tbody）。
 * @returns {{ wrapper: HTMLDivElement, table: HTMLTableElement, thead: HTMLTableSectionElement, tbody: HTMLTableSectionElement }}
 */
export function createFluidTable() {
  const wrapper = document.createElement('div');
  wrapper.className = 'mdui-table-fluid';
  const table = document.createElement('table');
  table.className = 'mdui-table';
  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  table.append(thead, tbody);
  wrapper.appendChild(table);
  return { wrapper, table, thead, tbody };
}

/**
 * 创建 MDUI 凸起按钮。
 * @param {string} text - 按钮文本
 * @param {object} [options]
 * @param {boolean} [options.block=false] - 是否为块级按钮
 * @param {string} [options.className] - 额外类名
 * @param {Function} [options.onClick] - 点击回调
 * @returns {HTMLButtonElement}
 */
export function createRaisedButton(text, { block = false, className, onClick } = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `mdui-btn mdui-btn-raised mdui-ripple${block ? ' mdui-btn-block' : ''}${className ? ` ${className}` : ''}`;
  button.textContent = text;
  if (onClick) button.addEventListener('click', onClick, { once: true });
  return button;
}

/**
 * 创建 MDUI 网格容器。
 * @returns {HTMLDivElement}
 */
export function createGrid() {
  const grid = document.createElement('div');
  grid.className = 'mdui-row';
  return grid;
}

/**
 * 创建一个换行标签。
 * @returns {HTMLBreakElement}
 */
export function createBreak() {
  return document.createElement('br');
}
