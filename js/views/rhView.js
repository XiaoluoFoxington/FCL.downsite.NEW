import { formatBytes, renderStatus, setErrorTitle, setSoftwareHeader } from './commonView.js';
import { createSafeContent } from '../security/content.js';
import { createPanel, createPanelItem, createTypoContainer, createFluidTable, createExternalLink } from './uiComponents.js';

/** 版本历史首屏加载状态。 */
export function renderRhLoading(container) {
  renderStatus(container, 'loading', { message: '正在加载版本历史……' });
}

/** 版本历史加载失败。 */
export function renderRhError(container, error, onRetry) {
  setErrorTitle();
  renderStatus(container, 'error', { message: error.message, onRetry });
}

/**
 * 渲染所有 Release 折叠面板。
 * @param {HTMLElement} container 挂载容器
 * @param {object} basic 软件目录项
 * @param {Array} releases GitHub API 返回的 Release 数组
 */
export async function renderReleases(container, basic, releases) {
  setSoftwareHeader(basic, {
    titlePrefix: '版本历史 - ',
    detailButton: document.getElementById('detailBtn'),
  });

  if (!releases.length) {
    renderStatus(container, 'empty', { message: '暂无版本记录' });
    return;
  }

  container.replaceChildren();

  const panel = createPanel();

  // 使用 DocumentFragment 批量处理 DOM 操作
  const fragment = document.createDocumentFragment();

  // 表头
  fragment.appendChild(createHeaderItem());

  for (let index = 0; index < releases.length; index++) {
    const release = releases[index];
    const summaryTexts = [
      release.tag_name,
      (() => { try { return new Date(release.published_at).toLocaleString(); } catch (_) { return release.published_at || ''; } })(),
    ];
    const { element: panelItem, body } = createPanelItem(
      release.name || '未命名版本',
      { isOpen: index === 0, summary: summaryTexts },
    );

    // 子面板
    const subPanel = createPanel();

    // 内容子面板项
    const contentPanel = createContentSection(release.body);
    subPanel.appendChild(contentPanel);

    // 资源子面板项
    const assetsPanel = createAssetsSection(release.assets);
    subPanel.appendChild(assetsPanel);

    body.appendChild(subPanel);

    fragment.appendChild(panelItem);
  }

  panel.appendChild(fragment);
  container.appendChild(panel);
  window.mdui?.mutation();
}

/** 创建表头面板项：版本名称 / 版本Tag / 发布时间。 */
function createHeaderItem() {
  const { element: headerItem, body } = createPanelItem('版本名称', {
    summary: ['版本Tag', '发布时间'],
    bodyClass: 'mdui-typo',
  });
  const hint = document.createElement('p');
  hint.className = 'mdui-typo';
  hint.textContent = '我是表头呐~';
  body.appendChild(hint);
  return headerItem;
}

/** 创建 Release 正文的折叠子面板。 */
function createContentSection(body) {
  const { element: panelItem, body: bodyContainer } = createPanelItem('内容', { isOpen: true });

  // 先显示加载状态，再异步渲染 Markdown
  const contentDiv = createTypoContainer();
  renderStatus(contentDiv, 'loading', { message: '正在渲染正文……' });
  bodyContainer.appendChild(contentDiv);

  // 异步渲染 Markdown 正文
  renderReleaseBody(contentDiv, body);

  return panelItem;
}

/** 异步渲染 Release 正文。 */
async function renderReleaseBody(container, body) {
  try {
    const fragment = await createSafeContent(body || '无发布说明', { type: 'md' });
    // 容器可能已被移除（用户关闭/折叠面板或离开页面），避免更新游离 DOM。
    if (container.isConnected) container.replaceChildren(fragment);
  } catch (error) {
    console.error('Release 正文渲染失败', error);
    if (!container.isConnected) return;
    renderStatus(container, 'error', {
      message: `正文渲染失败：${error.message}`,
      onRetry: () => renderReleaseBody(container, body),
    });
  }
}

/** 创建资源列表的折叠子面板。 */
function createAssetsSection(assets) {
  const { element: panelItem, body: bodyContainer } = createPanelItem(`资源（${assets.length}）`);

  if (assets.length === 0) {
    const emptyDiv = createTypoContainer();
    emptyDiv.textContent = '无资源';
    bodyContainer.appendChild(emptyDiv);
  } else {
    // 资源列表改为面板嵌套
    const innerPanel = createPanel();

    const fragment = document.createDocumentFragment();
    assets.forEach((asset) => {
      fragment.appendChild(createAssetPanel(asset));
    });
    fragment.appendChild(createSummaryPanel(assets));
    innerPanel.appendChild(fragment);
    bodyContainer.appendChild(innerPanel);
  }

  return panelItem;
}

/** 创建单个资源的面板项，内容以表格展示。 */
function createAssetPanel(asset) {
  const { element: panelItem, body } = createPanelItem(asset.name, { bodyClass: 'mdui-typo' });

  const { wrapper } = createFluidTable();
  const tbody = wrapper.querySelector('tbody');
  addTableRow(tbody, '大小', formatBytes(asset.size));
  addTableRow(tbody, 'GH下载URL', asset.browser_download_url, asset.browser_download_url);

  body.appendChild(wrapper);
  return panelItem;
}

/** 创建合计面板项，内容以表格展示。 */
function createSummaryPanel(assets) {
  const totalSize = assets.reduce((sum, asset) => sum + (asset.size || 0), 0);
  const allUrls = assets.map((asset) => asset.browser_download_url).filter(Boolean);

  const { element: panelItem, body } = createPanelItem('合计');

  const { wrapper } = createFluidTable();
  const tbody = wrapper.querySelector('tbody');
  addTableRow(tbody, '总大小', formatBytes(totalSize));
  addTableRow(tbody, '所有下载URL', allUrls.join('\n'));

  body.appendChild(wrapper);
  return panelItem;
}

/** 向表格 tbody 添加一行。label 为文本，value 为纯文本或链接文本，href 可选。
 *  value 中的换行符 `\n` 会转为 `<br>`，让多个 URL 在同一段落内换行显示。
 */
function addTableRow(tbody, label, value, href) {
  const row = document.createElement('tr');
  const labelCell = document.createElement('td');
  labelCell.textContent = label;
  const valueCell = document.createElement('td');
  if (href) {
    valueCell.appendChild(createExternalLink(href, value));
  } else {
    const p = document.createElement('p');
    const lines = String(value).split('\n');
    lines.forEach((line, i) => {
      if (i > 0) p.appendChild(document.createElement('br'));
      p.appendChild(document.createTextNode(line));
    });
    valueCell.appendChild(p);
  }
  row.append(labelCell, valueCell);
  tbody.appendChild(row);
}