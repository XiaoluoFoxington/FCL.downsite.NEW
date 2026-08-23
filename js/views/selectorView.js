import { inferArchitecture } from '../domain/systemInfo.js';
import { isSafeNavigationUrl } from '../security/content.js';
import { formatBytes, renderStatus } from './commonView.js';
import { createExternalLink, createFluidTable, createRaisedButton } from './uiComponents.js';
import { logWarn } from '../common/logger.js';
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
 * 判断下载 URL 是否命中系统扩展名白名单。
 * 只比较 URL 路径部分的文件扩展名（大小写不敏感），支持 tar.gz 等复合扩展名。
 * @param {string} url 下载地址
 * @param {Array<string>} extensions 扩展名列表（不含点，小写）
 * @returns {boolean} 命中返回 true
 */
function matchesOsExtension(url, extensions) {
  try {
    const pathname = new URL(url, window.location.href).pathname.toLowerCase();
    return extensions.some((ext) => pathname.endsWith(`.${ext.toLowerCase()}`));
  } catch (_) {
    return false;
  }
}

/**
 * 下载选择器的纯 DOM 视图。
 * 它不读取远程数据也不保存当前选择：controller 传入节点和回调，
 * 因而更换镜像协议不会影响表格、筛选和可访问性渲染。
 * osExtensions 是系统自动筛选白名单，与选择层级无关，直接作用于最终下载表格。
 */
export function createSelectorView(container, stopButton, matchedArchitecture, osExtensions = []) {
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

    const rows = validItems.map((item) => {
      const architecture = inferArchitecture(item);
      // 配置 filter 是 URL 正则白名单；系统自动筛选按扩展名白名单叠加（AND）。
      // 任一条件未命中即隐藏，但允许用户手动展开查看。
      const configMissed = Array.isArray(filter) && filter.length > 0
        && !filter.some((pattern) => {
          try {
            return new RegExp(pattern).test(item.downloadUrl);
          } catch (_) {
            logWarn(_, { key: 'logger.context.invalidFilterRegex', params: { pattern } });
            return false;
          }
        });
      const osMissed = osExtensions.length > 0 && !matchesOsExtension(item.downloadUrl, osExtensions);
      return {
        item,
        architecture,
        hidden: configMissed || osMissed,
        values: {
          architecture,
          description: item.description || '',
          size: item.size != null ? formatBytes(item.size) : '',
          name: item.name || '',
          url: item.downloadUrl,
        },
      };
    });
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
      if (row.hidden) tr.classList.add('xf-filter-hidden');
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

    // 所有行都被筛选条件隐藏时，表体不能空白：插入一行可读提示，说明现状并引导用户展开。
    const hiddenCount = rows.filter((row) => row.hidden).length;
    if (rows.length > 0 && hiddenCount === rows.length) {
      const emptyTr = document.createElement('tr');
      emptyTr.className = 'xf-filter-empty';
      const emptyTd = document.createElement('td');
      emptyTd.colSpan = visibleColumns.length;
      emptyTd.textContent = t('common.filterNoMatch');
      emptyTr.appendChild(emptyTd);
      tbody.appendChild(emptyTr);
    }

    table.append(thead, tbody);
    wrapper.appendChild(table);

    if (matchedArchitecture && rows.some((row) => row.architecture === matchedArchitecture)) {
      const note = document.createElement('p');
      note.className = 'description mdui-typo';
      note.textContent = t('common.matchedArchHint');
      section.appendChild(note);
    }

    if (hiddenCount) {
      // 配置 filter 与系统自动筛选是两条独立的隐藏规则，分别说明原因。
      if (Array.isArray(filter) && filter.length > 0) {
        const filterDes = document.createElement('div');
        filterDes.className = 'description mdui-typo';
        filterDes.textContent = t('common.filterDes', { filter: filter.join(', ') || '无' });
        section.appendChild(filterDes);
      }
      if (osExtensions.length > 0) {
        const osDes = document.createElement('div');
        osDes.className = 'description mdui-typo';
        osDes.textContent = t('common.osFilterHint', {
          exts: osExtensions.map((ext) => `.${ext}`).join(', '),
        });
        section.appendChild(osDes);
      }

      // 用户主动要求后才展示被规则隐藏的项目，保留"推荐架构优先"的默认体验。
      const showdiv = document.createElement('div');
      showdiv.className = 'description';
      const show = createRaisedButton(t('common.hiddenItems', { count: hiddenCount }), {
        block: true,
        onClick: () => {
          tbody.querySelectorAll('.xf-filter-hidden').forEach((row) => row.classList.remove('xf-filter-hidden'));
          // 全部隐藏时的占位提示行随展开一起移除，避免与真实数据行重复。
          tbody.querySelectorAll('tr.xf-filter-empty').forEach((row) => row.remove());
          show.setAttribute('disabled', 'true');
          show.textContent = t('common.hiddenItemsShowed', { count: hiddenCount });
        },
      });
      showdiv.appendChild(show);
      section.appendChild(showdiv);
    }
    section.appendChild(wrapper);
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
