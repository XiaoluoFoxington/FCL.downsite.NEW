import { getText } from '../http/client.js';
import { getFeedbackChannels } from '../repositories/siteRepository.js';
import { renderStatus } from '../views/commonView.js';
import { isSafeNavigationUrl } from '../security/content.js';
import { loadAnnouncement, checkNewAnnouncement } from './announcement.js';
import { showSnackbar } from '../views/uiComponents.js';
import { getRunTime } from '../domain/siteInfo.js';

/**
 * 所有页面共用的右侧抽屉。
 * 本模块只在页面存在 #menu_btn 时工作；窄屏下创建抽屉推迟到首次点击，宽屏则立即创建以适配 MDUI 持久展开。
 * 抽屉静态结构从 /html/drawer.html 加载，动态内容（公告、反馈、运行时间）在 JS 中注入。
 *
 * 点击按钮后立即弹出抽屉容器并显示加载状态，内容异步加载完成后渲染到抽屉内。
 */

/**
 * 将 data/feedback.json 转为外链按钮。
 * 无效 URL 会被过滤；请求失败时通过统一状态机在 drawer 面板内显示错误。
 */
async function loadFeedback(container) {
  renderStatus(container, 'loading', { message: '正在加载反馈渠道……' });
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
        link.append(icon, document.createTextNode(` 通过 ${feedback.name}`));
        return link;
      });
    if (links.length) {
      container.replaceChildren(...links);
    } else {
      renderStatus(container, 'empty', { message: '暂无可用的反馈渠道' });
    }
  } catch (error) {
    console.error('反馈渠道加载失败', error);
    renderStatus(container, 'error', { message: error.message, onRetry: () => loadFeedback(container) });
  }
}

/** 创建抽屉外壳（立即完成），显示加载状态，返回 drawer 元素和 MDUI 实例。 */
function createDrawerShell() {
  const drawer = document.createElement('aside');
  drawer.className = 'mdui-drawer mdui-drawer-right mdui-container-fluid';
  drawer.setAttribute('aria-label', '网站导航');

  // 统一状态机：在抽屉容器内显示加载状态
  renderStatus(drawer, 'loading', { message: '正在加载……' });

  document.body.appendChild(drawer);
  document.body.classList.add('mdui-drawer-body-right');
  window.mdui?.mutation();

  return { drawer, instance: new window.mdui.Drawer(drawer) };
}

/** 异步加载抽屉内容并渲染到外壳中，注入动态内容。 */
async function loadDrawerContent(drawer) {
  try {
    const rawHtml = await getText('/data/drawer.html', { cache: true });
    const template = document.createElement('template');
    template.innerHTML = rawHtml;
    drawer.replaceChildren(template.content);
    window.mdui?.mutation();

    // 注入动态内容
    const announcementContainer = drawer.querySelector('#drawer-announcement');
    if (announcementContainer) loadAnnouncement(announcementContainer);

    const feedbackContainer = drawer.querySelector('#drawer-feedback');
    if (feedbackContainer) loadFeedback(feedbackContainer);

    const runtimeEl = drawer.querySelector('#drawer-runtime');
    if (runtimeEl) {
      let runtimeTimer = null;
      const updateRuntime = () => {
        runtimeEl.textContent = '这坨屎山已经非常松弛地运行了' + getRunTime() + '。';
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
      drawer.addEventListener('open.mdui.drawer', startRuntime);
      drawer.addEventListener('closed.mdui.drawer', stopRuntime);
      // 页面切到后台时暂停，回到前台且抽屉可见时恢复
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          stopRuntime();
        } else if (drawer.classList.contains('mdui-drawer-open')) {
          startRuntime();
        }
      });
      // 初始：宽屏持久展开或窄屏已打开时启动
      if (!document.hidden && drawer.classList.contains('mdui-drawer-open')) {
        startRuntime();
      }
    }
  } catch (error) {
    console.error('抽屉内容加载失败', error);
    renderStatus(drawer, 'error', { message: error.message, onRetry: () => loadDrawerContent(drawer) });
  }
}

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('menu_btn');
  if (!button) return;

  const MDUI_LG_BREAKPOINT = 1024;
  const isWideScreen = () => window.innerWidth >= MDUI_LG_BREAKPOINT;

  let drawerInstance = null;
  let drawerElement = null;

  const ensureDrawer = () => {
    if (!drawerInstance) {
      const shell = createDrawerShell();
      drawerInstance = shell.instance;
      drawerElement = shell.drawer;
      // 异步加载内容，不阻塞抽屉弹出
      loadDrawerContent(drawerElement);
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
        showSnackbar('有新公告');
      }
    });
  }

  button.addEventListener('click', () => {
    const wasCreated = !drawerInstance;
    const instance = ensureDrawer();
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