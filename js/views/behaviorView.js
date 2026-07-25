import { renderStatus } from './commonView.js';
import { createPanel, createPanelItem } from './uiComponents.js';

/**
 * 行为设置页面 view。
 * 所有设置项的选项、标签、默认值均由 setting.json 驱动，本模块不含硬编码的业务常量。
 */

/**
 * 从 select 类型设置项的 options 中找到标记为 default 的值。
 * @param {Array} options - 选项列表，每项含 value、label，可含 default: true
 * @returns {string} 默认值，无标记时取首项
 */
export function getDefaultOptionValue(options) {
  const defaultOpt = options.find((opt) => opt.default);
  return defaultOpt ? defaultOpt.value : options[0]?.value || '';
}

/**
 * 验证值是否在选项列表中。
 * @param {Array} options - 选项列表
 * @param {string} value - 待验证值
 * @returns {boolean}
 */
export function isValidOption(options, value) {
  return options.some((opt) => opt.value === value);
}

/**
 * 渲染 select 类型的设置项。
 * @param {HTMLElement} container - 挂载容器
 * @param {object} setting - 设置项配置
 * @param {string} savedValue - 已保存的偏好值
 * @param {Function} onChange - 值变更回调 (value) => void
 */
function renderSelectSetting(container, setting, savedValue, onChange) {
  const row = document.createElement('div');
  row.className = 'mdui-row';

  const labelCol = document.createElement('div');
  labelCol.className = 'mdui-col-xs-6';
  const p = document.createElement('p');
  p.textContent = setting.name;
  labelCol.appendChild(p);

  const selectCol = document.createElement('div');
  selectCol.className = 'mdui-col-xs-6';
  const select = document.createElement('select');
  select.className = 'mdui-select';
  select.setAttribute('mdui-select', '');
  select.dataset.storageKey = setting.storageKey;

  setting.options.forEach((opt) => {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === savedValue) option.selected = true;
    select.appendChild(option);
  });

  select.addEventListener('change', () => onChange(select.value));
  selectCol.appendChild(select);
  row.append(labelCol, selectCol);
  container.appendChild(row);
}

/**
 * 根据设置项类型分派渲染。
 */
function renderSettingItem(container, setting, savedValue, onChange) {
  if (setting.type === 'select') {
    renderSelectSetting(container, setting, savedValue, onChange);
  }
}

/**
 * 渲染完整的设置配置树。
 * @param {HTMLElement} container - 页面挂载容器
 * @param {Array} categories - setting.json 顶层分类数组
 * @param {Function} readPref - 读取偏好函数 (storageKey) => string|null
 * @param {Function} onChange - 设置变更回调 (storageKey, value) => void
 */
export function renderSettingsTree(container, categories, readPref, onChange) {
  if (!categories.length) {
    renderStatus(container, 'empty', { message: '暂无行为设置项' });
    return;
  }

  const outerPanel = createPanel();

  categories.forEach((category) => {
    const { element: categoryItem, body: categoryBody } = createPanelItem(category.label || category.name, { isOpen: true });

    const innerPanel = createPanel();

    (category.children || []).forEach((group) => {
      const { element: groupItem, body: groupBody } = createPanelItem(group.label || group.name, { isOpen: true });

      (group.children || []).forEach((setting) => {
        const saved = readPref(setting.storageKey);
        const value = saved || getDefaultOptionValue(setting.options || []);
        renderSettingItem(groupBody, setting, value, (v) => onChange(setting, v));
      });

      innerPanel.appendChild(groupItem);
    });

    categoryBody.appendChild(innerPanel);
    outerPanel.appendChild(categoryItem);
  });

  container.replaceChildren(outerPanel);
  window.mdui?.mutation();
}

/**
 * 渲染加载状态。
 * @param {HTMLElement} container - 挂载容器
 */
export function renderBehaviorLoading(container) {
  renderStatus(container, 'loading', { message: '正在加载设置……' });
}

/**
 * 渲染错误状态。
 * @param {HTMLElement} container - 挂载容器
 * @param {Error} error - 错误对象
 * @param {Function} onRetry - 重试回调
 */
export function renderBehaviorError(container, error, onRetry) {
  renderStatus(container, 'error', { message: error.message || '设置加载失败', onRetry });
}

/**
 * 显示保存成功的提示。
 */
export function showSaveSuccess() {
  // window.mdui?.snackbar({ message: '设置已保存', timeout: 5000, position: 'right-bottom' });
}

/**
 * 显示保存失败的提示。
 */
export function showSaveError() {
  window.mdui?.snackbar({ message: '设置保存失败，请重试', timeout: 5000, position: 'right-bottom' });
}
