import { readPreference } from '../domain/preferences.js';

/** 将字节数转为可读字符串。根据用户偏好自动选择 IEC/SI 前缀。 */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || bytes < 0) return '未知';
  if (bytes === 0) return '0 B';

  const prefix = readPreference('fdn-default-format-prefix');

  if (prefix === 'SI') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1000)), units.length - 1);
    return (bytes / Math.pow(1000, i)).toFixed(2) + ' ' + units[i];
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

/** 清空可选容器；主要给没有复杂状态的 view 使用。 */
export function clearElement(element) {
  element?.replaceChildren();
}

/**
 * 渲染统一状态块。
 * state 约定为 idle/loading/ready/empty/error；ready 一般直接由具体 view 渲染内容，
 * 因而本函数主要使用其余四种状态。onRetry 仅在 error 时生效。
 */
export function renderStatus(container, state, { message = '', onRetry } = {}) {
  // 所有动态页统一使用这五类状态，避免不同页面分别拼接不安全的错误 HTML。
  if (!container) return;
  const wrapper = document.createElement('div');
  wrapper.className = `xf-status xf-status-${state}`;
  wrapper.setAttribute('role', state === 'error' ? 'alert' : 'status');

  if (state === 'loading') {
    // 加载态才创建 MDUI spinner，其他状态只输出可读文本。
    const spinner = document.createElement('div');
    spinner.className = 'mdui-spinner';
    wrapper.appendChild(spinner);
  }

  const text = document.createElement('p');
  text.textContent = message || ({
    idle: '等待加载',
    loading: '正在加载……',
    empty: '暂无内容',
    error: '加载失败',
  }[state] || '');
  wrapper.appendChild(text);

  if (state === 'error' && onRetry) {
    // 重试监听器使用 once：点击后由 controller 重新渲染，旧按钮不应再响应第二次。
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'mdui-btn mdui-btn-raised mdui-ripple';
    retry.textContent = '重试';
    retry.addEventListener('click', onRetry, { once: true });
    wrapper.appendChild(retry);
  }
  container.replaceChildren(wrapper);
  window.mdui?.mutation();
}

/**
 * 填充公共工具栏。
 * basic 使用目录中的 { id, name, icon }；titlePrefix 例如“下载”“介绍”；
 * detailButton 仅在下载/介绍页存在，用于保留当前软件 ID 的详情链接。
 */
export function setSoftwareHeader(basic, { titlePrefix = '', detailButton } = {}) {
  // 下载页、介绍页和详情页共用标题栏更新逻辑，减少路径和 alt 文案不一致。
  const icon = document.getElementById('icon');
  const title = document.getElementById('title');
  const pageTitle = `${titlePrefix}${basic.name}`;
  if (icon) {
    icon.src = basic.icon || '/media/img/picMissing.webp';
    icon.alt = basic.name;
  }
  if (title) title.textContent = pageTitle;
  document.title = pageTitle;
  if (detailButton) detailButton.href = `/html/detail.html?id=${basic.id}`;
}

/** 将浏览器标题与工具栏标题切换为错误状态。 */
export function setErrorTitle() {
  const title = document.getElementById('title');
  if (title) title.textContent = '错误';
  document.title = '错误';
}

/** 从 ?id= 读取软件 ID，非法、负数、空值一律返回 null。 */
export function getSoftwareId() {
  // 只接受非负整数字符串，拒绝 parseInt 会误接受的 "1abc" 等输入。
  const rawId = new URLSearchParams(window.location.search).get('id');
  if (rawId === null || !/^\d+$/.test(rawId)) return null;
  return Number(rawId);
}
