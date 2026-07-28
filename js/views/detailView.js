import { getFeedbackChannels } from '../repositories/siteRepository.js';
import { renderStatus, setErrorTitle, setSoftwareHeader } from './commonView.js';
import { isSafeNavigationUrl } from '../security/content.js';
import { createExternalLink, createGrid } from './uiComponents.js';

let errorToken = 0;

/** 将详情表格置为加载状态，仍遵守 tbody 只能包含 tr 的 HTML 结构。 */
export function renderDetailLoading(elements) {
  renderTableStatus(elements.body, 2, 'loading', '正在加载软件详情……');
  if (elements.mirrorInfoBody) {
    renderTableStatus(elements.mirrorInfoBody, 4, 'loading', '正在加载线路预览……');
  }
}

/** 展示详情错误并显示反馈按钮（或反馈渠道加载状态）。 */
export function renderDetailError(elements, error, onRetry) {
  const token = ++errorToken;
  setErrorTitle();
  renderTableStatus(elements.body, 2, 'error', error.message, onRetry);
  if (elements.mirrorInfoBody) {
    renderTableStatus(elements.mirrorInfoBody, 4, 'error', error.message, onRetry);
  }

  // 清空操作区，先显示加载状态
  elements.operations.replaceChildren();
  renderStatus(elements.operations, 'loading', { message: '加载反馈渠道...' });

  // 异步获取反馈渠道
  getFeedbackChannels()
    .then((channels) => {
      if (token !== errorToken) return; // 已被新状态覆盖
      // 清除加载状态
      elements.operations.replaceChildren();
      if (channels.length > 0) {
        // 正常显示反馈按钮
        const feedBtn = document.createElement('a');
        feedBtn.href = channels[0].href;
        feedBtn.target = '_blank';
        feedBtn.rel = 'noopener noreferrer';
        feedBtn.className = 'mdui-btn mdui-btn-block mdui-btn-raised mdui-ripple';

        const icon = document.createElement('i');
        icon.className = 'mdui-icon material-icons';
        icon.textContent = 'feedback';
        feedBtn.append(icon, ` 通过 ${channels[0].name} 反馈问题`);
        elements.operations.appendChild(feedBtn);
      } else {
        // 无反馈渠道，显示错误状态并提供重试
        renderStatus(elements.operations, 'error', { message: '暂无反馈渠道', onRetry });
      }
    })
    .catch((err) => {
      if (token !== errorToken) return;
      // 获取渠道失败，显示错误状态并提供重试
      renderStatus(elements.operations, 'error', { message: `反馈渠道加载失败: ${err.message}`, onRetry });
    });
}

/**
 * 渲染表格状态行。
 * @param {HTMLTableElement} body - 要插入状态行的 tbody 元素。
 * @param {number} colspan - 状态内容单元格的 colspan 属性值，包括 label 列。
 * @param {string} state - 状态类型，'loading'、'error' 或'success'。
 * @param {string} message - 状态消息，显示在表格中。
 * @param {function} onRetry - 点击重试按钮时调用的回调函数。
 */
function renderTableStatus(body, colspan = 2, state, message, onRetry) {
  // tbody 只能直接放 tr，不能把通用 div 状态组件直接插入表格。
  const row = document.createElement('tr');
  const label = document.createElement('td');
  const content = document.createElement('td');
  content.colSpan = colspan - 1; // 减去 label 列
  label.textContent = state === 'error' ? '错误' : '状态';
  row.append(label, content);
  body.replaceChildren(row);
  // 必须先把 row 挂进文档再渲染状态：renderStatus 内部调用 mdui.mutation()，
  // 若 content 仍是游离节点，mutation 扫不到 spinner，第二个加载块就不会显示 spinner。
  renderStatus(content, state, { message, onRetry });
}

/**
 * 渲染完整详情表。
 * basic 来自软件目录；detail.info 是可选的补充字段数组；
 * tags 用于将 basic.tagIds 从数字翻译为人可读名称；
 * mirrors 用于将 detail.download 中的 mirrorId 翻译为线路名称。
 */
export function renderDetail(elements, id, basic, detail, tags, mirrors) {
  errorToken++;
  // 重置操作按钮区域，移除所有子元素（包括错误时添加的反馈按钮），重新添加三个操作按钮
  const container = elements.operations;
  const containerGrid = createGrid();
  const gridDown = document.createElement('div');
  gridDown.className = 'mdui-col-xs-12 mdui-col-sm-4';
  gridDown.appendChild(elements.download);
  const gridIntro = document.createElement('div');
  gridIntro.className = 'mdui-col-xs-12 mdui-col-sm-4';
  gridIntro.appendChild(elements.intro);
  const gridHistory = document.createElement('div');
  gridHistory.className = 'mdui-col-xs-12 mdui-col-sm-4';
  gridHistory.appendChild(elements.history);
  containerGrid.append(gridDown, gridIntro, gridHistory);
  container.replaceChildren(containerGrid);

  setSoftwareHeader(basic);
  elements.operations.hidden = false;
  const tagMap = new Map(tags.map((tag) => [tag.id, tag.name]));
  // value 可以是字符串，也可以是受本 view 创建的安全 DOM 节点（图标或外链）。
  const rows = [
    ['名称', basic.name],
    ['图标', createIcon(basic)],
    ['ID', String(id)],
    ['TAG', basic.tagIds.map((tagId) => tagMap.get(tagId) || String(tagId)).join(', ')],
  ];
  (detail.info || []).forEach((item) => rows.push([item.name, createInfoValue(item)]));

  const fragment = document.createDocumentFragment();
  rows.forEach(([name, value]) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const valueCell = document.createElement('td');
    nameCell.textContent = name;
    if (value instanceof Node) valueCell.appendChild(value);
    else valueCell.textContent = value;
    row.append(nameCell, valueCell);
    fragment.appendChild(row);
  });
  elements.body.replaceChildren(fragment);

  elements.isRandomSelect.textContent = detail.randomSelectMirror ? '是' : '否';
  renderMirrorInfo(elements.mirrorInfoBody, detail.download, mirrors);

  elements.download.href = `/html/down.html?id=${id}`;
  elements.intro.href = `/html/intro.html?id=${id}`;
  elements.history.href = `/html/rh.html?id=${id}`;
  elements.download.removeAttribute('disabled');
  elements.intro.removeAttribute('disabled');
  elements.history.removeAttribute('disabled');
}

/** 创建详情内的惰性图标节点；尺寸固定可减少表格首次渲染的布局变化。 */
function createIcon(basic) {
  const image = document.createElement('img');
  image.src = basic.icon || '/media/img/picMissing.webp';
  image.alt = basic.name;
  image.className = 'xf-detail-icon';
  image.width = 64;
  image.height = 64;
  image.loading = 'lazy';
  return image;
}

/** 将 detail.info 的一项转为纯文本或安全外链节点。 */
function createInfoValue(item) {
  // 外部信息链接经过协议校验，并明确隔离新窗口的 opener。
  if (!item.href || !isSafeNavigationUrl(item.href)) return item.text || item.href || '';
  return createExternalLink(item.href, item.text || item.href);
}

/**
 * 渲染线路预览表。
 * downloads 项结构为 { mirrorId, key, notJoinRandom? }；mirrors 提供 id→name 映射，
 * 找不到时降级显示纯 ID，避免孤立的 mirrorId 让用户误以为是配置错位。
 */
function renderMirrorInfo(body, downloads, mirrors) {
  if (!body) return;
  const list = Array.isArray(downloads) ? downloads : [];
  if (list.length === 0) {
    renderTableStatus(body, 4, 'empty', '该软件暂无下载线路');
    return;
  }
  const mirrorMap = new Map((mirrors || []).map((mirror) => [mirror.id, mirror]));
  const fragment = document.createDocumentFragment();
  list.forEach((download) => {
    const row = document.createElement('tr');
    const idCell = document.createElement('td');
    const nameCell = document.createElement('td');
    const urlCell = document.createElement('td');
    const randomCell = document.createElement('td');
    const mirror = mirrorMap.get(download.mirrorId);

    idCell.textContent = download.mirrorId;
    if (mirror) {
      nameCell.textContent = mirror.name;
      urlCell.appendChild(createExternalLink(mirror.baseUrl + download.key));
    } else {
      nameCell.textContent = '未知线路';
      urlCell.textContent = '（线路配置缺失）';
    }
    randomCell.textContent = download.notJoinRandom ? '否' : '是';
    row.append(idCell, nameCell, urlCell, randomCell);
    fragment.appendChild(row);
  });
  body.replaceChildren(fragment);
}