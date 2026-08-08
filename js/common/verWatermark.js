import { getJSON } from "../http/client.js";
import { createBreak } from "../views/uiComponents.js";
import { logWarn } from "./logger.js";

/**
 * 版本水印
 * 用于在页面右下角显示版本水印
 */

document.addEventListener('DOMContentLoaded', async function () {
  try {
    const version = await getCurrentVersion();
    if (!version) return;
    const container = createContainer(version);
    document.body.appendChild(container);
  } catch (error) {
    logWarn(error, '版本水印');
  }
});

/**
 * 获取当前版本号
 * @returns {Promise<string>} 当前版本号字符串
 */
async function getCurrentVersion() {
  const response = await getJSON('/data/verInfo.json');
  return response.gitHash;
}

/**
 * 创建容器
 * @param {string} version 版本号
 * @returns {HTMLElement} 版本水印容器
 */
function createContainer(version) {
  const div = document.createElement('div');
  div.id = 'xf-verWatermarkContainer';
  const span = document.createElement('span');
  span.textContent = 'Commit Hash';
  const spanVersion = document.createElement('span');
  spanVersion.textContent = version;

  div.append(span, createBreak(), spanVersion);
  return div;
}