import { renderStatus, renderTableStatus } from './commonView.js';
import { createPanelItem, createExternalLink } from './uiComponents.js';
import { t, tOr } from '../common/i18n.js';

/**
 * 关于页面 view。
 * 负责渲染下载线路对照表、网站开发贡献者列表、使用的开源项目三个区域。
 */

/**
 * 渲染加载状态。
 * 若容器为 <tbody>，使用 renderTableStatus 正确生成表格行；否则使用通用 renderStatus。
 * @param {HTMLElement} container 挂载容器
 * @param {number} [colspan] 当容器为 tbody 时，状态行的 colspan 值
 */
export function renderAboutLoading(container, colspan) {
  if (container.tagName === 'TBODY') {
    renderTableStatus(container, colspan || 2, 'loading', t('common.loading'));
  } else {
    renderStatus(container, 'loading', { message: t('common.loading') });
  }
}

/**
 * 渲染错误状态。
 * 若容器为 <tbody>，使用 renderTableStatus 正确生成表格行；否则使用通用 renderStatus。
 * @param {HTMLElement} container 挂载容器
 * @param {Error} error 错误对象
 * @param {Function} onRetry 重试回调
 * @param {number} [colspan] 当容器为 tbody 时，状态行的 colspan 值
 */
export function renderAboutError(container, error, onRetry, colspan) {
  if (container.tagName === 'TBODY') {
    renderTableStatus(container, colspan || 2, 'error', error.message, onRetry);
  } else {
    renderStatus(container, 'error', { message: error.message, onRetry });
  }
}

/**
 * 渲染下载线路对照表。
 * @param {HTMLElement} container tbody 容器
 * @param {Array<object>} mirrors 线路数据，来自 mirror.json
 * @param {Array<object>} contributors 贡献者数据，来自 contribute.json
 */
export function renderDownloadLines(container, mirrors, contributors) {
  const contributorMap = new Map();
  contributors.forEach((c) => contributorMap.set(c.id, c));

  const fragment = document.createDocumentFragment();
  mirrors.forEach((mirror) => {
    const tr = document.createElement('tr');
    const tdName = document.createElement('td');
    tdName.textContent = tOr(`mirror.${mirror.id}`, mirror.name);
    const tdProvider = document.createElement('td');

    const ids = mirror.contributeId || [];
    if (ids.length === 0) {
      tdProvider.textContent = t('common.unknown');
    } else {
      ids.forEach((id, index) => {
        if (index > 0) tdProvider.appendChild(document.createTextNode(t('common.separator')));
        const c = contributorMap.get(id);
        const name = c ? (c.accentName || c.name) : `contributorID-${id}`;
        const a = document.createElement('a');
        a.href = '#' + name;
        a.textContent = name;
        tdProvider.appendChild(a);
      });
    }

    tr.append(tdName, tdProvider);
    fragment.appendChild(tr);
  });
  // 全部节点均由 DOM API 安全构建（textContent / 受控属性），无需再过 DOMPurify。
  container.replaceChildren(fragment);
}

/**
 * 渲染网站开发贡献者列表。
 * @param {HTMLElement} container MDUI 面板容器
 * @param {Array<object>} contributors 贡献者数据
 * @param {Array<object>} mirrors 线路数据
 */
export async function renderContributors(container, contributors, mirrors) {
  const fragment = document.createDocumentFragment();

  // 构建 贡献者ID → 线路名列表 的映射
  const contributorMirrors = new Map();
  mirrors.forEach((m) => {
    (m.contributeId || []).forEach((cid) => {
      if (!contributorMirrors.has(cid)) contributorMirrors.set(cid, []);
      contributorMirrors.get(cid).push(tOr(`mirror.${m.id}`, m.name));
    });
  });

  contributors.forEach((c) => {
    const { element: panelItem, header, body } = createPanelItem(c.accentName || c.name, {
      isOpen: true,
      bodyClass: 'mdui-container-fluid',
    });
    header.id = c.accentName || c.name || `contributorID-${c.id}`;

    const row = document.createElement('div');
    row.className = 'mdui-row';

    // 左侧：头像卡片 + 链接按钮
    const leftCol = document.createElement('div');
    leftCol.className = 'mdui-col-xs-12 mdui-col-sm-4';

    const card = document.createElement('div');
    card.className = 'mdui-card';

    const media = document.createElement('div');
    media.className = 'mdui-card-media';

    const img = document.createElement('img');
    img.src = c.avatar || '/media/img/picMissing.webp';
    img.alt = c.accentName || c.name || '';
    img.loading = 'lazy';

    const covered = document.createElement('div');
    covered.className = 'mdui-card-media-covered';

    const primary = document.createElement('div');
    primary.className = 'mdui-card-primary';

    const primaryTitle = document.createElement('div');
    primaryTitle.className = 'mdui-card-primary-title';
    primaryTitle.textContent = c.accentName || c.name;

    const primarySubtitle = document.createElement('div');
    primarySubtitle.className = 'mdui-card-primary-subtitle';
    primarySubtitle.textContent = c.name;

    primary.append(primaryTitle, primarySubtitle);
    covered.appendChild(primary);
    media.append(img, covered);
    card.appendChild(media);

    // 链接按钮
    const linkContainer = document.createElement('div');
    if (c.link && c.link.length > 0) {
      c.link.forEach((link) => {
        linkContainer.appendChild(createExternalLink(link.href, link.name, {
          className: 'mdui-btn mdui-btn-block mdui-btn-raised mdui-ripple',
        }));
      });
    }

    leftCol.append(card, linkContainer);

    // 右侧：贡献描述
    const rightCol = document.createElement('div');
    rightCol.className = 'mdui-typo mdui-col-xs-12 mdui-col-sm-8';

    const ul = document.createElement('ul');

    // content 字段按数组拆分为多条贡献描述
    if (c.content) {
      const lines = c.content.filter((line) => line.trim());
      lines.forEach((line, lineIndex) => {
        const li = document.createElement('li');
        li.textContent = tOr(`about.contributor.${c.id}.${lineIndex}`, line.trim());
        ul.appendChild(li);
      });
    }

    // 提及该贡献者提供的线路
    const mirrorNames = contributorMirrors.get(c.id);
    if (mirrorNames && mirrorNames.length > 0) {
      const li = document.createElement('li');
      li.textContent = t('about.projects.providedMirrors', { mirrors: mirrorNames.join(t('common.separator')) });
      ul.appendChild(li);
    }

    if (ul.children.length > 0) {
      rightCol.appendChild(ul);
    }

    row.append(leftCol, rightCol);
    body.appendChild(row);
    panelItem.append(header, body);
    fragment.appendChild(panelItem);
  });

  // 全部节点均由 DOM API 安全构建（textContent / 受控 createExternalLink），无需再过 DOMPurify。
  container.replaceChildren(fragment);
  window.mdui?.mutation();
}

/**
 * 渲染使用的开源项目表格。
 * @param {HTMLElement} container tbody 容器
 * @param {Array<object>} projects 开源项目数据，来自 usedProj.json
 */
export async function renderUsedProjects(container, projects) {
  const fragment = document.createDocumentFragment();

  projects.forEach((p, index) => {
    const tr = document.createElement('tr');

    const tdName = document.createElement('td');
    tdName.textContent = p.name;

    const tdDesc = document.createElement('td');
    tdDesc.textContent = tOr(`about.project.${index}.description`, p.description);

    const tdUseDesc = document.createElement('td');
    tdUseDesc.textContent = tOr(`about.project.${index}.useDescription`, p.useDescription);

    const tdVersion = document.createElement('td');
    tdVersion.textContent = p.useVersion;

    const tdLink = document.createElement('td');
    tdLink.appendChild(createExternalLink(p.link, p.link));

    const tdLicense = document.createElement('td');
    if (p.licenseLink) {
      tdLicense.appendChild(createExternalLink(p.licenseLink, p.license));
    } else {
      tdLicense.textContent = p.license;
    }

    tr.append(tdName, tdDesc, tdUseDesc, tdVersion, tdLink, tdLicense);
    fragment.appendChild(tr);
  });

  // 全部节点均由 DOM API 安全构建（textContent / 受控 createExternalLink），无需再过 DOMPurify。
  container.replaceChildren(fragment);
}
