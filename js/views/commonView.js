import { logError } from '../common/logger.js';
import { readPreference } from '../domain/preferences.js';
import { getFeedbackChannels } from '../repositories/siteRepository.js';
import { isSafeNavigationUrl } from '../security/content.js';
import { createPanel, createPanelItem, createMaterialIcon } from './uiComponents.js';
import { t, tOr, escapeKeySegment } from '../common/i18n.js';

/** 防抖：延迟执行 fn，期间再次调用则重新计时。 */
export function debounce(fn, delay = 500) {
  let timer = null;
  return function (...args) {
    clearTimeout(timer);
    timer = setTimeout(() => fn.apply(this, args), delay);
  };
}

/** 将字节数转为可读字符串。根据用户偏好自动选择 IEC/SI 前缀。 */
export function formatBytes(bytes) {
  // Number.isNaN 必须显式检查：typeof NaN === 'number'，仅判断类型会漏掉 NaN。
  if (typeof bytes !== 'number' || Number.isNaN(bytes) || bytes < 0) return t('common.unknownSize');
  if (bytes === 0) return '0 B';

  const prefix = readPreference('fdn-default-format-prefix');

  if (prefix === 'SI') {
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    // 0 < bytes < 1 时对数商为负，索引钳制到 0，避免 units[-1] 输出 "undefined"。
    const i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(1000)), 0), units.length - 1);
    return (bytes / Math.pow(1000, i)).toFixed(2) + ' ' + units[i];
  }

  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  const i = Math.min(Math.max(Math.floor(Math.log(bytes) / Math.log(1024)), 0), units.length - 1);
  return (bytes / Math.pow(1024, i)).toFixed(2) + ' ' + units[i];
}

/** 清空可选容器；主要给没有复杂状态的 view 使用。 */
export function clearElement(element) {
  element?.replaceChildren();
}

/**
 * 渲染消息面板。消息数组为空或不存在时隐藏外层容器。
 * 每条消息渲染为独立面板项，面板头标题为消息的 type 字段。
 * @param {HTMLElement} wrapper 外层容器（消息面板外套）
 * @param {HTMLElement} container 消息列表容器
 * @param {Array} messages 消息数组，每项 { type, text }
 */
export function renderMessages(wrapper, container, messages) {
  if (!wrapper || !container) return;

  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) {
    wrapper.hidden = true;
    return;
  }

  wrapper.hidden = false;
  const fragment = document.createDocumentFragment();
  const panel = createPanel();
  list.forEach((msg) => {
    const type = msg.type || 'message';
    let icon = null
    switch (msg.type) {
      case 'info':
        icon = 'info';
        break;
      case 'error':
        icon = 'error';
        break;
      case 'danger':
        icon = 'report';
        break;
      case 'warning':
        icon = 'warning';
        break;
      case 'success':
        icon = 'check';
        break;
      default:
        break;
    }
    // 消息类型映射为可读标题：warning/info/success 等 type 直接展示时对中文用户不友好。
    const typeTitle = type === 'message'
      ? t('common.nav.message')
      : tOr(`common.${escapeKeySegment(type)}Message`, type);
    const { element, body } = createPanelItem(typeTitle, { isOpen: msg.panelOpen ?? true, icon, iconClass: 'mdui-icon' });
    element.classList.add('xf-message');
    if (msg.type) {
      element.classList.add(`xf-message-${msg.type}`);
    }
    const textSpan = document.createElement('span');
    textSpan.textContent = msg.text || '';
    body.appendChild(textSpan);
    fragment.appendChild(element);
  });
  panel.replaceChildren(fragment);
  container.appendChild(panel);
  window.mdui?.mutation();
}

/**
 * 渲染表格状态行。
 * 专为 <tbody> 设计：tbody 只能包含 <tr>，不能直接插入通用 div 状态组件。
 * @param {HTMLTableSectionElement} body 要插入状态行的 tbody 元素
 * @param {number} colspan 状态内容单元格的 colspan 属性值（包括 label 列）
 * @param {string} state 状态类型，'loading'、'error' 或 'empty'
 * @param {string} message 状态消息
 * @param {Function} [onRetry] 点击重试按钮时的回调函数
 */
export function renderTableStatus(body, colspan = 2, state, message, onRetry) {
  const row = document.createElement('tr');
  const label = document.createElement('td');
  const content = document.createElement('td');
  content.colSpan = colspan - 1;
  label.textContent = state === 'error' ? t('common.error') : t('common.status');
  row.append(label, content);
  body.replaceChildren(row);
  renderStatus(content, state, { message, onRetry });
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
    idle: t('common.idle'),
    loading: t('common.loading'),
    empty: t('common.noContent'),
    error: t('common.loadingError'),
  }[state] || '');
  wrapper.appendChild(text);

  if (state === 'error' && onRetry) {
    // 重试监听器使用 once：点击后由 controller 重新渲染，旧按钮不应再响应第二次。
    const retry = document.createElement('button');
    retry.type = 'button';
    retry.className = 'mdui-btn mdui-btn-raised mdui-ripple';
    retry.textContent = t('common.retry');
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
  const pageTitle = `${titlePrefix} - ${basic.name}`;
  if (icon) {
    icon.src = basic.icon || '/media/img/picMissing.webp';
    icon.alt = basic.name;
  }
  if (title) title.textContent = pageTitle;
  document.title = pageTitle + ' - ' + t('common.siteName');
  if (detailButton) detailButton.href = `/html/detail.html?id=${basic.id}`;
}

/** 将浏览器标题与工具栏标题切换为错误状态。 */
export function setErrorTitle() {
  const title = document.getElementById('title');
  const errorText = t('common.error');
  if (title) title.textContent = errorText;
  document.title = errorText;
}

/** 从 ?id= 读取软件 ID，非法、负数、空值一律返回 null。 */
export function getSoftwareId() {
  // 只接受非负整数字符串，拒绝 parseInt 会误接受的 "1abc" 等输入。
  const rawId = new URLSearchParams(window.location.search).get('id');
  if (rawId === null || !/^\d+$/.test(rawId)) return null;
  return Number(rawId);
}

/**
 * 将 data/feedback.json 转为外链按钮。
 * 无效 URL 会被过滤；请求失败时通过统一状态机在 drawer 面板内显示错误。
 * @param {HTMLElement} container 反馈容器
 * @returns {Promise<void>}
 */
export async function loadFeedback(container) {
  renderStatus(container, 'loading', { message: t('common.feedbackLoading') });
  try {
    const feedbacks = await getFeedbackChannels();
    const links = feedbacks
      .filter((feedback) => isSafeNavigationUrl(feedback.href, { allowRelative: false }))
      .map((feedback) => {
        const link = document.createElement('a');
        link.className = 'mdui-btn mdui-btn-block mdui-btn-raised mdui-ripple';
        link.href = feedback.href;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        const icon = document.createElement('i');
        icon.className = 'mdui-icon material-icons';
        icon.textContent = 'feedback';
        link.append(icon, document.createTextNode(` ${t('common.feedbackVia', { name: feedback.name })}`));
        return link;
      });
    if (links.length) {
      container.replaceChildren(...links);
    } else {
      renderStatus(container, 'empty', { message: t('common.noFeedbackChannels') });
    }
  } catch (error) {
    logError(error, '反馈渠道');
    renderStatus(container, 'error', { message: error.message, onRetry: () => loadFeedback(container) });
  }
}

