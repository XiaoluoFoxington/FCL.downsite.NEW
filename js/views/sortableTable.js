/**
 * 可拖拽表格组件。
 *
 * 提供拖拽重排（带插入位置指示线）与编程式 move() 两种排序方式。
 * 组件在传入的容器内创建 <table>（可选 thead 表头与 tbody 行），
 * 只负责顺序与视觉，不负责持久化：每次重排后通过 onReorder(newItems) 通知调用方。
 * 顺序变化是“把被拖项插入到指针所在项的前/后半区”，指针位于项的下半区表示插到该项之后。
 */

import { logWarn } from '../common/logger.js';
import { createMaterialIcon, createSpan } from './uiComponents.js';

/**
 * 计算拖拽释放后的插入位置（相对于移除被拖项之后的数组）。
 * @param {number} itemCount 当前 DOM 中的行数量（含被拖行）
 * @param {number|null} draggedIndex 被拖行在当前数组中的索引
 * @param {number} pointerIndex 指针所在行的索引
 * @param {boolean} after 指针是否位于该行下半区（插到该行之后）
 * @returns {number} 移除被拖行后的插入索引
 */
export function resolveInsertIndex(itemCount, draggedIndex, pointerIndex, after) {
  let raw = pointerIndex + (after ? 1 : 0);
  if (draggedIndex !== null && raw > draggedIndex) raw -= 1;
  return Math.max(0, Math.min(raw, itemCount - 1));
}

/**
 * 创建可拖拽表格。
 * @param {HTMLElement} container 表格容器（普通元素，组件会在其中创建 <table>）
 * @param {object} options
 * @param {Array<*>} options.items 初始数据（任意类型，顺序由此数组决定）
 * @param {Array<{icon?: string, title?: string, className?: string, }>} [options.columns] 表头列定义；传空数组则不渲染表头
 * @param {(item: *, index: number) => HTMLTableRowElement} [options.renderRow] 渲染一行；返回的元素会被加上 sortable-table-row 类并启用拖拽
 * @param {(items: Array<*>) => void} [options.onReorder] 排序变化回调（参数为新的完整顺序）
 * @returns {{render: () => void, move: (from: number, to: number) => void, getItems: () => Array<*>}}
 */
export function createSortableTable(container, { items = [], columns = [], renderRow, onReorder } = {}) {
  // 同一容器重复挂载时直接返回既有实例，避免叠加指示线与重复监听。
  if (container._sortableTable) return container._sortableTable;

  let order = [...items];
  let draggedIndex = null;
  let insertIndex = null;
  let indicatorBoundary = null;

  container.classList.add('sortable-table-container', 'mdui-table-fluid', 'xf-nowrap');

  const table = document.createElement('table');
  // 基础样式用 MDUI 的 .mdui-table（含项目在 mdui.patch.css 中的主题适配），
  // .sortable-table 仅作为拖拽补丁的命名空间。
  table.className = 'mdui-table sortable-table';
  container.appendChild(table);

  const thead = document.createElement('thead');
  const tbody = document.createElement('tbody');
  if (columns.length) {
    const headerRow = document.createElement('tr');
    columns.forEach((col) => {
      const th = document.createElement('th');
      th.scope = 'col';
      if (col.className) th.className = col.className;
      if (col.icon) th.appendChild(createMaterialIcon(col.icon));
      if (col.title) th.appendChild(createSpan(col.title));
      headerRow.appendChild(th);
    });
    thead.appendChild(headerRow);
  }
  table.append(thead, tbody);

  // 插入指示线：绝对定位于容器内，拖拽时显示在目标行边界上。
  const indicator = document.createElement('div');
  indicator.className = 'sortable-table-indicator';
  indicator.hidden = true;
  container.appendChild(indicator);

  function itemElements() {
    return Array.from(tbody.querySelectorAll('.sortable-table-row'));
  }

  function resetDrag() {
    draggedIndex = null;
    insertIndex = null;
    indicatorBoundary = null;
    indicator.hidden = true;
    itemElements().forEach((tr) => tr.classList.remove('sortable-dragging'));
  }

  /** 计算插入指示线的边界位置：直接使用指针所在空隙（当前 DOM 中的空隙索引）。 */
  function positionIndicator() {
    const els = itemElements();
    if (!els.length) return;
    const containerRect = container.getBoundingClientRect();
    // 空隙索引即“第 boundary 行顶部”所在位置：0 = 第一行顶部，els.length = 最后一行底部。
    // 注意不能用 insertIndex 反推——insertIndex 等于被拖行原位（draggedIndex）时，
    // 无法区分“其上方空隙”与“其下方空隙”，会把指示线统一显示到被拖行下方。
    const boundary = indicatorBoundary;
    let y;
    if (boundary <= 0) {
      y = els[0].getBoundingClientRect().top;
    } else if (boundary >= els.length) {
      y = els[els.length - 1].getBoundingClientRect().bottom;
    } else {
      y = (els[boundary - 1].getBoundingClientRect().bottom + els[boundary].getBoundingClientRect().top) / 2;
    }
    indicator.hidden = false;
    indicator.style.top = `${y - containerRect.top - 3}px`;
    // TODO:
    // 3px 是指示线的高度。加上.mdui-table-fluid后当指示线在最后一个（最底下）项目的下方时高度会溢出，导致无法看到指示线。现加粗指示线到3px以露出一部分，但高度还是会溢出。
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
    // 指示线直接显示在指针所在空隙（当前 DOM 中第 pointerIndex 行顶/底部的空隙），
    // 与落位结果一致，见 positionIndicator 的说明。
    indicatorBoundary = pointerIndex + (after ? 1 : 0);
    positionIndicator();
  }

  /** 结束拖拽：把被拖行移到插入位置并提交新顺序。 */
  function commitDrop() {
    if (draggedIndex === null) return;
    const next = [...order];
    const [moved] = next.splice(draggedIndex, 1);
    next.splice(insertIndex ?? draggedIndex, 0, moved);
    resetDrag();
    commitOrder(next);
  }

  function render() {
    tbody.replaceChildren();
    indicator.hidden = true;
    order.forEach((item, index) => {
      let tr = renderRow ? renderRow(item, index) : document.createElement('tr');
      // renderRow 返回空值或非 tr 时兜底为空行，保证索引对齐且不抛错。
      if (!tr || tr.tagName !== 'TR') tr = document.createElement('tr');
      tr.classList.add('sortable-table-row');
      // 桌面端用 HTML5 拖拽；触屏/手写笔设备不触发 HTML5 拖拽，改用 Pointer Events 模拟
      //（见下方 pointer 事件监听）。触屏拖拽从手柄开始，避免与页面滚动手势冲突。
      tr.draggable = true;
      tr.dataset.sortableIndex = String(index);
      tr.addEventListener('dragstart', (event) => {
        draggedIndex = index;
        insertIndex = index;
        tr.classList.add('sortable-dragging');
        event.dataTransfer.effectAllowed = 'move';
        try {
          event.dataTransfer.setData('text/plain', String(index));
        } catch (_) {
          // 个别浏览器要求合法 MIME 类型，失败不影响拖拽。
        }
      });
      tr.addEventListener('dragend', resetDrag);
      tr.addEventListener('pointerdown', (event) => {
        // 鼠标保留 HTML5 拖拽；触屏/手写笔才走 Pointer Events，且一次只拖一行。
        if (event.pointerType === 'mouse' || draggedIndex !== null) return;
        // 若行内声明了拖拽手柄，只有从手柄按下才启动拖拽，行内其余区域留给页面滚动。
        const handle = tr.querySelector('[data-sortable-handle]');
        if (handle && !handle.contains(event.target)) return;
        event.preventDefault();
        draggedIndex = index;
        insertIndex = index;
        tr.classList.add('sortable-dragging');
        try {
          tr.setPointerCapture(event.pointerId);
        } catch (_) {
          // 个别环境不支持指针捕获：move/up/cancel 已委托到容器级监听（见下方），
          // 指针只要仍在容器内，拖拽与落位依然可用。
        }
      });
      // 鼠标交给 HTML5 拖拽：拖拽接管时浏览器会派发 pointercancel，若这里误清 draggedIndex，
      // 会让 dragover 不再 preventDefault，drop 被浏览器取消（拖得动却放不下）。
      // 因此 pointer 路径全部只响应触屏/手写笔（pointerType 非 mouse），
      // 且 move/up/cancel 绑定在容器级而非单行，指针移出行后指示线仍能更新。
      tbody.appendChild(tr);
    });
  }

  function commitOrder(next) {
    const changed = next.some((item, index) => item !== order[index]);
    if (!changed) return;
    order = next;
    try {
      if (typeof onReorder === 'function') onReorder([...next]);
    } catch (error) {
      logWarn(error, '可拖拽表格排序回调');
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

  // 触屏/手写笔拖拽：move/up/cancel 委托到容器级监听。
  // 绑定在容器上而非单行上，指针移出起始行后指示线仍能更新；
  // 且 setPointerCapture 失败的个别环境（见 pointerdown 的 catch）下，
  // 指针只要仍在容器内松手，就能正常提交排序。
  container.addEventListener('pointermove', (event) => {
    if (event.pointerType === 'mouse' || draggedIndex === null) return;
    updateInsertPosition(event.clientY);
  });
  container.addEventListener('pointerup', (event) => {
    if (event.pointerType === 'mouse' || draggedIndex === null) return;
    commitDrop();
  });
  container.addEventListener('pointercancel', (event) => {
    if (event.pointerType === 'mouse' || draggedIndex === null) return;
    resetDrag();
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
  container._sortableTable = api;
  render();
  return api;
}
