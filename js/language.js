import {
  getSupportedLanguages,
  getLanguageOrder,
  setLanguageOrder,
  getCurrentLang,
  t,
} from './common/i18n.js';
import { showSnackbar } from './views/uiComponents.js';

/**
 * 语言设置页入口。
 * 列表顺序即语言优先级：第一位为界面显示语言，其余语言在翻译缺失时按顺序回退。
 * 支持拖拽排序与上下按钮排序，修改后立即保存并实时生效（无需刷新）。
 */

const listContainer = document.getElementById('language-list');
let draggingCode = null;

/** 将数组项从 fromIndex 移动到 toIndex。 */
function moveItem(order, fromIndex, toIndex) {
  const [item] = order.splice(fromIndex, 1);
  order.splice(toIndex, 0, item);
  return order;
}

/** 应用新顺序：保存偏好、实时翻译页面并重绘列表。 */
function applyOrder(order) {
  setLanguageOrder(order, { reload: false });
  renderList();
  showSnackbar(t('language.saved'));
}

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

/** 渲染语言顺序列表。 */
function renderList() {
  if (!listContainer) return;
  const order = getLanguageOrder();
  const supported = getSupportedLanguages();
  // 按用户顺序排列，未出现在顺序里的语言（理论不会发生）补到末尾。
  const sorted = [
    ...order.map((code) => supported.find((lang) => lang.code === code)).filter(Boolean),
    ...supported.filter((lang) => !order.includes(lang.code)),
  ];
  const current = getCurrentLang();

  listContainer.replaceChildren();

  sorted.forEach((lang, index) => {
    const item = document.createElement('div');
    item.className = 'language-list-item';
    item.draggable = true;
    item.dataset.lang = lang.code;

    const dragHandle = document.createElement('i');
    dragHandle.className = 'mdui-icon material-icons';
    dragHandle.textContent = 'drag_indicator';
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
    if (lang.code === current) {
      const badge = document.createElement('span');
      badge.className = 'language-current mdui-color-theme';
      badge.textContent = t('language.current');
      info.appendChild(badge);
    }

    const actions = document.createElement('div');
    actions.className = 'language-actions';
    const upButton = createActionButton('arrow_upward', t('language.moveUp'), () => {
      if (index > 0) applyOrder(moveItem(getLanguageOrder(), index, index - 1));
    });
    const downButton = createActionButton('arrow_downward', t('language.moveDown'), () => {
      if (index < sorted.length - 1) applyOrder(moveItem(getLanguageOrder(), index, index + 1));
    });
    if (index === 0) upButton.disabled = true;
    if (index === sorted.length - 1) downButton.disabled = true;
    actions.append(upButton, downButton);

    item.append(dragHandle, info, actions);

    // 拖拽排序
    item.addEventListener('dragstart', (event) => {
      draggingCode = lang.code;
      item.classList.add('language-dragging');
      event.dataTransfer.effectAllowed = 'move';
      try {
        event.dataTransfer.setData('text/plain', lang.code);
      } catch (_) {
        // 某些浏览器要求 setData 携带有效格式，失败时仍可继续拖拽。
      }
    });
    item.addEventListener('dragover', (event) => {
      event.preventDefault();
      if (draggingCode && draggingCode !== lang.code) {
        item.classList.add('language-drop-target');
      }
    });
    item.addEventListener('dragleave', () => {
      item.classList.remove('language-drop-target');
    });
    item.addEventListener('drop', (event) => {
      event.preventDefault();
      item.classList.remove('language-drop-target');
      if (!draggingCode || draggingCode === lang.code) return;
      const order = getLanguageOrder();
      const fromIndex = order.indexOf(draggingCode);
      const toIndex = order.indexOf(lang.code);
      if (fromIndex < 0 || toIndex < 0) return;
      // 把被拖项插到目标项“之前”；从下方拖上来时目标索引在移除后会前移一位。
      const insertAt = fromIndex < toIndex ? toIndex - 1 : toIndex;
      applyOrder(moveItem(order, fromIndex, insertAt));
    });
    item.addEventListener('dragend', () => {
      draggingCode = null;
      listContainer.querySelectorAll('.language-dragging, .language-drop-target').forEach((el) => {
        el.classList.remove('language-dragging', 'language-drop-target');
      });
    });

    listContainer.appendChild(item);
  });
}

renderList();
