import { getCurrentLang, t } from '../common/i18n.js';

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
  button.addEventListener('click', onClick);
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
