import { readPreference, writePreference } from '../domain/preferences.js';
import { getSettings } from '../repositories/siteRepository.js';
import {
  isValidOption,
  isValidSwitchValue,
  isValidNumberValue,
  getDefaultOptionValue,
  renderSettingsTree,
  renderBehaviorLoading,
  renderBehaviorError,
  showSaveSuccess,
  showSaveError,
} from '../views/behaviorView.js';

/**
 * 行为设置页面 controller。
 * 设置项的选项与结构完全由 setting.json 驱动，controller 不含硬编码的业务常量。
 */
export function createBehaviorController(elements) {
  /**
   * 校验值是否合法，按设置项类型分派。
   * @param {object} setting - 设置项配置
   * @param {string} value - 待验证值
   * @returns {boolean}
   */
  function isValidValue(setting, value) {
    if (setting.type === 'select') return isValidOption(setting.options, value);
    if (setting.type === 'switch') return isValidSwitchValue(value);
    if (setting.type === 'number') return isValidNumberValue(setting, value);
    return false;
  }

  /**
   * 保存用户选择到 localStorage，并校验值合法性。
   * @param {object} setting - 设置项配置（含 options、storageKey）
   * @param {string} value - 选中的值
   */
  function savePreference(setting, value) {
    if (!isValidValue(setting, value)) {
      console.warn(`尝试保存无效的设置值: ${setting.storageKey}=${value}`);
      showSaveError();
      return;
    }
    writePreference(setting.storageKey, value);
    showSaveSuccess();
  }

  /**
   * 加载 setting.json 并渲染完整的设置树。
   */
  async function load() {
    renderBehaviorLoading(elements.container);

    try {
      const categories = await getSettings();
      renderSettingsTree(
        elements.container,
        categories,
        (key) => readPreference(key),
        (setting, value) => savePreference(setting, value),
      );
    } catch (error) {
      console.error('加载行为设置失败', error);
      renderBehaviorError(elements.container, error, load);
    }
  }

  return { load };
}
