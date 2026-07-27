// a11y.js
(function () {
  'use strict';

  // 防止重复初始化
  if (window.__MDUI_PANEL_A11Y_INITED) return;
  window.__MDUI_PANEL_A11Y_INITED = true;

  // ---------- 工具：为面板项生成唯一 ID ----------
  let idCounter = 0;
  function generateId(prefix = 'panel-body') {
    return `${prefix}-${Date.now()}-${++idCounter}`;
  }

  // ---------- 核心：初始化单个面板项 ----------
  function initPanelItem(item) {
    const header = item.querySelector('.mdui-panel-item-header');
    const body = item.querySelector('.mdui-panel-item-body');
    if (!header || !body) return;

    // 1. 确保 body 有 ID（供 aria-controls 引用）
    if (!body.id) {
      body.id = generateId();
    }

    // 2. 补齐 header 的可访问性属性
    header.setAttribute('role', 'button');
    header.setAttribute('tabindex', '0');
    header.setAttribute('aria-controls', body.id);

    // 3. 同步状态的内部函数
    function syncState() {
      const isOpen = item.classList.contains('mdui-panel-item-open');
      header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      body.toggleAttribute('inert', !isOpen);
    }

    // 初始同步
    syncState();

    // 4. 使用 MutationObserver 监听 class 变化，确保展开/折叠时实时同步
    const classObserver = new MutationObserver(syncState);
    classObserver.observe(item, {
      attributes: true,
      attributeFilter: ['class']
    });

    // 标记已初始化
    item.dataset.a11yInited = 'true';
  }

  // ---------- 批量扫描并初始化 ----------
  function initAllPanels(container = document) {
    const items = container.querySelectorAll('.mdui-panel-item:not([data-a11y-inited])');
    items.forEach(initPanelItem);
  }

  // ---------- 全局键盘事件委托（处理 Enter / Space） ----------
  document.addEventListener('keydown', function (e) {
    const key = e.key;
    if (key !== 'Enter' && key !== ' ') return;

    const target = e.target;
    if (!target.matches('.mdui-panel-item-header[role="button"]')) return;

    e.preventDefault();

    const panelItem = target.closest('.mdui-panel-item');
    if (!panelItem) return;

    // 记录当前是否折叠
    const wasClosed = !panelItem.classList.contains('mdui-panel-item-open');

    // 触发 MDUI 的点击事件（切换展开/折叠）
    target.click();

    // 如果当前是折叠状态，本次操作旨在展开，延迟检查并移动焦点
    if (wasClosed) {
      // 使用 setTimeout 延迟 100ms，确保 MDUI 完成状态更新和渲染
      setTimeout(() => {
        // 确认面板已展开
        if (panelItem.classList.contains('mdui-panel-item-open')) {
          const body = panelItem.querySelector('.mdui-panel-item-body');
          if (body) {
            // 查找第一个可聚焦元素：按钮、链接、输入、选择、文本域、带 tabindex 的元素
            const focusable = body.querySelector(
              'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
            );
            if (focusable) {
              focusable.focus();
            } else {
              // 无可聚焦元素，使 body 可聚焦
              if (!body.hasAttribute('tabindex')) {
                body.setAttribute('tabindex', '-1');
              }
              body.focus();
            }
          }
        }
      }, 100);
    }
  });

  // ---------- 监听 MDUI 的切换事件，同步 aria-expanded + inert ----------
  document.addEventListener('change.mdui.panel', function (e) {
    const panel = e.target.closest ? e.target.closest('.mdui-panel') : null;
    if (!panel) return;

    panel.querySelectorAll('.mdui-panel-item').forEach(function (item) {
      const header = item.querySelector('.mdui-panel-item-header');
      const body = item.querySelector('.mdui-panel-item-body');
      if (!header || !body) return;

      const isOpen = item.classList.contains('mdui-panel-item-open');
      header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      body.toggleAttribute('inert', !isOpen);
    });
  });

  // ---------- 防抖 MutationObserver 处理 ----------
  let pendingMutations = [];
  let rafId = null;

  function processMutations() {
    const addedNodes = new Set();
    for (const mutation of pendingMutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            addedNodes.add(node);
          }
        }
      }
    }
    pendingMutations = [];
    rafId = null;

    for (const node of addedNodes) {
      if (node.matches && node.matches('.mdui-panel-item:not([data-a11y-inited])')) {
        initPanelItem(node);
      }
      if (node.querySelectorAll) {
        initAllPanels(node);
      }
    }
  }

  function schedulePanelsUpdate(mutations) {
    pendingMutations.push(...mutations);
    if (rafId === null) {
      rafId = requestAnimationFrame(processMutations);
    }
  }

  // ---------- 启动初始化 ----------
  function bootstrap() {
    initAllPanels(document);

    const observer = new MutationObserver(schedulePanelsUpdate);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    bootstrap();
  }
})();