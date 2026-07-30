import { readPreference, writePreference } from '../domain/preferences.js';
import { applyTheme } from '../domain/theme.js';
import { showSnackbar } from '../views/uiComponents.js';

/**
 * 主题设置页的页面入口。
 * 同一个模块会在所有页面加载：没有对应 radio 容器时不会绑定事件，
 * 但 applyTheme 仍会把本地保存的主题应用到 body。
 */
document.addEventListener('DOMContentLoaded', function () {
  // 主题设置页才存在这些 radio 容器；其他页面会在各 helper 中安全地直接返回。
  const theme = readPreference('fdn-theme');
  const primary = readPreference('fdn-theme-primary');
  const accent = readPreference('fdn-theme-accent');

  // 恢复单选框状态，使设置页显示的值与先前保存的主题一致。
  restoreRadioState('theme-select', 'theme-layout', theme || 'auto');
  restoreRadioState('primary-select', 'theme-primary', primary || 'teal');
  restoreRadioState('accent-select', 'theme-accent', accent || 'green');

  applyTheme();

  // 用容器级 change 监听兼容 MDUI 包装后的 radio，并在保存后即时应用主题。
  bindRadioEvent('theme-select', 'theme-layout', 'fdn-theme');
  bindRadioEvent('primary-select', 'theme-primary', 'fdn-theme-primary');
  bindRadioEvent('accent-select', 'theme-accent', 'fdn-theme-accent');
});

/**
 * 恢复单选框选中状态
 * @param {string} containerId - 单选框容器 ID
 * @param {string} name - 单选框名称
 * @param {string} value - 单选框值
 */
function restoreRadioState(containerId, name, value) {
  const container = document.getElementById(containerId);
  if (!container) return;
  // 使用属性遍历而非字符串拼接 CSS 选择器，避免 localStorage 被篡改时抛出 SyntaxError。
  const radio = Array.from(container.querySelectorAll('input[type="radio"]'))
    .find((input) => input.name === name && input.value === value);
  if (radio) {
    radio.checked = true;
  }
}

/**
 * 绑定单选框 change 事件
 * @param {string} containerId - 单选框容器 ID
 * @param {string} name - 单选框名称
 * @param {string} storageKey - 本地存储键
 */
function bindRadioEvent(containerId, name, storageKey) {
  const container = document.getElementById(containerId);
  if (!container) return;
  container.addEventListener('change', function (e) {
    if (e.target.type === 'radio' && e.target.name === name) {
      writePreference(storageKey, e.target.value);
      applyTheme();
      showSnackbar('主题应用成功');
    }
  });
}
