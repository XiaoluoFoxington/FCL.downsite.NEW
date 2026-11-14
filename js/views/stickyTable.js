/**
 * 表格粘滞辅助。
 *
 * 1. createStickyColumn：给表格指定列的所有单元格加粘滞样式，横向滚动时该列不动。
 * 2. createStickyTableHeader：把表头复制到横向滚动容器之外，让它粘在视口顶部。
 *
 * 为什么表头必须复制：.mdui-table-fluid 的 overflow-x: auto 会让它同时成为纵向滚动容器，
 * 而 position: sticky 只相对最近的滚动容器生效，所以真正的 <thead> 永远粘不到视口上。
 * 复制出来的表头放在滚动容器外面，纵向交给页面滚动，横向偏移用 scrollLeft 同步。
 *
 * 性能约定：
 * - 滚动路径上只做必要的几何读取，不查 DOM、不在读取之间穿插样式写入；
 * - 数值没变就不写样式，隐藏时连 top 都不写；
 * - 横向同步跟着 scroll 事件立刻执行，纵向显隐走 rAF 合并；
 * - 只有容器尺寸变化才重新测量列宽，筛选面板的高度变化只更新 top。
 */

/**
 * 给表格指定列的所有单元格加上粘滞样式，并提升其 z-index
 * @param {HTMLTableElement} table 表格元素
 * @param {number} columnIndex 目标列索引（从 0 开始）
 * @param {string} [className='xf-vertical-sticky-th'] 要添加的样式类名
 * @returns {HTMLTableElement} 处理后的表格元素
 */
export function createStickyColumn(table, columnIndex, className = 'xf-vertical-sticky-th') {
  if (!(table instanceof HTMLTableElement)) {
    throw new TypeError('第一个参数必须是 <table> 元素');
  }

  const index = Number(columnIndex);
  if (!Number.isInteger(index) || index < 0) {
    throw new RangeError('列索引必须是非负整数');
  }

  const rows = Array.from(table.rows);
  const occupied = rows.map(() => new Set()); // 记录被 rowspan 占用的列
  const stickyCells = new Set();             // 需要粘滞的单元格

  // 第一遍：找出所有需要粘滞的单元格，并收集非粘滞单元格的最大 z-index
  let maxZIndex = 0;

  rows.forEach((row, r) => {
    let col = 0;

    Array.from(row.cells).forEach((cell) => {
      // 跳过被上方 rowspan 占用的列
      while (occupied[r].has(col)) col++;

      const colspan = cell.colSpan || 1;
      const rowspan = cell.rowSpan || 1;

      // 判断该单元格是否覆盖目标列
      const isSticky = col <= index && index < col + colspan;

      if (isSticky) {
        stickyCells.add(cell);
      } else {
        // 非粘滞单元格：获取计算后的 z-index
        const computedZ = window.getComputedStyle(cell).zIndex;
        const z = computedZ === 'auto' ? 0 : parseInt(computedZ, 10) || 0;
        if (z > maxZIndex) maxZIndex = z;
      }

      // 登记 rowspan 占用信息
      if (rowspan > 1) {
        for (let rr = r + 1; rr < Math.min(r + rowspan, rows.length); rr++) {
          for (let c = col; c < col + colspan; c++) {
            occupied[rr].add(c);
          }
        }
      }

      col += colspan;
    });
  });

  // 第二遍：给粘滞单元格添加类并设置 z-index
  const stickyZIndex = maxZIndex + 1;
  stickyCells.forEach((cell) => {
    cell.classList.add(className);
    cell.style.zIndex = stickyZIndex;
  });

  return table;
}

/** 粘滞表头的默认上边界（与 .mdui-appbar 高度一致）。 */
const DEFAULT_TOP = 64;

/**
 * 创建粘滞表头。
 *
 * 表头被克隆到 wrapper 之前，wrapper 仍是唯一负责横向滚动的元素。
 * 返回的句柄中：
 * - element：插入到 wrapper 前面的粘滞层（无高度，不参与布局）
 * - refresh：表头文字、列数或列宽变化后重新克隆并测量（同一帧内多次调用只执行一次）
 * - destroy：移除监听与 DOM，表格区域被整体销毁时调用
 *
 * @param {HTMLElement} wrapper 表格的横向滚动容器（.mdui-table-fluid），必须是已插入文档的 section 直属子元素
 * @param {object} [options]
 * @param {number|(() => number)} [options.top=64] 粘滞位置的上边界；传函数可跟随筛选面板高度变化
 * @param {HTMLElement} [options.offsetElement] 影响 top 的元素（如筛选面板），只有它变化时才更新 top
 * @returns {{ element: HTMLDivElement, refresh: () => void, destroy: () => void }}
 */
export function createStickyTableHeader(wrapper, { top = DEFAULT_TOP, offsetElement } = {}) {
  if (!(wrapper instanceof HTMLElement)) {
    throw new TypeError('第一个参数必须是表格的滚动容器元素');
  }
  const parent = wrapper.parentNode;
  if (!parent) {
    throw new Error('表格容器还没有插入文档，无法确定粘滞范围');
  }

  const pin = document.createElement('div');
  pin.className = 'xf-sticky-thead';
  // 复制出来的表头只是视觉替身，读屏仍应只读原表头。
  pin.setAttribute('aria-hidden', 'true');

  const scroller = document.createElement('div');
  scroller.className = 'xf-sticky-thead-scroller';
  pin.appendChild(scroller);
  parent.insertBefore(pin, wrapper);

  // 边框宽度不随主题变化，取一次即可，避免每次测量都做一次样式计算。
  const wrapperStyle = window.getComputedStyle(wrapper);
  const borderLeft = wrapperStyle.borderLeftWidth;
  const borderRight = wrapperStyle.borderRightWidth;

  let table = null;          // 缓存的源表格与表头：滚动路径上不再查 DOM
  let thead = null;
  let cloneTable = null;
  let visible = false;
  let destroyed = false;

  let lastTop = NaN;         // 上次写入的 top，数值没变就不碰样式
  let lastScrollLeft = 0;    // 上次同步的横向偏移

  // 粘滞表头只是视觉替身：点击要转发给真正的表头，列表页的排序就挂在表头上。
  pin.addEventListener('click', (event) => {
    const cloneCell = event.target.closest?.('th');
    if (!cloneCell || !cloneTable?.contains(cloneCell)) return;
    const cloneRow = cloneCell.parentElement;
    const rowIndex = Array.prototype.indexOf.call(cloneTable.tHead?.rows || [], cloneRow);
    const cellIndex = Array.prototype.indexOf.call(cloneRow.cells, cloneCell);
    thead?.rows[rowIndex]?.cells[cellIndex]?.click();
  });

  let syncFrame = 0;         // 纵向显隐的 rAF
  let measureFrame = 0;      // 尺寸变化后的测量 rAF
  let refreshFrame = 0;      // 重建表头的 rAF

  /** 读取上边界；异常值一律退回默认值，避免表头被顶出视口。 */
  function resolveTop() {
    const value = typeof top === 'function' ? top() : top;
    const number = Number(value);
    return Number.isFinite(number) ? number : DEFAULT_TOP;
  }

  function setVisible(next) {
    if (next === visible) return;
    visible = next;
    pin.toggleAttribute('data-visible', next);
  }

  function resolveRefs() {
    table = wrapper.querySelector('table');
    thead = table?.tHead || null;
  }

  /** 逐列复制宽度。克隆表用固定布局，宽度完全由这里写入，才能和表体严格对齐。 */
  function measure() {
    if (!table || !cloneTable) return;
    const sourceRow = thead?.rows[0];
    const cloneRow = cloneTable.tHead?.rows[0];
    if (!sourceRow || !cloneRow) return;

    const sourceCells = Array.from(sourceRow.cells);
    const cloneCells = Array.from(cloneRow.cells);
    // 先一次读完所有列宽，再开始写，避免读写交错触发同步布局。
    const widths = sourceCells.map((cell) => cell.getBoundingClientRect().width);

    // 清掉上一轮宽度，否则固定布局会沿用旧值，列宽再也缩不回来。
    cloneCells.forEach((cell) => { cell.style.width = ''; });

    if (cloneCells.length === widths.length) {
      cloneTable.style.tableLayout = 'fixed';
      cloneTable.style.width = `${widths.reduce((sum, width) => sum + width, 0)}px`;
      cloneCells.forEach((cell, index) => { cell.style.width = `${widths[index]}px`; });
    } else {
      // 列数对不上（例如表头含 colspan）时退回自动布局，宁可宽度不完美也不要错位。
      cloneTable.style.tableLayout = '';
      cloneTable.style.width = `${table.getBoundingClientRect().width}px`;
    }

    // 滚动容器有边框，克隆表要从内容边缘开始才算对齐。
    scroller.style.left = borderLeft;
    scroller.style.right = borderRight;
    scroller.style.height = `${cloneTable.getBoundingClientRect().height}px`;
  }

  /** 重建克隆表头：表头文字或列数变化后必须重新克隆。 */
  function rebuild() {
    resolveRefs();
    const head = thead;
    if (!table || !head || !head.rows.length) {
      cloneTable = null;
      scroller.replaceChildren();
      setVisible(false);
      return;
    }

    const nextTable = document.createElement('table');
    nextTable.className = `${table.className} xf-sticky-thead-table`;
    // 只克隆 thead：带上 tbody 会让列宽被行内容左右，反而和表头对不齐。
    nextTable.appendChild(head.cloneNode(true));
    // 克隆体不需要交互：去掉重复 id 避免 getElementById 命中两份，
    // 去掉 tabindex 避免键盘 Tab 在 aria-hidden 的替身里多停一站。
    nextTable.querySelectorAll('[id]').forEach((node) => node.removeAttribute('id'));
    nextTable.querySelectorAll('[tabindex]').forEach((node) => node.removeAttribute('tabindex'));

    scroller.replaceChildren(nextTable);
    cloneTable = nextTable;
    measure();
  }

  function sync() {
    if (destroyed) return;

    // 读阶段：一次取完所有几何信息，写阶段不再穿插读取。
    const topValue = resolveTop();
    const wrapperRect = wrapper.getBoundingClientRect();
    const headRect = thead?.getBoundingClientRect();
    const scrollLeft = wrapper.scrollLeft;

    // 原表头滚过粘滞线、且表格整体还没滚出视口时才显示替身。
    const shouldShow = Boolean(headRect)
      && headRect.bottom <= topValue + 0.5
      && wrapperRect.bottom > topValue + 0.5;

    // 写阶段：隐藏时连 top 都不写，页面大部分滚动区间里没有任何样式变更。
    if (shouldShow && topValue !== lastTop) {
      lastTop = topValue;
      pin.style.top = `${topValue}px`;
    }
    setVisible(shouldShow);

    if (scrollLeft !== lastScrollLeft) {
      lastScrollLeft = scrollLeft;
      scroller.scrollLeft = scrollLeft;
    }
  }

  /** 横向同步直接跟随 scroll 事件，不经过 rAF，表头才不会比表体慢半拍。 */
  function syncScrollLeft() {
    if (destroyed) return;
    const scrollLeft = wrapper.scrollLeft;
    if (scrollLeft === lastScrollLeft) return;
    lastScrollLeft = scrollLeft;
    scroller.scrollLeft = scrollLeft;
  }

  function scheduleSync() {
    if (syncFrame || destroyed) return;
    syncFrame = requestAnimationFrame(() => {
      syncFrame = 0;
      sync();
    });
  }

  /** 合并同一帧内的多次尺寸变化（筛选面板的折叠动画每帧都会触发观察器）。 */
  function scheduleMeasure() {
    if (measureFrame || destroyed) return;
    measureFrame = requestAnimationFrame(() => {
      measureFrame = 0;
      if (destroyed) return;
      if (syncFrame) {
        cancelAnimationFrame(syncFrame);
        syncFrame = 0;
      }
      measure();
      sync();
    });
  }

  // 页面滚动负责纵向显隐；表格自身的横向滚动由 wrapper 直接通知。
  // 不用 window 的捕获阶段监听：那会把页面上所有滚动容器的事件都收进来（包括我们自己同步 scrollLeft 产生的）。
  wrapper.addEventListener('scroll', syncScrollLeft, { passive: true });
  window.addEventListener('scroll', scheduleSync, { passive: true });
  window.addEventListener('resize', scheduleMeasure);

  const measureObserver = typeof ResizeObserver === 'function' ? new ResizeObserver(scheduleMeasure) : null;
  // 只观察 wrapper：它宽度跟随容器、高度跟随表格，列宽变化必然先反映到这里。
  measureObserver?.observe(wrapper);

  // 筛选面板只影响 top，不需要重新测量列宽。
  const offsetObserver = offsetElement && typeof ResizeObserver === 'function'
    ? new ResizeObserver(scheduleSync)
    : null;
  offsetObserver?.observe(offsetElement);

  // 站点使用自定义字体，字体加载完成后列宽会变，必须重新测量。
  document.fonts?.ready.then(scheduleMeasure);

  /** 同一帧内多次调用只重建一次（筛选勾选会连续触发）。 */
  function refresh() {
    if (destroyed || refreshFrame) return;
    refreshFrame = requestAnimationFrame(() => {
      refreshFrame = 0;
      if (destroyed) return;
      rebuild();
      sync();
    });
  }

  function destroy() {
    if (destroyed) return;
    destroyed = true;
    wrapper.removeEventListener('scroll', syncScrollLeft);
    window.removeEventListener('scroll', scheduleSync);
    window.removeEventListener('resize', scheduleMeasure);
    if (syncFrame) cancelAnimationFrame(syncFrame);
    if (measureFrame) cancelAnimationFrame(measureFrame);
    if (refreshFrame) cancelAnimationFrame(refreshFrame);
    measureObserver?.disconnect();
    offsetObserver?.disconnect();
    pin.remove();
  }

  rebuild();
  sync();

  return { element: pin, refresh, destroy };
}
