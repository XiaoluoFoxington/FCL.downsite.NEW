import { logWarn } from '../common/logger.js';

/**
 * 浏览器偏好存储的小型封装。
 * 封装 localStorage 的读写，兼容隐私模式或存储被禁用的场景。
 */

/**
 * 读取偏好值；隐私模式或存储被禁用时降级为 defaultValue，不阻断页面。
 * @param {string} key 存储键
 * @param {string|null} [defaultValue=null] 默认值
 * @returns {string|null} 存储的值或默认值
 */
export function readPreference(key, defaultValue = null) {
  try {
    return localStorage.getItem(key) ?? defaultValue;
  } catch (error) {
    logWarn(error, `读取设置 ${key}`);
    return defaultValue;
  }
}

/**
 * 写入偏好值；写入失败仅记录警告，不影响当前页面。
 * @param {string} key 存储键
 * @param {string} value 存储值
 */
export function writePreference(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (error) {
    logWarn(error, { key: 'logger.context.writePreference', params: { key } });
  }
}
