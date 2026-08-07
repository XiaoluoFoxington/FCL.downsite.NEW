import { getFeedbackChannels } from '../repositories/siteRepository.js';
import { renderStatus, renderMessages, renderTableStatus, setErrorTitle, setSoftwareHeader } from './commonView.js';
import { isSafeNavigationUrl, joinUrl } from '../security/content.js';
import { createExternalLink, createGrid, createMaterialIcon } from './uiComponents.js';
import { isBookmarked, toggleBookmark, onBookmarkChange, offBookmarkChange } from '../domain/bookmarks.js';
import { readPreference } from '../domain/preferences.js';

// 反馈渠道异步请求的取消控制器：renderDetail 成功或再次进入 renderDetailError 时 abort 旧的，
// 既保护 DOM 不被旧响应写入，也取消进行中的网络请求避免无谓流量。
let feedbackAbort = null;

/**
 * 将详情表格置为加载状态，仍遵守 tbody 只能包含 tr 的 HTML 结构。
 * @param {HTMLTableElement} elements tbody 元素
 */
export function renderDetailLoading(elements) {
  renderTableStatus(elements.body, 2, 'loading', '正在加载软件详情……');
  if (elements.mirrorInfoBody) {
    renderTableStatus(elements.mirrorInfoBody, 4, 'loading', '正在加载线路预览……');
  }
  if (elements.messageWrapper) {
    elements.messageWrapper.hidden = true;
  }
}

/**
 * 展示详情错误并显示反馈按钮（或反馈渠道加载状态）。
 * @param {HTMLElement} elements 挂载容器
 * @param {Error} error 错误对象
 * @param {Function} onRetry 重试回调
 */
export function renderDetailError(elements, error, onRetry) {
  // 取消上一次进行中的反馈渠道请求，避免旧响应覆盖新状态。
  if (feedbackAbort) feedbackAbort.abort();
  const ac = new AbortController();
  feedbackAbort = ac;

  setErrorTitle();
  renderTableStatus(elements.body, 2, 'error', error.message, onRetry);
  if (elements.mirrorInfoBody) {
    renderTableStatus(elements.mirrorInfoBody, 4, 'error', error.message, onRetry);
  }
  if (elements.messageWrapper) {
    elements.messageWrapper.hidden = true;
  }

  // 清空操作区，先显示加载状态
  renderStatus(elements.operations, 'loading', { message: '加载反馈渠道...' });

  // 异步获取反馈渠道，signal 让旧请求在新状态进入时被真正取消。
  getFeedbackChannels({ signal: ac.signal })
    .then((channels) => {
      if (ac.signal.aborted) return; // 已被新状态覆盖
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
      if (ac.signal.aborted || err.kind === 'abort') return; // 被新状态取消，不显示错误
      // 获取渠道失败，显示错误状态并提供重试
      renderStatus(elements.operations, 'error', { message: `反馈渠道加载失败: ${err.message}`, onRetry });
    });
}

/**
 * 渲染完整详情表。
 * basic 来自软件目录；detail.info 是可选的补充字段数组；
 * tags 用于将 basic.tagIds 从数字翻译为人可读名称；
 * mirrors 用于将 detail.download 中的 mirrorId 翻译为线路名称。
 */
export function renderDetail(elements, id, basic, detail, tags, mirrors) {
  // 成功渲染时取消任何进行中的反馈渠道请求（若上一状态是错误态）。
  if (feedbackAbort) feedbackAbort.abort();
  // 重置操作按钮区域，移除所有子元素（包括错误时添加的反馈按钮），重新添加四个操作按钮
  const container = elements.operations;
  const containerGrid = createGrid();
  const gridColClass = 'mdui-col-xs-12 mdui-col-sm-3';
  const gridDown = document.createElement('div');
  gridDown.className = gridColClass;
  gridDown.appendChild(elements.download);
  const gridIntro = document.createElement('div');
  gridIntro.className = gridColClass;
  gridIntro.appendChild(elements.intro);
  const gridHistory = document.createElement('div');
  gridHistory.className = gridColClass;
  gridHistory.appendChild(elements.history);
  const gridBookmark = document.createElement('div');
  gridBookmark.className = gridColClass;
  const bookmarkBtn = createBookmarkButton(basic);
  gridBookmark.appendChild(bookmarkBtn);
  containerGrid.append(gridDown, gridIntro, gridHistory, gridBookmark);
  container.replaceChildren(containerGrid);

  // 收藏变更时同步按钮状态
  if (container._bookmarkSync) container._bookmarkSync();
  const syncHandler = () => {
    syncBookmarkButton(bookmarkBtn, basic);
  };
  onBookmarkChange(syncHandler);
  container._bookmarkSync = () => offBookmarkChange(syncHandler);

  setSoftwareHeader(basic, { titlePrefix: '资源详情' });
  elements.operations.hidden = false;
  const tagMap = new Map(tags.map((tag) => [tag.id, tag.name]));
  const iconTd = '图标';
  // value 可以是字符串，也可以是受本 view 创建的安全 DOM 节点（图标或外链）。
  const rows = [
    ['名称', basic.name],
    [iconTd, createIcon(basic)],
    ['ID', String(id)],
    ['TAG', basic.tagIds.map((tagId) => tagMap.get(tagId) || String(tagId)).join(', ')],
    detail.OSRequest?.length ? ['系统需求', formatOSRequest(detail.OSRequest)] : null,
  ].filter(Boolean);
  (detail.info || []).forEach((item) => rows.push([item.name, createInfoValue(item)]));

  const fragment = document.createDocumentFragment();
  rows.forEach(([name, value]) => {
    const row = document.createElement('tr');
    const nameCell = document.createElement('td');
    const valueCell = document.createElement('td');
    nameCell.textContent = name;
    if (name === iconTd) valueCell.style.lineHeight = '0'; // 消除图标下方的空白
    if (value instanceof Node) valueCell.appendChild(value);
    else valueCell.textContent = value;
    row.append(nameCell, valueCell);
    fragment.appendChild(row);
  });
  elements.body.replaceChildren(fragment);

  elements.isRandomSelect.textContent = detail.randomSelectMirror ? '是' : '否';
  renderMessages(elements.messageWrapper, elements.messageContainer, detail.message);
  renderMirrorInfo(elements.mirrorInfoBody, detail.download, mirrors);

  elements.download.href = `/html/down.html?id=${id}`;
  elements.intro.href = `/html/intro.html?id=${id}`;
  elements.history.href = `/html/rh.html?id=${id}`;
  // MDUI阴差阳错处理了<a>的禁用。
  elements.download.removeAttribute('disabled');
  elements.intro.removeAttribute('disabled');
  elements.history.removeAttribute('disabled');
}

/**
 * 创建详情内的惰性图标节点；尺寸固定可减少表格首次渲染的布局变化。
 * @param {object} basic 软件基础信息（含 icon、name）
 * @returns {HTMLImageElement} 图标元素
 */
function createIcon(basic) {
  const iconSize = Number(readPreference('fdn-detail-icon-size', '64'));
  const image = document.createElement('img');
  image.src = basic.icon || '/media/img/picMissing.webp';
  image.alt = basic.name;
  image.className = 'xf-detail-icon';
  image.width = iconSize;
  image.height = iconSize;
  image.loading = 'lazy';
  return image;
}

/**
 * 将 OSRequest 数组格式为 "系统 版本, 系统 版本, …" 文本。
 * @param {Array<{osName: string, osVersion?: string}>} requests
 * @returns {string}
 */
function formatOSRequest(requests) {
  return requests
    .map((r) => (r.osVersion ? `${r.osName} ${r.osVersion}` : r.osName))
    .join(', ');
}

/**
 * 创建收藏按钮。
 * @param {{id: number, name: string, icon?: string}} basic
 * @returns {HTMLAnchorElement}
 */
function createBookmarkButton(basic) {
  const btn = document.createElement('a');
  btn.className = 'mdui-btn mdui-btn-block mdui-btn-raised mdui-ripple';
  btn.href = 'javascript:void(0)';
  syncBookmarkButton(btn, basic);
  btn.addEventListener('click', () => {
    const nowBookmarked = toggleBookmark({ id: basic.id, name: basic.name, icon: basic.icon });
    syncBookmarkButton(btn, basic, nowBookmarked);
  });
  return btn;
}

/**
 * 同步按钮状态（图标 + 文本）。
 * @param {HTMLAnchorElement} btn
 * @param {{id: number, name: string, icon?: string}} basic
 * @param {boolean} [forcedState] 强制状态，不传则自动读取
 */
function syncBookmarkButton(btn, basic, forcedState) {
  const bookmarked = forcedState !== undefined ? forcedState : isBookmarked(basic.id);
  const icon = btn.querySelector('.mdui-icon') || document.createElement('i');
  icon.className = 'mdui-icon material-icons';
  icon.textContent = bookmarked ? 'bookmark' : 'bookmark_border';
  if (!btn.contains(icon)) btn.prepend(icon);
  btn.textContent = ''; // 清空后重新构建
  btn.appendChild(icon);
  btn.appendChild(document.createTextNode(bookmarked ? ' 取消收藏' : ' 加入收藏'));
}

/**
 * 将 detail.info 的一项转为纯文本或安全外链节点。
 * @param {{text?: string, href?: string}} item 信息项
 * @returns {string|HTMLAnchorElement} 文本或外链节点
 */
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
      urlCell.appendChild(createExternalLink(joinUrl(mirror.baseUrl, download.key)));
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