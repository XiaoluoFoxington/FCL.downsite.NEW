import {
  getSupportedLanguages,
  getLanguageOrder,
  setLanguageOrder,
  getCurrentLang,
  t,
} from './common/i18n.js';
import { showSnackbar } from './views/uiComponents.js';
import { debounce } from './views/commonView.js';
import { createSortableTable } from './views/sortableTable.js';

/**
 * 语言设置页入口。
 * 列表顺序即语言优先级：第一位为界面显示语言，其余语言在翻译缺失时按顺序回退。
 * 排序复用可拖拽表格组件（拖拽 + 插入指示线 + 编程式 move），修改后立即保存并实时生效。
 */

const listContainer = document.getElementById('language-list');
let sortable = null;

// 保存提示防抖：连续排序时只弹最后一次，避免 Toast 堆叠。
const debouncedSavedToast = debounce(() => {
  showSnackbar(t('language.saved'));
}, 500);

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

/** 创建单个语言行（表格行：手柄 / 操作 / 名称 / 代码 / 当前五列）。 */
function createRow(lang, index, total) {
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
    sortable?.move(index, index - 1);
  });
  const downButton = createActionButton('arrow_downward', t('language.moveDown'), () => {
    sortable?.move(index, index + 1);
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

/** 构建语言顺序表格。 */
function buildList() {
  if (!listContainer) return;
  const order = getLanguageOrder();
  const supported = getSupportedLanguages();
  // 按用户顺序排列，未出现在顺序里的语言（理论不会发生）补到末尾。
  const sorted = [
    ...order.map((code) => supported.find((lang) => lang.code === code)).filter(Boolean),
    ...supported.filter((lang) => !order.includes(lang.code)),
  ];
  sortable = createSortableTable(listContainer, {
    columns: [
      { icon: 'drag_indicator', className: 'language-handle-cell' },
      { title: t('language.tableHeaderActions'), className: 'language-actions-cell' },
      { title: t('language.tableHeaderLanguage'), className: 'language-name-cell' },
      { title: t('language.tableHeaderCode'), className: 'language-code-cell' },
      { title: t('language.current'), className: 'language-current-cell' },
    ],
    items: sorted,
    renderRow: (lang, index) => createRow(lang, index, sorted.length),
    onReorder: (nextItems) => {
      setLanguageOrder(nextItems.map((lang) => lang.code), { reload: false });
      debouncedSavedToast();
    },
  });
}

buildList();
