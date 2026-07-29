import { getFeedbackChannels } from '../repositories/siteRepository.js';
import { renderStatus } from '../views/commonView.js';
import { isSafeNavigationUrl } from '../security/content.js';
import { loadAnnouncement, checkNewAnnouncement } from './announcement.js';
import { createPanel, createPanelItem, createTypoContainer, createExternalLink, showSnackbar, createHR } from '../views/uiComponents.js';
import { getRunTime } from '../domain/siteInfo.js';

/**
 * 所有页面共用的右侧抽屉。
 * 本模块只在页面存在 #menu_btn 时工作；窄屏下创建抽屉推迟到首次点击，宽屏则立即创建以适配 MDUI 持久展开。
 */

/** 创建本站固定导航链接；label 是按钮文案，iconName 是 Material Icons 名称。 */
function createNavigationLink(label, href, iconName, target) {
  // 所有抽屉链接通过 DOM API 创建，避免反馈渠道名称进入 HTML 字符串插值。
  const link = document.createElement('a');
  link.className = 'mdui-btn mdui-btn-block mdui-btn-raised mdui-ripple';
  link.href = href;
  if (target) link.target = target;
  const icon = document.createElement('i');
  icon.className = 'mdui-icon material-icons';
  icon.textContent = iconName;
  link.append(icon, document.createTextNode(` ${label}`));
  return link;
}

/**
 * 创建文本段落
 * @param {Array} content 文本内容数组，用于分段
 * @returns {HTMLElement} 文本段落片段
 */
function createTextArticle(content) {
  const div = createTypoContainer();
  div.append(...content);
  return div;
}

function createParagraph(text) {
  const p = document.createElement('p');
  p.textContent = text;
  return p;
}

/** 创建一个 MDUI 面板项，content 为已创建好的 DOM 子节点数组。 */
function createDrawerPanel(title, content, isOpen = true) {
  const { element, body } = createPanelItem(title, { isOpen });
  body.append(...content);
  return element;
}

/**
 * 将 data/feedback.json 转为外链按钮。
 * 无效 URL 会被过滤；请求失败只替换反馈区域，不影响抽屉的本地导航。
 */
async function loadFeedback(container) {
  // 反馈渠道不是首屏必须内容；抽屉首次打开后才会调用此函数。
  renderStatus(container, 'loading', { message: '正在加载反馈渠道……' });
  try {
    const feedbacks = await getFeedbackChannels();
    const links = feedbacks
      // 配置数据也必须校验，禁止误填 javascript: 等危险协议。
      .filter((feedback) => isSafeNavigationUrl(feedback.href, { allowRelative: false }))
      .map((feedback) => {
        const link = createNavigationLink(`通过 ${feedback.name}`, feedback.href, 'feedback');
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        return link;
      });
    if (links.length) container.replaceChildren(...links);
    else renderStatus(container, 'empty', { message: '暂无可用的反馈渠道' });
  } catch (error) {
    console.error('反馈渠道加载失败', error);
    renderStatus(container, 'error', { message: error.message, onRetry: () => loadFeedback(container) });
  }
}

/** 创建、挂载并初始化抽屉，返回 MDUI 的 Drawer 实例供后续 toggle 调用。 */
function createDrawer() {
  // 抽屉 DOM 延迟到用户首次点击菜单才创建，普通页面加载不会请求 feedback.json。
  const drawer = document.createElement('aside');
  drawer.className = 'mdui-drawer mdui-drawer-right mdui-container-fluid';
  drawer.setAttribute('aria-label', '网站导航');
  const panel = createPanel();

  const announcementContainer = document.createElement('div');
  announcementContainer.className = 'mdui-panel-item';
  panel.appendChild(announcementContainer);
  loadAnnouncement(announcementContainer);

  panel.appendChild(createDrawerPanel('网站导航', [
    createNavigationLink('资源列表', '/html/list.html', 'list'),
    createNavigationLink('赞助站长', '/html/sponsor.html', 'card_giftcard'),
    createNavigationLink('关于网站', '/html/about.html', 'people'),
  ]));
  panel.appendChild(createDrawerPanel('网站设置', [
    createNavigationLink('行为设置', '/html/behavior.html', 'settings'),
    createNavigationLink('主题设置', '/html/theme.html', 'style'),
  ]));
  panel.appendChild(createDrawerPanel('页面操作', [
    createNavigationLink('硬刷新', 'javascript:location.reload(true)', 'refresh'),
  ]));
  panel.appendChild(createDrawerPanel('回到旧版', [
    createTextArticle([
      createParagraph('旧版网站将不会有任何更新，不建议使用，仅作纪念。')
    ]),
    createNavigationLink('NEXT版', 'https://next.foldcraftlauncher.cn', 'history', '_blank'),
    createNavigationLink('mdui版', 'https://mdui.foldcraftlauncher.cn', 'history', '_blank'),
    createNavigationLink('初版', 'https://old.foldcraftlauncher.cn', 'history', '_blank'),
  ], false));

  const feedbackContainer = document.createElement('div');
  panel.appendChild(createDrawerPanel('建议反馈', [feedbackContainer]));
  const runtimeParagraph = createParagraph('等待至多1秒……');
  setInterval(() => {
    runtimeParagraph.textContent = '这坨屎山已经非常松弛地运行了' + getRunTime() + '。';
  }, 1000);
  panel.appendChild(createDrawerPanel('网站信息', [
    createTextArticle([
      runtimeParagraph,
      createParagraph('此网站是完全开源的，GH仓库见下方链接。'),
      createExternalLink('https://github.com/XiaoluoFoxington/FCL.downsite.NEW'),
      createParagraph('此网站使用counter.dev统计访问信息，详情见下方链接。'),
      createExternalLink('https://counter.dev/dashboard.html?user=XiaoluoFoxington&token=Vw6FYI1sViM%3D'),
      createHR(),
      createParagraph('COPYRIGHT 2026 XIAOLUOFOXINGTON'),
      createExternalLink('https://beian.miit.gov.cn', '新ICP备2024015133号-7')
    ]),
  ]));
  drawer.appendChild(panel);
  document.body.appendChild(drawer);
  document.body.classList.add('mdui-drawer-body-right');
  window.mdui.mutation();
  // 创建外壳后异步填充反馈区；失败不会影响导航、设置等本地链接。
  loadFeedback(feedbackContainer);
  return new window.mdui.Drawer(drawer);
}

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('menu_btn');
  if (!button) return;

  const MDUI_LG_BREAKPOINT = 1024;
  const isWideScreen = () => window.innerWidth >= MDUI_LG_BREAKPOINT;

  // 保留单例，后续开关不重复创建 DOM 或再次请求反馈数据。
  let drawerInstance = null;

  const ensureDrawer = () => {
    if (!drawerInstance) drawerInstance = createDrawer();
    return drawerInstance;
  };

  // 宽屏下 MDUI 抽屉默认展开，必须立即创建 DOM；窄屏仍保持懒加载。
  if (isWideScreen()) {
    ensureDrawer();
  } else {
    // 窄屏下抽屉懒加载，但需提前检查公告是否为新，以便弹出 Snackbar 提醒用户。
    checkNewAnnouncement().then((result) => {
      if (result?.isNew) {
        showSnackbar('有新公告');
      }
    });
  }

  button.addEventListener('click', () => {
    const wasCreated = !drawerInstance;
    const instance = ensureDrawer();
    if (wasCreated) {
      // 首次创建时使用双重 requestAnimationFrame 确保浏览器完成布局后再切换，使动画生效
      requestAnimationFrame(() => {
        requestAnimationFrame(() => instance.toggle());
      });
    } else {
      instance.toggle();
    }
  });

  // 窄屏 → 宽屏切换时，若抽屉尚未创建则自动创建，避免宽屏下抽屉区域空白。
  let wasWide = isWideScreen();
  window.addEventListener('resize', () => {
    const nowWide = isWideScreen();
    if (!wasWide && nowWide) ensureDrawer();
    wasWide = nowWide;
  });
});