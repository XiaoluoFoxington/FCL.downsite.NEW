import { getCurrentLang, isRTLLang, t } from '../common/i18n.js';
import { createFluidTable, createTextField } from './uiComponents.js';

/**
 * 语言设置页 view。
 * 负责渲染语言顺序表格：表头列定义与单行（手柄 / 操作 / 名称 / 代码 / 当前五列）。
 */

/** 创建单个语言行的操作按钮。 */
function createActionButton(iconName, ariaLabel, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'mdui-btn mdui-btn-icon mdui-ripple';
  button.setAttribute('aria-label', ariaLabel);
  const icon = document.createElement('i');
  icon.className = 'mdui-icon material-icons';
  icon.textContent = iconName;
  button.appendChild(icon);
  if (onClick) button.addEventListener('click', onClick);
  return button;
}

/**
 * 创建单个语言行（表格行：手柄 / 操作 / 名称 / 代码 / 当前五列）。
 * @param {object} lang 语言信息
 * @param {number} index 行索引
 * @param {number} total 总行数
 * @param {(from: number, to: number) => void} move 编程式移动回调（由 controller 提供）
 */
export function createRow(lang, index, total, move) {
  const row = document.createElement('tr');
  row.className = 'language-table-row';

  const handleCell = document.createElement('td');
  handleCell.className = 'language-handle-cell';
  const dragHandle = document.createElement('i');
  dragHandle.className = 'mdui-icon material-icons language-drag-handle';
  dragHandle.textContent = 'drag_handle';
  dragHandle.setAttribute('aria-hidden', 'true');
  // 触屏拖拽的起点：只有按住手柄才能拖动，行内其余区域保留页面滚动。
  dragHandle.setAttribute('data-sortable-handle', '');
  handleCell.appendChild(dragHandle);

  const actionsCell = document.createElement('td');
  actionsCell.className = 'language-actions-cell';
  const upButton = createActionButton('arrow_upward', t('language.moveUp'), () => {
    move(index, index - 1);
  });
  const downButton = createActionButton('arrow_downward', t('language.moveDown'), () => {
    move(index, index + 1);
  });
  if (index === 0) upButton.disabled = true;
  if (index === total - 1) downButton.disabled = true;
  actionsCell.append(upButton, downButton);

  const nameCell = document.createElement('td');
  nameCell.className = 'language-name-cell';
  nameCell.textContent = lang.name;
  // 语言名称按语言自身书写方向对齐（如阿拉伯语行在 LTR 页面下右对齐）。
  nameCell.dir = isRTLLang(lang.code) ? 'rtl' : 'ltr';

  const codeCell = document.createElement('td');
  codeCell.className = 'language-code-cell';
  codeCell.textContent = lang.code;

  const currentCell = document.createElement('td');
  currentCell.className = 'language-current-cell';
  if (lang.code === getCurrentLang()) {
    const badge = document.createElement('span');
    badge.textContent = t('language.isCurrent');
    currentCell.appendChild(badge);
  }

  row.append(handleCell, actionsCell, nameCell, codeCell, currentCell);
  return row;
}

/** 表头列定义。 */
export function createColumns() {
  return [
    { icon: 'drag_indicator', className: 'language-handle-cell' },
    { title: t('language.tableHeaderActions'), className: 'language-actions-cell' },
    { title: t('language.tableHeaderLanguage'), className: 'language-name-cell' },
    { title: t('language.tableHeaderCode'), className: 'language-code-cell' },
    { title: t('language.current'), className: 'language-current-cell' },
  ];
}

/**
 * 渲染语言比较表。
 * 列结构：key | 各已有语言（输入框，预填充翻译值）| 新语言列（空输入框，用于新建语言包）。
 * 已有语言列头带下载按钮（下载对应语言包文件）；新语言列表头的输入框用于填写新语言代码，
 * 其旁的下载按钮由 controller 绑定（收集该列输入生成语言包）。
 * @param {HTMLElement} container 挂载容器
 * @param {object} options
 * @param {Array<{code: string}>} options.languages 已有语言代码
 * @param {Array<{key: string, values: Object<string, string>}>} options.rows 所有翻译键行
 * @param {(code: string) => void} options.onDownload 下载已有语言包回调
 * @returns {{newCodeInput: HTMLInputElement, newDownloadBtn: HTMLButtonElement,
 *            getNewColumnDir: () => 'ltr' | 'rtl', filter: (keyword: string) => void,
 *            collectNewColumn: () => Object<string, string>}}
 */
export function createComparisonTable(container, { languages, rows, onDownload }) {
  container.replaceChildren();

  // 表格上方的搜索框：按 key 或任一翻译内容过滤。
  const searchField = createTextField({
    inputType: 'search',
    inputPlaceholder: t('language.tableSearchPlaceholder'),
    divClassName: ['language-compare-search'],
  });
  const searchBox = searchField.querySelector('.mdui-textfield-input');

  const { wrapper, table, thead, tbody } = createFluidTable();
  table.classList.add('language-compare-table');

  // 表头：key + 各语言（列头下载）+ 新语言（代码输入框 + 下载）。
  const headerRow = document.createElement('tr');
  const thKey = document.createElement('th');
  thKey.scope = 'col';
  thKey.className = 'language-compare-key';
  thKey.dir = 'ltr'; // 键路径为 ASCII 标识符，RTL 页面下也保持左对齐
  thKey.textContent = t('language.tableKey');
  headerRow.appendChild(thKey);

  languages.forEach((lang) => {
    const th = document.createElement('th');
    th.scope = 'col';
    th.className = 'language-compare-langcol';
    // 每列按该语言自身书写方向渲染，避免 LTR 页面下阿拉伯语列左对齐、RTL 页面下其它语言列右对齐。
    th.dir = isRTLLang(lang.code) ? 'rtl' : 'ltr';
    const label = document.createElement('span');
    label.className = 'language-compare-lang';
    label.textContent = lang.code;
    th.appendChild(label);
    th.appendChild(createActionButton('download', t('language.tableDownload'), () => onDownload(lang.code)));
    headerRow.appendChild(th);
  });

  const thNew = document.createElement('th');
  thNew.scope = 'col';
  thNew.className = 'language-compare-newcol';
  thNew.dir = 'ltr'; // 初始 LTR，由方向切换按钮控制
  const newCodeField = createTextField({
    inputPlaceholder: t('language.tableNewLangPlaceholder'),
    inputClassName: ['language-compare-newcode'],
  });
  const newCodeInput = newCodeField.querySelector('.mdui-textfield-input');
  // 新语言列书写方向切换按钮：手动在 RTL / LTR 间切换（不随代码自动判断）。
  const dirToggleBtn = document.createElement('button');
  dirToggleBtn.type = 'button';
  dirToggleBtn.className = 'mdui-btn language-compare-dirtoggle';
  dirToggleBtn.setAttribute('aria-label', t('language.tableDirToggle'));
  dirToggleBtn.title = t('language.tableDirToggle');
  const newDownloadBtn = createActionButton('download', t('language.tableDownload'), null);
  thNew.append(newCodeField, dirToggleBtn, newDownloadBtn);
  headerRow.appendChild(thNew);
  thead.appendChild(headerRow);

  // 数据行：key + 各语言输入框（预填充翻译值）+ 新语言空输入框。
  const newColumnCells = []; // 新语言列各行的 td，书写方向由表头切换按钮控制
  rows.forEach((row) => {
    const tr = document.createElement('tr');
    tr.className = 'language-compare-row';
    tr.dataset.key = row.key;

    const tdKey = document.createElement('td');
    tdKey.className = 'language-compare-key';
    tdKey.dir = 'ltr';
    tdKey.textContent = row.key;
    tr.appendChild(tdKey);

    languages.forEach((lang) => {
      const td = document.createElement('td');
      // 每列按该语言自身书写方向渲染（与表头一致）。
      td.dir = isRTLLang(lang.code) ? 'rtl' : 'ltr';
      const field = createTextField({});
      const input = field.querySelector('.mdui-textfield-input');
      input.value = row.values[lang.code] ?? '';
      td.appendChild(field);
      tr.appendChild(td);
    });

    const tdNew = document.createElement('td');
    const newField = createTextField({ inputClassName: ['language-compare-new'] });
    tdNew.appendChild(newField);
    newColumnCells.push(tdNew);
    tr.appendChild(tdNew);
    tbody.appendChild(tr);
  });

  // 无匹配提示行（搜索过滤后无结果显示）。
  const emptyRow = document.createElement('tr');
  emptyRow.className = 'language-compare-empty';
  emptyRow.hidden = true;
  const tdEmpty = document.createElement('td');
  tdEmpty.colSpan = languages.length + 2;
  tdEmpty.textContent = t('language.tableNoMatch');
  emptyRow.appendChild(tdEmpty);
  tbody.appendChild(emptyRow);

  container.append(searchField, wrapper);
  window.mdui?.mutation();

  /** 按关键词过滤行：匹配 key 或任一输入框当前值。 */
  function filter(keyword) {
    const kw = String(keyword || '').trim().toLowerCase();
    let visible = 0;
    tbody.querySelectorAll('.language-compare-row').forEach((tr) => {
      const inputs = tr.querySelectorAll('.mdui-textfield-input');
      const haystack = [tr.dataset.key, ...[...inputs].map((input) => input.value)].join(' ').toLowerCase();
      const show = !kw || haystack.includes(kw);
      tr.hidden = !show;
      if (show) visible += 1;
    });
    emptyRow.hidden = visible !== 0;
  }

  /** 收集新语言列填写的翻译：key → 翻译值（跳过空值）。 */
  function collectNewColumn() {
    const values = {};
    tbody.querySelectorAll('.language-compare-row').forEach((tr) => {
      const input = tr.querySelector('.language-compare-new');
      if (input && input.value) values[tr.dataset.key] = input.value;
    });
    return values;
  }

  searchBox.addEventListener('input', () => filter(searchBox.value));

  // 新语言列：书写方向由按钮手动在 RTL 与 LTR 间切换（不随代码自动判断）。
  let newColumnDir = 'ltr';
  const applyNewColumnDir = () => {
    dirToggleBtn.textContent = newColumnDir.toUpperCase();
    thNew.dir = newColumnDir;
    newColumnCells.forEach((td) => {
      td.dir = newColumnDir;
    });
  };
  dirToggleBtn.addEventListener('click', () => {
    newColumnDir = newColumnDir === 'rtl' ? 'ltr' : 'rtl';
    applyNewColumnDir();
  });
  applyNewColumnDir();

  return { newCodeInput, newDownloadBtn, getNewColumnDir: () => newColumnDir, filter, collectNewColumn };
}
