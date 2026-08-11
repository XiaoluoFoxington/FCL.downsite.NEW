/**
 * 可排序列表组件。
 *
 * 提供拖拽重排（带插入位置指示线）与编程式 move() 两种排序方式。
 * 组件只负责顺序与视觉，不负责持久化：每次重排后通过 onReorder(newItems) 通知调用方。
 * 顺序变化是“把被拖项插入到指针所在项的前/后半区”，指针位于项的下半区表示插到该项之后。
 */

import { logWarn } from '../common/logger.js';

/**
 * 计算拖拽释放后的插入位置（相对于移除被拖项之后的数组）。
 * @param {number} itemCount 当前 DOM 中的列表项数量（含被拖项）
 * @param {number|null} draggedIndex 被拖项在当前数组中的索引
 * @param {number} pointerIndex 指针所在项的索引
 * @param {boolean} after 指针是否位于该项下半区（插到该项之后）
 * @returns {number} 移除被拖项后的插入索引
 */
export function resolveInsertIndex(itemCount, draggedIndex, pointerIndex, after) {
  let raw = pointerIndex + (after ? 1 : 0);
  if (draggedIndex !== null && raw > draggedIndex) raw -= 1;
  return Math.max(0, Math.min(raw, itemCount - 1));
}

/**
 * 创建可排序列表。
 * @param {HTMLElement} container 列表容器
 * @param {object} options
 * @param {Array<*>} options.items 初始列表项（任意类型，顺序由此数组决定）
 * @param {(item: *, index: number) => HTMLElement} [options.renderItem] 渲染单项；返回的元素会被加上 sortable-list-item 类并启用拖拽
 * @param {(items: Array<*>) => void} [options.onReorder] 排序变化回调（参数为新的完整顺序）
 * @returns {{render: () => void, move: (from: number, to: number) => void, getItems: () => Array<*>}}
 */
export function createSortableList(container, { items = [], renderItem, onReorder } = {}) {
  // 同一容器重复挂载时直接返回既有实例，避免叠加指示线与重复监听。
  if (container._sortableList) return container._sortableList;

  let order = [...items];
  let draggedIndex = null;
  let insertIndex = null;

  container.classList.add('sortable-list');

  // 插入指示线：绝对定位于容器内，拖拽时显示在目标边界上。
  const indicator = document.createElement('div');
  indicator.className = 'sortable-list-indicator';
  indicator.hidden = true;
  container.appendChild(indicator);

  function itemElements() {
    return Array.from(container.querySelectorAll('.sortable-list-item'));
  }

  function resetDrag() {
    draggedIndex = null;
    insertIndex = null;
    indicator.hidden = true;
    itemElements().forEach((el) => el.classList.remove('sortable-dragging'));
  }

  /** 计算插入指示线的边界位置：把“移除被拖项后的插入索引”映射回当前 DOM 的边界。 */
  function boundaryIndex() {
    if (insertIndex === null) return 0;
    // k < d 时边界在 k 处；k >= d 时被拖项占住 k 的位置，边界顺延到 k + 1。
    return insertIndex < draggedIndex ? insertIndex : insertIndex + 1;
  }

  function positionIndicator() {
    const els = itemElements();
    if (!els.length) return;
    const containerRect = container.getBoundingClientRect();
    const boundary = boundaryIndex();
    let y;
    if (boundary <= 0) {
      y = els[0].getBoundingClientRect().top;
    } else if (boundary >= els.length) {
      y = els[els.length - 1].getBoundingClientRect().bottom;
    } else {
      y = (els[boundary - 1].getBoundingClientRect().bottom + els[boundary].getBoundingClientRect().top) / 2;
    }
    indicator.hidden = false;
    indicator.style.top = `${y - containerRect.top}px`;
  }

  /** 计算指针位置对应的插入索引并更新指示线（HTML5 拖拽与触屏拖拽共用）。 */
  function updateInsertPosition(clientY) {
    const els = itemElements();
    if (!els.length) return;
    let pointerIndex = els.length - 1;
    let after = true;
    for (let i = 0; i < els.length; i += 1) {
      const rect = els[i].getBoundingClientRect();
      if (clientY < rect.top + rect.height / 2) {
        pointerIndex = i;
        after = false;
        break;
      }
    }
    insertIndex = resolveInsertIndex(els.length, draggedIndex, pointerIndex, after);
    positionIndicator();
  }

  /** 结束拖拽：把被拖项移到插入位置并提交新顺序。 */
  function commitDrop() {
    if (draggedIndex === null) return;
    const next = [...order];
    const [moved] = next.splice(draggedIndex, 1);
    next.splice(insertIndex ?? draggedIndex, 0, moved);
    resetDrag();
    commitOrder(next);
  }

  function render() {
    itemElements().forEach((el) => el.remove());
    indicator.hidden = true;
    order.forEach((item, index) => {
      let el = renderItem ? renderItem(item, index) : document.createElement('div');
      // renderItem 返回空值时兜底为空行，保证索引对齐且不抛错。
      if (!el || typeof el.appendChild !== 'function') el = document.createElement('div');
      el.classList.add('sortable-list-item');
      // 桌面端用 HTML5 拖拽；触屏/手写笔设备不触发 HTML5 拖拽，改用 Pointer Events 模拟
      //（见下方 pointer 事件监听）。触屏拖拽从手柄开始，避免与页面滚动手势冲突。
      el.draggable = true;
      el.dataset.sortableIndex = String(index);
      el.addEventListener('dragstart', (event) => {
        draggedIndex = index;
        insertIndex = index;
        el.classList.add('sortable-dragging');
        event.dataTransfer.effectAllowed = 'move';
        try {
          event.dataTransfer.setData('text/plain', String(index));
        } catch (_) {
          // 个别浏览器要求合法 MIME 类型，失败不影响拖拽。
        }
      });
      el.addEventListener('dragend', resetDrag);
      el.addEventListener('pointerdown', (event) => {
        // 鼠标保留 HTML5 拖拽；触屏/手写笔才走 Pointer Events，且一次只拖一项。
        if (event.pointerType === 'mouse' || draggedIndex !== null) return;
        // 若项内声明了拖拽手柄，只有从手柄按下才启动拖拽，行内其余区域留给页面滚动。
        const handle = el.querySelector('[data-sortable-handle]');
        if (handle && !handle.contains(event.target)) return;
        event.preventDefault();
        draggedIndex = index;
        insertIndex = index;
        el.classList.add('sortable-dragging');
        try {
          el.setPointerCapture(event.pointerId);
        } catch (_) {
          // 个别环境不支持指针捕获，元素仍在文档内，后续 move/up 监听依然有效。
        }
      });
      // 鼠标交给 HTML5 拖拽：拖拽接管时浏览器会派发 pointercancel，若这里误清 draggedIndex，
      // 会让 dragover 不再 preventDefault，drop 被浏览器取消（拖得动却放不下）。
      // 因此 pointer 路径全部只响应触屏/手写笔（pointerType 非 mouse）。
      el.addEventListener('pointermove', (event) => {
        if (event.pointerType === 'mouse' || draggedIndex !== index) return;
        updateInsertPosition(event.clientY);
      });
      el.addEventListener('pointerup', (event) => {
        if (event.pointerType === 'mouse' || draggedIndex !== index) return;
        commitDrop();
      });
      el.addEventListener('pointercancel', (event) => {
        if (event.pointerType === 'mouse' || draggedIndex !== index) return;
        resetDrag();
      });
      container.appendChild(el);
    });
  }

  function commitOrder(next) {
    const changed = next.some((item, index) => item !== order[index]);
    if (!changed) return;
    order = next;
    try {
      if (typeof onReorder === 'function') onReorder([...next]);
    } catch (error) {
      logWarn(error, '可排序列表排序回调');
    } finally {
      // 无论回调是否异常都重绘，保证组件内部状态与 DOM 一致。
      render();
    }
  }

  container.addEventListener('dragover', (event) => {
    if (draggedIndex === null) return;
    event.preventDefault();
    updateInsertPosition(event.clientY);
  });

  container.addEventListener('dragleave', (event) => {
    if (!container.contains(event.relatedTarget)) indicator.hidden = true;
  });

  container.addEventListener('drop', (event) => {
    if (draggedIndex === null) return;
    event.preventDefault();
    commitDrop();
  });

  function move(from, to) {
    if (
      from === to
      || from < 0 || to < 0
      || from >= order.length || to >= order.length
    ) return;
    const next = [...order];
    const [moved] = next.splice(from, 1);
    next.splice(to, 0, moved);
    commitOrder(next);
  }

  const api = {
    render,
    move,
    getItems: () => [...order],
  };
  container._sortableList = api;
  render();
  return api;
}
