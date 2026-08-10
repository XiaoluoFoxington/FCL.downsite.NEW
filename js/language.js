import {
  getSupportedLanguages,
  getLanguageOrder,
  setLanguageOrder,
  getCurrentLang,
  t,
} from './common/i18n.js';
import { showSnackbar } from './views/uiComponents.js';
import { debounce } from './views/commonView.js';
import { createSortableList } from './views/sortableList.js';

/**
 * 语言设置页入口。
 * 列表顺序即语言优先级：第一位为界面显示语言，其余语言在翻译缺失时按顺序回退。
 * 排序复用可排序列表组件（拖拽 + 插入指示线 + 编程式 move），修改后立即保存并实时生效。
 */

const listContainer = document.getElementById('language-list');
let sortable = null;

// 保存提示防抖：连续排序时只弹最后一次，避免 Toast 堆叠。
const debouncedSavedToast = debounce(() => {
  showSnackbar(t('language.saved'));
}, 300);

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

/** 创建单个语言行。 */
function createRow(lang, index, total) {
  const item = document.createElement('div');
  item.className = 'language-list-item';

  const dragHandle = document.createElement('i');
  dragHandle.className = 'mdui-icon material-icons language-drag-handle';
  dragHandle.textContent = 'drag_handle';
  dragHandle.setAttribute('aria-hidden', 'true');

  const info = document.createElement('div');
  info.className = 'language-list-info';
  const name = document.createElement('span');
  name.className = 'language-name';
  name.textContent = lang.name;
  const code = document.createElement('span');
  code.className = 'language-code';
  code.textContent = lang.code;
  info.append(name, code);
  if (lang.code === getCurrentLang()) {
    const badge = document.createElement('span');
    badge.className = 'language-current mdui-color-theme';
    badge.textContent = t('language.current');
    info.appendChild(badge);
  }

  const actions = document.createElement('div');
  actions.className = 'language-actions';
  const upButton = createActionButton('arrow_upward', t('language.moveUp'), () => {
    sortable?.move(index, index - 1);
  });
  const downButton = createActionButton('arrow_downward', t('language.moveDown'), () => {
    sortable?.move(index, index + 1);
  });
  if (index === 0) upButton.disabled = true;
  if (index === total - 1) downButton.disabled = true;
  actions.append(upButton, downButton);

  item.append(dragHandle, info, actions);
  return item;
}

/** 构建语言顺序列表。 */
function buildList() {
  if (!listContainer) return;
  const order = getLanguageOrder();
  const supported = getSupportedLanguages();
  // 按用户顺序排列，未出现在顺序里的语言（理论不会发生）补到末尾。
  const sorted = [
    ...order.map((code) => supported.find((lang) => lang.code === code)).filter(Boolean),
    ...supported.filter((lang) => !order.includes(lang.code)),
  ];
  sortable = createSortableList(listContainer, {
    items: sorted,
    renderItem: (lang, index) => createRow(lang, index, sorted.length),
    onReorder: (nextItems) => {
      setLanguageOrder(nextItems.map((lang) => lang.code), { reload: false });
      debouncedSavedToast();
    },
  });
}

buildList();
