import { inferArchitecture } from '../domain/systemInfo.js';
import { createFilterConfig } from '../domain/downloadFilter.js';
import { isSafeNavigationUrl } from '../security/content.js';
import { formatBytes, renderStatus, setFilterIndicator } from './commonView.js';
import { createExternalLink, createFluidTable, createMaterialIcon, createPanel, createPanelItem } from './uiComponents.js';
import { t } from '../common/i18n.js';

// 最终表格会删除所有行均为空的列，列名与下载项统一模型一一对应。
const COLUMN_DEFINITIONS = [
  ['common.actions', 'action'],
  ['common.architecture', 'architecture'],
  ['common.description', 'description'],
  ['common.size', 'size'],
  ['common.displayName', 'name'],
  ['URL', 'url'],
];

/** 建立 data-selector-level 标记的层级容器。level 从 0 开始递增。 */
function createLevel(container, level) {
  // 每一级各自占一个 section，使 clearFrom 能精确移除后续选择/表格而保留父级选择。
  const section = document.createElement('section');
  section.dataset.selectorLevel = String(level);
  container.appendChild(section);
  return section;
}

/**
 * 创建 MDUI 勾选框。
 * @param {string} label 勾选框文本
 * @param {boolean} checked 初始勾选状态
 * @param {(checked: boolean) => void} onChange 勾选状态变化回调
 * @returns {HTMLLabelElement}
 */
function createCheckbox(label, checked, onChange) {
  const labelEl = document.createElement('label');
  labelEl.className = 'mdui-checkbox';
  const input = document.createElement('input');
  input.type = 'checkbox';
  input.checked = checked;
  const icon = document.createElement('i');
  icon.className = 'mdui-checkbox-icon';
  const text = document.createTextNode(` ${label}`);
  labelEl.append(input, icon, text);
  input.addEventListener('change', () => onChange(input.checked));
  return labelEl;
}

/**
 * 渲染文件列表表格上方的筛选面板，默认展开。
 * 面板内容（类别定义与可见性判定）全部来自 domain 模块的 filterConfig；
 * 这里只维护用户勾选状态（state）并回调 onChange 让表格重新应用筛选。
 * 面板标题的筛选图标跟随状态变化（与列表页一致）：筛选生效（未勾选"显示全部"）
 * 时显示 filter_alt，勾选"显示全部"（筛选关闭）时显示 filter_alt_off。
 * "显示全部"排在最前（优先级最高）：勾选它时取消选择所有类别；
 * 勾选任一类别时自动取消选择"显示全部"（两者互斥，但类别之间可多选）。
 * @param {{categories: Array<{key: string, label: string, enabled: boolean}>}} filterConfig 筛选配置
 * @param {{showAll: boolean, checked: Record<string, boolean>}} state 勾选状态（直接读写）
 * @param {() => void} onChange 勾选变化后重新应用筛选的回调
 * @returns {HTMLDivElement} 筛选面板元素
 */
function createFilterPanel(filterConfig, state, onChange) {
  const panel = createPanel();
  panel.classList.add('xf-download-filter-panel');
  const { element, header, body } = createPanelItem(t('common.filter'), { isOpen: true });

  // 筛选图标跟随勾选状态变化（与列表页一致）：筛选生效（未勾选"显示全部"）时
  // 显示 filter_alt，勾选"显示全部"（筛选关闭）时显示 filter_alt_off。
  const iconOn = createMaterialIcon('filter_alt', { className: 'mdui-icon xf-filter-active-indicator' });
  const iconOff = createMaterialIcon('filter_alt_off', { className: 'mdui-icon xf-filter-active-indicator' });
  header.insertBefore(iconOff, header.firstChild);
  header.insertBefore(iconOn, header.firstChild);
  const updateIndicator = () => setFilterIndicator(iconOn, iconOff, !state.showAll);

  const boxes = document.createElement('div');
  boxes.className = 'xf-download-filter-categories';

  // "显示全部"优先级最高，排在面板最前：勾选时取消选择所有类别。
  // TODO: "显示全部"为硬编码中文，应改用既有键 t('common.showAll')（7 个语言包均已提供）。
  const showAllBox = createCheckbox('显示全部', state.showAll, (checked) => {
    state.showAll = checked;
    if (checked) {
      boxes.querySelectorAll('input[data-filter-category]').forEach((input) => {
        input.checked = false;
        state.checked[input.dataset.filterCategory] = false;
      });
    }
    updateIndicator();
    onChange();
  });
  const showAllInput = showAllBox.querySelector('input');
  boxes.appendChild(showAllBox);

  // 类别勾选框：未启用的类别不渲染（如无数据源筛选条件、无法识别系统时）。
  // 初始勾选状态由 domain 模块的 createDefaultState 决定（默认勾选数据源/当前系统）。
  // 勾选任一类别时自动取消选择"显示全部"。
  filterConfig.categories.forEach((category) => {
    if (!category.enabled) return;
    const box = createCheckbox(category.label, state.checked[category.key] === true, (checked) => {
      state.checked[category.key] = checked;
      // 类别与"显示全部"互斥：选中类别即视为用户放弃"显示全部"。
      if (checked && state.showAll) {
        state.showAll = false;
        showAllInput.checked = false;
      }
      updateIndicator();
      onChange();
    });
    // 用 dataset 标记类别勾选框，便于"显示全部"统一取消选择。
    box.querySelector('input').dataset.filterCategory = category.key;
    boxes.appendChild(box);
  });

  body.appendChild(boxes);
  panel.appendChild(element);

  // 初始图标状态与当前勾选状态一致。
  updateIndicator();
  return panel;
}

/**
 * 下载选择器的纯 DOM 视图。
 * 它不读取远程数据也不保存当前选择：controller 传入节点和回调，
 * 因而更换镜像协议不会影响表格、筛选和可访问性渲染。
 * osExtensions/osName 是系统筛选信息，与选择层级无关，直接作用于最终下载表格。
 */
export function createSelectorView(container, stopButton, matchedArchitecture, osExtensions = [], osName = '') {
  function clearFrom(level) {
    // 删除 level 及之后的 section；父级选择框必须保留，用户才能改选线路。
    container.querySelectorAll('[data-selector-level]').forEach((element) => {
      if (Number(element.dataset.selectorLevel) >= level) element.remove();
    });
  }

  function setBusy(busy) {
    // 请求期间锁定已有控件，避免用户同时改变多个层级；终止按钮是唯一保留的操作入口。
    container.querySelectorAll('select, button, a').forEach((control) => {
      if ('disabled' in control) control.disabled = busy;
      // 带 aria-disabled 的链接是数据层标记的“暂不可用”项，其禁用态必须持久保留，
      // 不能随 busy 开关被移除，否则加载完成后它会看起来可点击但实际点不动。
      if (control.getAttribute('aria-disabled') === 'true') return;
      control.classList.toggle('disabled', busy);
    });
    stopButton?.classList.toggle('xf-hide', !busy);
  }

  function renderSelect(items, level, onSelect) {
    // items 是分组节点；每项通常含 name、default 及 children/nextUrl。
    clearFrom(level);
    const section = createLevel(container, level);
    const select = document.createElement('select');
    select.className = 'mdui-select mdui-block';
    // select.setAttribute('mdui-select', '');
    select.setAttribute('aria-label', t('common.selectors.levelAria', { level: level + 1 }));
    items.forEach((item, index) => {
      const option = document.createElement('option');
      option.value = String(index);
      option.textContent = item.name || t('common.selectors.noName');
      select.appendChild(option);
    });
    const description = document.createElement('div');
    description.className = 'description';
    section.append(select, description);
    // select 的 value 存数组索引，避免依赖可能重复的线路名称。
    select.addEventListener('change', () => onSelect(items[Number(select.value)], description));

    const defaultIndex = items.findIndex((item) => item.default === true);
    select.value = String(defaultIndex >= 0 ? defaultIndex : 0);
    // MDUI 初始化必须要在默认值设置后，否则会内容错乱。
    window.mdui?.mutation();
    // 推到微任务：先让 DOM 和 MDUI 初始化完成，再触发默认线路的自动加载。
    queueMicrotask(() => onSelect(items[Number(select.value)], description));
  }

  function renderDownloads(items, level, filter, onDownload) {
    // items 是统一下载叶子；不会再读取 adapter 的 url、arch 等原始字段。
    clearFrom(level);
    const section = createLevel(container, level);
    // 下载地址必须为 http/https；非法项不产生可点击 DOM，避免配置错误变成安全问题。
    const validItems = items.filter((item) => item.downloadUrl && isSafeNavigationUrl(item.downloadUrl, { allowRelative: false }));
    if (!validItems.length) {
      renderStatus(section, 'empty', { message: t('common.noDownloadUrl') });
      return;
    }

    // 页面结构：下载面板 → 选择器们 → 描述信息 → 筛选面板 → 文件列表表格。

    // 筛选逻辑全部由 domain 模块集中处理（类别定义、文件归类、可见性判定），
    // 这里只渲染勾选框并把用户的选择应用到表格行。
    const filterConfig = createFilterConfig({ filter, osExtensions, osName });
    // 默认勾选状态由 domain 模块决定：数据源与当前系统（如可用），
    // 两者都不可用时回退为"显示全部"。
    const state = filterConfig.createDefaultState();

    const rows = validItems.map((item) => {
      const architecture = inferArchitecture(item);
      return {
        item,
        architecture,
        // 预先把文件归入类别；勾选框变化时无需重新归类。
        categories: filterConfig.classify(item),
        values: {
          architecture,
          description: item.description || '',
          size: item.size != null ? formatBytes(item.size) : '',
          name: item.name || '',
          url: item.downloadUrl,
        },
      };
    });

    if (matchedArchitecture && rows.some((row) => row.architecture === matchedArchitecture)) {
      const note = document.createElement('p');
      note.className = 'description mdui-typo';
      note.textContent = t('common.matchedArchHint');
      section.appendChild(note);
    }

    // 只保留至少有一行内容的元数据列，移动端不浪费横向空间。
    const visibleColumns = COLUMN_DEFINITIONS.filter(([, key]) => key === 'action' || rows.some((row) => row.values[key]));
    const { wrapper, table, thead, tbody } = createFluidTable();
    table.classList.add('xf-nowrap');
    const header = document.createElement('tr');
    visibleColumns.forEach(([labelKey]) => {
      const cell = document.createElement('th');
      cell.textContent = labelKey.startsWith('common.') ? t(labelKey) : labelKey;
      header.appendChild(cell);
    });
    thead.appendChild(header);

    rows.forEach((row) => {
      const tr = document.createElement('tr');
      row.tr = tr; // 供筛选面板切换行的隐藏状态
      if (row.architecture && row.architecture === matchedArchitecture) tr.classList.add('mdui-color-theme-accent');
      visibleColumns.forEach(([, key]) => {
        const cell = document.createElement('td');
        if (key === 'action') {
          const link = createExternalLink(row.item.downloadUrl, row.item.available === false ? t('common.notAvailable') : t('common.download'), {
            className: 'mdui-btn mdui-btn-block mdui-btn-raised mdui-ripple',
          });
          // 不可用线路仍展示原因和 URL，但阻止实际跳转，便于用户知情而非直接消失。
          if (row.item.available === false) {
            link.classList.add('disabled');
            link.setAttribute('aria-disabled', 'true');
            link.addEventListener('click', (event) => event.preventDefault());
          } else if (onDownload) {
            link.addEventListener('click', (event) => onDownload(row.item, event));
          }
          cell.appendChild(link);
        } else if (key === 'url') {
          cell.className = 'mdui-typo';
          cell.appendChild(createExternalLink(row.item.downloadUrl, row.item.downloadUrl));
        } else {
          cell.textContent = row.values[key];
        }
        tr.appendChild(cell);
      });
      tbody.appendChild(tr);
    });

    // 所有行都被筛选条件隐藏时，表体不能空白：保留一行可读提示，说明现状并引导用户调整筛选。
    // 是否显示由 applyFilter 根据当前勾选状态动态决定。
    const emptyTr = document.createElement('tr');
    emptyTr.className = 'xf-filter-empty';
    const emptyTd = document.createElement('td');
    emptyTd.colSpan = visibleColumns.length;
    emptyTd.textContent = t('common.filterNoMatch');
    emptyTr.appendChild(emptyTd);
    emptyTr.hidden = true;
    tbody.appendChild(emptyTr);

    table.append(thead, tbody);
    wrapper.appendChild(table);

    // 根据当前勾选状态切换行的可见性；筛选面板的勾选变化都会回调到这里。
    const applyFilter = () => {
      let visibleCount = 0;
      rows.forEach((row) => {
        const hidden = !filterConfig.isVisible(row.categories, state);
        row.tr.classList.toggle('xf-filter-hidden', hidden);
        if (!hidden) visibleCount += 1;
      });
      emptyTr.hidden = visibleCount > 0;
    };

    // 筛选面板位于文件列表表格之上，默认展开。
    section.appendChild(createFilterPanel(filterConfig, state, applyFilter));
    section.appendChild(wrapper);

    // 首屏按默认勾选状态应用筛选（数据源/当前系统，如可用）。
    applyFilter();
    window.mdui?.mutation();
  }

  function renderError(level, error, onRetry) {
    // 错误也占用一个层级，重试后 controller 会用同级新内容替换它。
    clearFrom(level);
    const section = createLevel(container, level);
    renderStatus(section, 'error', { message: error.message, onRetry });
  }

  return { clearFrom, renderDownloads, renderError, renderSelect, setBusy };
}
