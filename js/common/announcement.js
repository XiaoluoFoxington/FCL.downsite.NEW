import { getText } from '../http/client.js';
import { readPreference, writePreference } from '../domain/preferences.js';
import { renderStatus } from '../views/commonView.js';
import { createSafeContent } from '../security/content.js';
import { logWarn, logError } from '../common/logger.js';

/**
 * 网站公告模块。
 * 负责从 data/announcement.html 拉取公告内容，通过校验值判断是否为新公告，
 * 并在侧边栏最顶部渲染公告面板。
 *
 * 本模块独立于侧边栏逻辑，侧边栏只需提供一个容器并调用 loadAnnouncement 即可。
 * checkNewAnnouncement 可在渲染前提前判断是否有新公告，供外部（如 drawer.js）在窄屏下提前弹出提醒。
 */

const STORAGE_KEY = 'fdn-announcement';

/**
 * 简单 64 位字符串哈希，用于生成公告内容校验值。
 * @param {string} str 输入字符串
 * @returns {string} 16 进制哈希值
 */
function simpleHash64(str) {
  let h1 = 114514, h2 = 1919810;
  for (let i = 0; i < str.length; i++) {
    h1 = ((h1 << 5) + h1) + str.charCodeAt(i);
    h1 |= 0;
    h2 = ((h2 << 5) + h2) + str.charCodeAt(i);
    h2 |= 0;
  }
  return (h1 >>> 0).toString(16) + (h2 >>> 0).toString(16);
}

/**
 * 渲染公告面板的 ready 状态。
 * @param {HTMLElement} container 公告容器（mdui-panel-item）
 * @param {string} html 公告 HTML 内容
 * @param {string} hash 当前公告校验值
 * @param {boolean} isNew 是否为新公告
 */
async function renderAnnouncement(container, html, hash, isNew) {
  const header = document.createElement('div');
  header.className = 'mdui-panel-item-header mdui-ripple';

  const headerTitle = document.createElement('div');
  headerTitle.textContent = '网站公告';
  if (isNew) {
    const badge = document.createElement('i');
    badge.className = 'mdui-icon material-icons xf-new-announcement-badge mdui-text-color-theme-accent';
    badge.textContent = 'new_releases';
    badge.id = 'new-announcement-badge';
    headerTitle.appendChild(badge);
  }

  const arrow = document.createElement('i');
  arrow.className = 'mdui-panel-item-arrow mdui-icon material-icons';
  arrow.textContent = 'keyboard_arrow_down';

  header.append(headerTitle, arrow);

  const body = document.createElement('div');
  body.className = 'mdui-panel-item-body';
  // 公告 HTML 经 DOMPurify 净化后插入，与介绍页/描述等模块保持安全策略一致。
  const fragment = await createSafeContent(html, { type: 'html' });
  body.appendChild(fragment);

  // 用户展开面板即视为已读，写入校验值并移除 NEW 标记。
  // 经 writePreference 写入，隐私模式或存储被禁用时降级为只记录警告，不让整个公告模块崩溃。
  header.addEventListener('click', () => {
    if (isNew) {
      writePreference(STORAGE_KEY, hash);
      const badge = document.getElementById('new-announcement-badge');
      if (badge) badge.remove();
    }
  }, { once: true });

  container.replaceChildren(header, body);
  window.mdui?.mutation();
}

/**
 * 提前获取公告内容并判断是否为新公告（不渲染）。
 * 窄屏下抽屉懒加载，外部可在页面加载时调用此函数提前判断，避免 snackbar 等提醒被延迟。
 *
 * @returns {Promise<{ html: string, hash: string, isNew: boolean }|null>} 公告信息，加载失败返回 null
 */
export async function checkNewAnnouncement() {
  try {
    const html = await getText('/data/announcement.html', { cache: true });
    const hash = simpleHash64(html);
    const storedHash = readPreference(STORAGE_KEY);
    return { html, hash, isNew: hash !== storedHash };
  } catch (error) {
    logError(error, '公告');
    return null;
  }
}

/**
 * 加载公告内容并渲染到指定容器中。
 * 使用统一状态机：loading → ready / error。
 * 若公告校验值与本地存储不一致，则视为新公告，会在面板标题上显示醒目提醒。
 *
 * @param {HTMLElement} container 公告面板挂载容器
 */
export async function loadAnnouncement(container) {
  renderStatus(container, 'loading', { message: '正在加载公告……' });
  try {
    const result = await checkNewAnnouncement();
    if (result) {
      await renderAnnouncement(container, result.html, result.hash, result.isNew);
    } else {
      throw new Error('公告数据为空');
    }
  } catch (error) {
    logError(error, '公告');
    renderStatus(container, 'error', { message: error.message, onRetry: () => loadAnnouncement(container) });
  }
}