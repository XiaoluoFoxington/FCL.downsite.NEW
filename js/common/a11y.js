/**
 * MDUI 组件的可访问性增强模块。
 * 为面板（Panel）、下拉选择器（Select）和抽屉（Drawer）添加键盘导航、ARIA 属性和焦点管理。
 */
import { t } from './i18n.js';

(function () {
  'use strict';

  // 防止重复初始化
  if (window.__MDUI_PANEL_A11Y_INITED) return;
  window.__MDUI_PANEL_A11Y_INITED = true;

  /** 面板项 ID 计数器。 */
  let idCounter = 0;

  /**
   * 为面板项生成唯一 ID。
   * @param {string} [prefix='panel-body'] ID 前缀
   * @returns {string} 唯一 ID 字符串
   */
  function generateId(prefix = 'panel-body') {
    return `${prefix}-${Date.now()}-${++idCounter}`;
  }

  // 可聚焦元素选择器（面板焦点跳转 / 抽屉焦点管理共用）
  const FOCUSABLE_SELECTOR = 'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

  /**
   * 同步单个面板项的 ARIA 展开状态。
   * @param {HTMLElement} item 面板项元素
   */
  function syncPanelState(item) {
    const header = item.querySelector('.mdui-panel-item-header');
    const body = item.querySelector('.mdui-panel-item-body');
    if (!header || !body) return;
    const isOpen = item.classList.contains('mdui-panel-item-open');
    header.setAttribute('aria-expanded', String(isOpen));
    body.toggleAttribute('inert', !isOpen);
  }

  /**
   * 初始化单个面板项的可访问性属性。
   * 补齐 header 的 role、tabindex、aria-controls，并通过 MutationObserver 监听状态变化。
   * @param {HTMLElement} item 面板项元素
   */
  function initPanelItem(item) {
    const header = item.querySelector('.mdui-panel-item-header');
    const body = item.querySelector('.mdui-panel-item-body');
    if (!header || !body) return;

    // 确保 body 有 ID（供 aria-controls 引用）
    if (!body.id) body.id = generateId();

    // 补齐 header 的可访问性属性
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-controls', body.id);

    // 初始同步
    syncPanelState(item);

    // MutationObserver 监听 class 变化，实时同步
    new MutationObserver(() => syncPanelState(item)).observe(item, {
      attributes: true,
      attributeFilter: ['class']
    });

    item.dataset.a11yInited = 'true';
  }

  /**
   * 批量扫描并初始化容器内所有未处理的面板项。
   * @param {HTMLElement|Document} [container=document] 扫描容器
   */
  function initAllPanels(container = document) {
    container.querySelectorAll('.mdui-panel-item:not([data-a11y-inited])').forEach(initPanelItem);
  }

  // ---------- 全局键盘事件委托（处理 Enter / Space） ----------
  document.addEventListener('keydown', function (e) {
    if (e.key !== 'Enter' && e.key !== ' ') return;

    const target = e.target;
    if (!target.matches('.mdui-panel-item-header[role="button"]')) return;

    e.preventDefault();

    const panelItem = target.closest('.mdui-panel-item');
    if (!panelItem) return;

    // 记录当前是否折叠
    const wasClosed = !panelItem.classList.contains('mdui-panel-item-open');

    // 触发 MDUI 的点击事件（切换展开/折叠）
    target.click();

    // 折叠→展开时，延迟移动焦点到面板内容区
    if (wasClosed) {
      setTimeout(() => {
        if (!panelItem.classList.contains('mdui-panel-item-open')) return;
        const body = panelItem.querySelector('.mdui-panel-item-body');
        if (!body) return;
        // 查找第一个可聚焦元素
        const focusable = body.querySelector(FOCUSABLE_SELECTOR);
        if (focusable) {
          focusable.focus();
        } else {
          // 无可聚焦元素，使 body 可聚焦
          if (!body.hasAttribute('tabindex')) body.setAttribute('tabindex', '-1');
          body.focus();
        }
      }, 100);
    }
  });

  // ---------- 监听 MDUI 展开/折叠完成事件，作为 MutationObserver 的兜底同步 ----------
  document.addEventListener('opened.mdui.panel', e => syncPanelState(e.target), true);
  document.addEventListener('closed.mdui.panel', e => syncPanelState(e.target), true);

  // ---------- MDUI Select 键盘可访问性增强 ----------

  /**
   * 获取 MDUI Select 菜单的所有选项。
   * @param {HTMLElement} selectDiv MDUI Select 容器
   * @returns {HTMLElement[]} 菜单项数组
   */
  function getSelectMenuItems(selectDiv) {
    return Array.from(selectDiv.querySelectorAll('.mdui-select-menu-item'));
  }

  /**
   * 高亮指定索引的菜单项，并滚动到可视区域。
   * @param {HTMLElement[]} items 菜单项数组
   * @param {number} index 目标索引
   */
  function setSelectHighlight(items, index) {
    items.forEach((item, i) => item.classList.toggle('xf-select-highlighted', i === index));
    const highlighted = items[index];
    if (highlighted) highlighted.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /**
   * 移除所有菜单项的高亮样式。
   * @param {HTMLElement} selectDiv MDUI Select 容器
   */
  function resetSelectHighlight(selectDiv) {
    getSelectMenuItems(selectDiv).forEach(item => item.classList.remove('xf-select-highlighted'));
  }

  /**
   * 为单个 MDUI Select 添加键盘导航支持。
   * 支持 Enter/Space 打开与选中、上下箭头导航、Home/End 跳转、Esc 关闭。
   * @param {HTMLElement} selectDiv MDUI Select 容器
   */
  function enhanceSelect(selectDiv) {
    if (selectDiv.dataset.a11ySelectEnhanced) return;
    selectDiv.dataset.a11ySelectEnhanced = 'true';

    // 使 MDUI 生成的 select div 可聚焦，并标识为弹出菜单按钮
    selectDiv.setAttribute('tabindex', '0');
    selectDiv.setAttribute('role', 'button');
    selectDiv.setAttribute('aria-haspopup', 'listbox');

    // 尽量复用原生 select 的 aria-label
    const nativeSelect = selectDiv.previousElementSibling;
    if (nativeSelect?.tagName === 'SELECT') {
      const label = nativeSelect.getAttribute('aria-label');
      if (label) selectDiv.setAttribute('aria-label', label);
    }

    let highlightedIndex = -1;

    /** 同步 Select 的 aria-expanded 状态并在关闭时重置高亮。 */
    function syncExpanded() {
      const isOpen = selectDiv.classList.contains('mdui-select-open');
      selectDiv.setAttribute('aria-expanded', String(isOpen));
      if (!isOpen) {
        highlightedIndex = -1;
        resetSelectHighlight(selectDiv);
      }
    }

    new MutationObserver(syncExpanded).observe(selectDiv, {
      attributes: true,
      attributeFilter: ['class'],
    });
    syncExpanded();

    selectDiv.addEventListener('keydown', function (e) {
      const key = e.key;
      const isOpen = selectDiv.classList.contains('mdui-select-open');

      // Enter / Space：关闭时打开；打开时选中高亮项
      if (key === 'Enter' || key === ' ') {
        e.preventDefault();
        if (isOpen && highlightedIndex >= 0) {
          const items = getSelectMenuItems(selectDiv);
          if (items[highlightedIndex] && !items[highlightedIndex].hasAttribute('disabled')) {
            items[highlightedIndex].click();
            return;
          }
        }
        selectDiv.click();
        return;
      }

      // 上下箭头：打开菜单并移动高亮
      if (key === 'ArrowDown' || key === 'ArrowUp') {
        e.preventDefault();
        const items = getSelectMenuItems(selectDiv);
        if (!isOpen) {
          selectDiv.click();
          // 菜单未打开时选项可能尚未渲染，轮询等待后再高亮首/末项
          if (!items.length) {
            let attempts = 0;
            const direction = key;
            (function waitAndHighlight() {
              const current = getSelectMenuItems(selectDiv);
              if (current.length) {
                highlightedIndex = direction === 'ArrowDown' ? 0 : current.length - 1;
                setSelectHighlight(current, highlightedIndex);
                return;
              }
              if (++attempts < 30) requestAnimationFrame(waitAndHighlight);
            })();
            return;
          }
          highlightedIndex = key === 'ArrowDown' ? 0 : items.length - 1;
        } else {
          if (!items.length) return;
          highlightedIndex = (highlightedIndex + (key === 'ArrowDown' ? 1 : -1) + items.length) % items.length;
        }
        setSelectHighlight(items, highlightedIndex);
        return;
      }

      // Home / End：跳到首/末项
      if (isOpen && (key === 'Home' || key === 'End')) {
        e.preventDefault();
        const items = getSelectMenuItems(selectDiv);
        if (!items.length) return;
        highlightedIndex = key === 'Home' ? 0 : items.length - 1;
        setSelectHighlight(items, highlightedIndex);
        return;
      }

      // Esc：关闭菜单
      if (key === 'Escape' && isOpen) {
        e.preventDefault();
        selectDiv.click();
      }
    });
  }

  /**
   * 批量增强容器内所有未处理的 MDUI Select。
   * @param {HTMLElement|Document} container 扫描容器
   */
  function enhanceAllSelects(container) {
    container.querySelectorAll('div.mdui-select:not([data-a11y-select-enhanced])').forEach(enhanceSelect);
  }

  // ---------- MDUI Drawer 焦点管理 ----------
  let drawerTrigger = null;

  // 抽屉开始打开时记录触发元素
  document.addEventListener('open.mdui.drawer', function () {
    drawerTrigger = document.activeElement;
  }, true);

  // 抽屉打开完成后，自动聚焦到第一个可聚焦元素
  document.addEventListener('opened.mdui.drawer', function (e) {
    const drawer = e.target;
    const focusable = drawer.querySelectorAll(FOCUSABLE_SELECTOR);
    if (focusable.length) {
      focusable[0].focus();
    } else {
      if (!drawer.hasAttribute('tabindex')) drawer.setAttribute('tabindex', '-1');
      drawer.focus();
    }
  }, true);

  // 抽屉关闭后，焦点返回触发按钮
  document.addEventListener('closed.mdui.drawer', function () {
    if (drawerTrigger && typeof drawerTrigger.focus === 'function') {
      drawerTrigger.focus();
    }
    drawerTrigger = null;
  }, true);

  // 窄屏模态模式下的键盘交互：Escape 关闭 + Tab 焦点陷阱
  document.addEventListener('keydown', function (e) {
    const openDrawer = document.querySelector('.mdui-drawer.mdui-drawer-open');
    if (!openDrawer) return;
    // 宽屏持久模式（无遮罩层），不拦截
    if (!document.querySelector('.mdui-overlay.mdui-overlay-show')) return;

    // Escape 关闭抽屉
    if (e.key === 'Escape') {
      e.preventDefault();
      // 通过点击遮罩层触发 MDUI 自身的关闭逻辑
      const overlay = document.querySelector('.mdui-overlay.mdui-overlay-show');
      if (overlay) overlay.click();
      return;
    }

    // Tab 焦点陷阱：将焦点限制在抽屉内
    if (e.key !== 'Tab') return;
    const focusable = Array.from(openDrawer.querySelectorAll(FOCUSABLE_SELECTOR));
    if (focusable.length < 2) return;

    const first = focusable[0];
    const last = focusable[focusable.length - 1];

    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  });

  // ---------- Material Icons 可访问性处理 ----------

  /** 图标名 → 翻译键映射（纯图标按钮的 aria-label 用）。 */
  const ICON_LABEL_KEYS = {
    menu: 'common.a11y.menu',
    home: 'common.a11y.home',
    arrow_back: 'common.a11y.back',
    list: 'common.a11y.list',
    info: 'common.a11y.info',
  };

  /**
   * 处理 Material Icons：
   * ① 兜底给装饰性图标补 aria-hidden（静态 HTML 已加，翻译插件在 JS 执行前就会跳过这些内容）；
   * ② 为纯图标按钮（除图标外无其他文本的 <a>/<button>）注入 aria-label，
   *    避免屏幕阅读器只读出无意义的图标名（如 "menu"、"home"）。
   * @param {HTMLElement|Document} container 扫描容器
   */
  function enhanceMaterialIcons(container = document) {
    container.querySelectorAll('.mdui-icon.material-icons').forEach(icon => {
      // ① 兜底：确保图标对屏幕阅读器与翻译插件不可见
      if (!icon.hasAttribute('aria-hidden')) icon.setAttribute('aria-hidden', 'true');

      // ② 仅处理纯图标按钮：父元素是链接/按钮，且除图标外无其他可读文本
      const host = icon.parentElement;
      if (!host || !host.matches('a, button')) return;
      if (host.hasAttribute('aria-label')) return;
      if (host.textContent.trim() !== icon.textContent.trim()) return;

      const labelKey = ICON_LABEL_KEYS[icon.textContent.trim()];
      if (!labelKey) return;
      const label = t(labelKey);
      if (label && label !== labelKey) host.setAttribute('aria-label', label);
    });
  }

  // ---------- 防抖 MutationObserver 处理 ----------
  let pendingMutations = [];
  let rafId = null;

  /**
   * 处理累积的 DOM 变更，自动初始化新增的面板项和 Select。
   */
  function processMutations() {
    const addedNodes = new Set();
    for (const mutation of pendingMutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) addedNodes.add(node);
        }
      }
    }
    pendingMutations = [];
    rafId = null;

    for (const node of addedNodes) {
      if (node.matches?.('.mdui-panel-item:not([data-a11y-inited])')) {
        initPanelItem(node);
      }
      // 动态加载的面板（如公告）可能先插入空 panel-item，之后再补 header/body，
      // 因此新增 header/body 时也要尝试初始化其父面板。
      if (node.matches?.('.mdui-panel-item-header, .mdui-panel-item-body')) {
        const panelItem = node.closest('.mdui-panel-item:not([data-a11y-inited])');
        if (panelItem) initPanelItem(panelItem);
      }
      if (node.querySelectorAll) {
        initAllPanels(node);
        enhanceAllSelects(node);
        enhanceMaterialIcons(node);
      }
    }
  }

  // ---------- 启动初始化 ----------

  /**
   * 启动可访问性增强：初始化所有面板和 Select，并监听后续动态加载。
   */
  function bootstrap() {
    initAllPanels(document);
    enhanceAllSelects(document);
    enhanceMaterialIcons(document);

    // MDUI 的 select 初始化时机不稳定（取决于 CDN/缓存），轮询增强直到找到
    if (!document.querySelectorAll('div.mdui-select').length) {
      let attempts = 0;
      (function retrySelects() {
        if (document.querySelectorAll('div.mdui-select').length) {
          enhanceAllSelects(document);
        } else if (++attempts < 60) {
          requestAnimationFrame(retrySelects);
        }
      })();
    }

    new MutationObserver(mutations => {
      pendingMutations.push(...mutations);
      if (rafId === null) rafId = requestAnimationFrame(processMutations);
    }).observe(document.body, { childList: true, subtree: true });
  }

  // MDUI 组件初始化在 DOMContentLoaded 回调中完成，需推迟到该事件后再做首次增强
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    setTimeout(bootstrap, 0);
  }
})();
