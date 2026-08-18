import { getText } from '../http/client.js';
import { loadFeedback, renderStatus } from '../views/commonView.js';
import { loadAnnouncement, checkNewAnnouncement } from './announcement.js';
import { showSnackbar } from '../views/uiComponents.js';
import { getRunTime } from '../domain/siteInfo.js';
import { mountBookmarkList } from '../views/bookmarkView.js';
import { logError } from './logger.js';
import { t, translateDynamicContent, isRTLLang, getCurrentLang } from './i18n.js';

/**
* 所有页面共用的抽屉（LTR 在右侧，RTL 镜像到左侧）。
* 本模块只在页面存在 #menu_btn 时工作；窄屏下创建抽屉推迟到首次点击，宽屏则立即创建以适配 MDUI 持久展开。
* 抽屉静态结构从 /data/drawer.html 加载，动态内容（公告、反馈、运行时间）在 JS 中注入。
*
* 点击按钮后立即弹出抽屉容器并显示加载状态，内容异步加载完成后渲染到抽屉内。
*/

/** MDUI 抽屉宽屏持久展开的断点（px），与 mdui.css 的 lg 断点一致。 */
const MDUI_LG_BREAKPOINT = 1024;

/**
 * 创建抽屉外壳（立即完成），显示加载状态，返回 drawer 元素和 MDUI 实例。
 * @returns {{drawer: HTMLElement|null, instance: object|null}} 抽屉元素和 MDUI Drawer 实例；mdui 缺失时两者均为 null
 */
function createDrawerShell() {
  // RTL 语言下抽屉镜像到左侧：MDUI 的位置逻辑由 mdui-drawer-left/right 类决定。
  const side = isRTLLang(getCurrentLang()) ? 'left' : 'right';
  const drawer = document.createElement('aside');
  drawer.className = `mdui-drawer mdui-drawer-${side} mdui-container-fluid`;
  drawer.setAttribute('aria-label', t('common.nav.websiteNav'));

  // mdui 未加载（CDN 故障/被拦截）时无法实例化 Drawer：Snackbar 提示一次，避免整页脚本崩溃。
  if (!window.mdui?.Drawer) {
    if (!createDrawerShell._mduiMissingNotified) {
      createDrawerShell._mduiMissingNotified = true;
      showSnackbar(t('common.dependencyLoadFailed', { src: 'mdui.min.js' }));
    }
    return { drawer: null, instance: null };
  }

  // 统一状态机：在抽屉容器内显示加载状态
  renderStatus(drawer, 'loading', { message: t('common.loading') });

  document.body.appendChild(drawer);
  document.body.classList.add(`mdui-drawer-body-${side}`);
  window.mdui?.mutation();

  return { drawer, instance: new window.mdui.Drawer(drawer) };
}

/**
 * 异步加载抽屉内容并渲染到外壳中，注入动态内容。
 * @param {HTMLElement} drawer 抽屉外壳元素
 * @returns {Promise<void>}
 */
async function loadDrawerContent(drawer) {
  // 重试时先 abort 上一次的事件监听器，避免重复绑定导致 setInterval 重复执行与内存泄漏。
  if (drawer._drawerContentAbort) drawer._drawerContentAbort.abort();
  const ac = new AbortController();
  drawer._drawerContentAbort = ac;

  try {
    const rawHtml = await getText('/data/drawer.html', { cache: true });
    const template = document.createElement('template');
    template.innerHTML = rawHtml;
    drawer.replaceChildren(template.content);

    // 对动态加载的抽屉内容应用 i18n 翻译
    translateDynamicContent(drawer);
    window.mdui?.mutation();

    // 在"网站导航"下方插入收藏资源面板
    const navPanel = Array.from(drawer.querySelectorAll('.mdui-panel-item')).find(
      (item) => item.querySelector('.mdui-panel-item-title[data-i18n="common.nav.websiteNav"]')
    );
    if (navPanel) {
      const bookmarkPanel = createBookmarkPanel();
      navPanel.after(bookmarkPanel);
      const bookmarkBody = bookmarkPanel.querySelector('.mdui-panel-item-body');
      if (bookmarkBody) {
        mountBookmarkList(bookmarkBody);
        window.mdui?.mutation();
      }
    }

    // 注入动态内容
    const announcementContainer = drawer.querySelector('#drawer-announcement');
    if (announcementContainer) loadAnnouncement(announcementContainer);

    // 建议反馈懒加载：面板默认折叠，首次展开时才拉取反馈渠道，
    // 避免仅打开抽屉（不展开反馈）时也发起 feedback.json 请求。
    const feedbackPanel = drawer.querySelector('#drawer-feedback-panel');
    if (feedbackPanel) {
      feedbackPanel.addEventListener('open.mdui.panel', () => {
        if (feedbackPanel.dataset.feedbackLoaded) return;
        feedbackPanel.dataset.feedbackLoaded = 'true';
        const feedbackContainer = feedbackPanel.querySelector('#drawer-feedback');
        if (feedbackContainer) loadFeedback(feedbackContainer);
      }, { signal: ac.signal });
    }

    const runtimeEl = drawer.querySelector('#drawer-runtime');
    if (runtimeEl) {
      let runtimeTimer = null;
      const updateRuntime = () => {
        runtimeEl.textContent = getRunTime();
      };
      const startRuntime = () => {
        if (runtimeTimer === null) {
          updateRuntime();
          runtimeTimer = setInterval(updateRuntime, 1000);
        }
      };
      const stopRuntime = () => {
        if (runtimeTimer !== null) {
          clearInterval(runtimeTimer);
          runtimeTimer = null;
        }
      };
      // 抽屉打开时启动定时器，关闭时暂停（窄屏模态模式下生效）
      drawer.addEventListener('open.mdui.drawer', startRuntime, { signal: ac.signal });
      drawer.addEventListener('closed.mdui.drawer', stopRuntime, { signal: ac.signal });
      // 页面切到后台时暂停，回到前台且抽屉可见时恢复
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          stopRuntime();
        } else if (drawer.classList.contains('mdui-drawer-open')) {
          startRuntime();
        }
      }, { signal: ac.signal });
      // 初始：宽屏持久展开或窄屏已打开时启动；抽屉处于关闭状态（窄屏默认）
      // 时不启动，避免一个每秒更新隐藏元素文本的定时器在整页生命周期内空转。
      if (!document.hidden && (window.innerWidth >= MDUI_LG_BREAKPOINT || drawer.classList.contains('mdui-drawer-open'))) {
        startRuntime();
      }
    }
  } catch (error) {
    logError(error, '抽屉导航栏');
    renderStatus(drawer, 'error', { message: error.message, onRetry: () => loadDrawerContent(drawer) });
  }
}

/**
 * 创建收藏资源面板项。
 * @returns {HTMLDivElement}
 */
function createBookmarkPanel() {
  const item = document.createElement('div');
  item.className = 'mdui-panel-item mdui-panel-item-open';

  const header = document.createElement('div');
  header.className = 'mdui-panel-item-header mdui-ripple';
  const title = document.createElement('div');
  title.className = 'mdui-panel-item-title';
  title.textContent = t('common.nav.bookmarks');
  const arrow = document.createElement('i');
  arrow.className = 'mdui-panel-item-arrow mdui-icon material-icons';
  arrow.textContent = 'keyboard_arrow_down';
  header.append(title, arrow);

  const body = document.createElement('div');
  body.className = 'mdui-panel-item-body';

  item.append(header, body);
  return item;
}

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('menu_btn');
  if (!button) return;

  const isWideScreen = () => window.innerWidth >= MDUI_LG_BREAKPOINT;

  let drawerInstance = null;
  let drawerElement = null;

  const ensureDrawer = () => {
    if (!drawerInstance) {
      const shell = createDrawerShell();
      drawerInstance = shell.instance;
      drawerElement = shell.drawer;
      // mdui 缺失时 instance 为 null：错误提示已在抽屉内渲染，跳过内容加载即可。
      if (drawerInstance) {
        // 异步加载内容，不阻塞抽屉弹出
        loadDrawerContent(drawerElement);
      }
    }
    return drawerInstance;
  };

  // 宽屏下 MDUI 抽屉默认展开，必须立即创建 DOM；窄屏仍保持懒加载。
  if (isWideScreen()) {
    ensureDrawer();
  } else {
    // 窄屏下抽屉懒加载，但需提前检查公告是否为新，以便弹出 Snackbar 提醒用户。
    checkNewAnnouncement().then((result) => {
      if (result?.isNew) {
        showSnackbar(t('common.nav.recentAnnouncement'));
      }
    });
  }

  button.addEventListener('click', () => {
    const wasCreated = !drawerInstance;
    const instance = ensureDrawer();
    // mdui 缺失时无法切换抽屉（错误提示已渲染在抽屉内），直接返回。
    if (!instance) return;
    if (wasCreated) {
      // 单帧延迟确保抽屉 DOM 已挂载，然后触发动画
      // 单帧不行！还是得双rAF！！
      requestAnimationFrame(() => {
        requestAnimationFrame(() => instance.toggle());
      });
    } else {
      instance.toggle();
    }
  });

  // 窄屏 → 宽屏切换时，若抽屉尚未创建则自动创建，避免宽屏下抽屉区域空白。
  let wasWide = isWideScreen();
  let resizeRafId = null;
  window.addEventListener('resize', () => {
    if (resizeRafId !== null) return;
    resizeRafId = requestAnimationFrame(() => {
      resizeRafId = null;
      const nowWide = isWideScreen();
      if (!wasWide && nowWide) ensureDrawer();
      wasWide = nowWide;
    });
  });
});
