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

  // ---------- 监听 MDUI 的展开/折叠完成事件，同步 aria-expanded + inert ----------
  // MDUI Panel 触发的是 opened/closed.mdui.panel（没有 change.mdui.panel），
  // 这里作为 MutationObserver 的兜底同步。
  document.addEventListener('opened.mdui.panel', syncAllPanelStates, true);
  document.addEventListener('closed.mdui.panel', syncAllPanelStates, true);

  function syncAllPanelStates() {
    document.querySelectorAll('.mdui-panel-item').forEach(function (item) {
      const header = item.querySelector('.mdui-panel-item-header');
      const body = item.querySelector('.mdui-panel-item-body');
      if (!header || !body) return;

      const isOpen = item.classList.contains('mdui-panel-item-open');
      header.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
      body.toggleAttribute('inert', !isOpen);
    });
  }

  // ---------- MDUI Select 键盘可访问性增强 ----------
  function getSelectMenuItems(selectDiv) {
    return Array.from(selectDiv.querySelectorAll('.mdui-select-menu-item'));
  }

  function setSelectHighlight(items, index) {
    items.forEach(function (item, i) {
      item.classList.toggle('xf-select-highlighted', i === index);
    });
    const highlighted = items[index];
    if (highlighted) {
      highlighted.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }

  function resetSelectHighlight(selectDiv) {
    getSelectMenuItems(selectDiv).forEach(function (item) {
      item.classList.remove('xf-select-highlighted');
    });
  }

  function enhanceSelect(selectDiv) {
    if (selectDiv.dataset.a11ySelectEnhanced) return;
    selectDiv.dataset.a11ySelectEnhanced = 'true';

    // 使 MDUI 生成的 select div 可聚焦，并标识为弹出菜单按钮
    selectDiv.setAttribute('tabindex', '0');
    selectDiv.setAttribute('role', 'button');
    selectDiv.setAttribute('aria-haspopup', 'listbox');

    // 尽量复用原生 select 的 aria-label
    const nativeSelect = selectDiv.previousElementSibling;
    if (nativeSelect && nativeSelect.tagName === 'SELECT') {
      const label = nativeSelect.getAttribute('aria-label');
      if (label) selectDiv.setAttribute('aria-label', label);
    }

    let highlightedIndex = -1;

    function syncExpanded() {
      const isOpen = selectDiv.classList.contains('mdui-select-open');
      selectDiv.setAttribute('aria-expanded', String(isOpen));
      if (!isOpen) {
        highlightedIndex = -1;
        resetSelectHighlight(selectDiv);
      }
    }

    const classObserver = new MutationObserver(syncExpanded);
    classObserver.observe(selectDiv, {
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
          // 菜单未打开时选项可能尚未渲染，轮询等待后再高亮首/末项。
          if (!items.length) {
            let attempts = 0;
            const direction = key;
            function waitForOpenAndHighlight() {
              const currentItems = getSelectMenuItems(selectDiv);
              if (currentItems.length) {
                highlightedIndex = direction === 'ArrowDown' ? 0 : currentItems.length - 1;
                setSelectHighlight(currentItems, highlightedIndex);
                return;
              }
              if (++attempts < 30) {
                requestAnimationFrame(waitForOpenAndHighlight);
              }
            }
            requestAnimationFrame(waitForOpenAndHighlight);
            return;
          }
          highlightedIndex = key === 'ArrowDown' ? 0 : items.length - 1;
        } else {
          if (!items.length) return;
          const delta = key === 'ArrowDown' ? 1 : -1;
          highlightedIndex = (highlightedIndex + delta + items.length) % items.length;
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

  function enhanceAllSelects(container) {
    container.querySelectorAll('div.mdui-select:not([data-a11y-select-enhanced])').forEach(enhanceSelect);
  }

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
      // 动态加载的面板（如公告）可能先插入空 panel-item，之后再补 header/body，
      // 因此新增 header/body 时也要尝试初始化其父面板。
      if (node.matches && (node.matches('.mdui-panel-item-header') || node.matches('.mdui-panel-item-body'))) {
        const panelItem = node.closest('.mdui-panel-item:not([data-a11y-inited])');
        if (panelItem) initPanelItem(panelItem);
      }
      if (node.querySelectorAll) {
        initAllPanels(node);
        enhanceAllSelects(node);
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
    enhanceAllSelects(document);

    // MDUI 的 select 初始化时机不稳定（取决于 CDN/缓存），如果首次未找到则轮询增强。
    if (!document.querySelectorAll('div.mdui-select').length) {
      let attempts = 0;
      function retryEnhanceSelects() {
        enhanceAllSelects(document);
        if (++attempts < 60 && !document.querySelectorAll('div.mdui-select').length) {
          requestAnimationFrame(retryEnhanceSelects);
        }
      }
      requestAnimationFrame(retryEnhanceSelects);
    }

    const observer = new MutationObserver(schedulePanelsUpdate);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
    });
  }

  // 模块脚本执行时 readyState 可能为 interactive，但 MDUI 的组件初始化在
  // DOMContentLoaded 回调中完成，因此需要推迟到该事件之后再做首次增强。
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootstrap);
  } else {
    // interactive/complete：MDUI 的 DOMContentLoaded 回调正在执行或已执行，
    // 推到下一任务循环确保组件实例已创建。
    setTimeout(bootstrap, 0);
  }
})();