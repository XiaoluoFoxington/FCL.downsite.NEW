import { readPreference, writePreference } from '../domain/preferences.js';

/**
 * 网站信息
 */

const START_DATE = new Date(2025, 2, 19, 2, 19, 45); // 建站时间（月份0-based）
const VISIT_COUNT_KEY = 'fdn-visitCount';

/**
 * 获取当前时间与建站时间的时间差
 * @returns {string} 格式化后的时间差字符串（非零单位：天、小时、分钟、秒）
 */
export function getRunTime() {
  const now = Date.now();

  if (now < START_DATE) return "0秒";

  const UNITS = [
    { value: 24 * 60 * 60 * 1000, label: "天" },
    { value: 60 * 60 * 1000, label: "时" },
    { value: 60 * 1000, label: "分" },
    { value: 1000, label: "秒" }
  ];

  let diff = now - START_DATE;
  const parts = [];

  for (const unit of UNITS) {
    const count = Math.floor(diff / unit.value);
    if (count > 0) {
      parts.push(`${count}${unit.label}`);
      diff %= unit.value;
    }
  }

  return parts.length > 0 ? parts.join('') : "0秒";
}

/**
 * 获取当前网站访问次数
 * @returns {number} 当前网站访问次数
 */
export function getVisitCount() {
  return Number(readPreference(VISIT_COUNT_KEY, '0') || 0); // 双重兜底
}

/**
 * 将网站访问次数增加1
 * @returns {number} 新的网站访问次数
 */
export function incrementVisitCount() {
  const currentCount = getVisitCount();
  const newCount = currentCount + 1;
  writePreference(VISIT_COUNT_KEY, newCount);
  return newCount;
}
