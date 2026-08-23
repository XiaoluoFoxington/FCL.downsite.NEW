import { adaptDownloadData } from '../adapters/download/index.js';
import { loadDescription, loadDownloadNodes } from '../repositories/downloadRepository.js';
import { createSafeContent } from '../security/content.js';
import { createSelectorView } from '../views/selectorView.js';
import { logError } from '../common/logger.js';
import { t } from '../common/i18n.js';

/**
 * 判断节点数组是否已到达叶子层级。
 * 只要还有 children、items 或 nextUrl，就应继续渲染下一级选择框。
 * @param {Array<object>} items 待判断的节点数组
 * @returns {boolean} 是否为最终下载表格层级
 */
function isBottomLevel(items) {
  // 只要还有 children、items 或 nextUrl，就应继续渲染下一级选择框；否则进入最终下载表格。
  return !items.some((item) =>
    (Array.isArray(item.children) && item.children.length)
    || item.nextUrl
    || (Array.isArray(item.items) && item.items.length));
}

/**
 * @param {object} options
 * @param {HTMLElement} options.container 选择器的挂载点
 * @param {HTMLElement|null} options.stopButton 终止当前链路的按钮
 * @param {Array<object>} options.dataSource 根级选择数据
 * @param {string} [options.osName] 当前系统显示名（用于筛选面板类别标签）
 * @returns {{start: () => void, abort: () => void}}
 */
export function createDownloadSelectorController(options) {
  /**
   * 选择器的状态机：一次“选择”拥有独立 AbortController 和递增序号。
   * 即使某些上游服务忽略 abort 后仍返回数据，序号也会阻止旧响应覆盖新选择。
   */
  const view = createSelectorView(options.container, options.stopButton, options.matchedArchitecture, options.osExtensions, options.osName);
  let activeController = null;
  let requestSequence = 0;
  let softwareName = options.softwareName;

  function isCurrent(sequence) {
    // 同时校验序号和 signal，覆盖“新请求已经开始”与“用户手动终止”两种过期情形。
    return sequence === requestSequence && !activeController?.signal.aborted;
  }

/**
 * 渲染选择器选项的描述区域。
 * 支持纯文本和 HTML 富文本两种格式，通过净化后安全插入 DOM。
 * @param {object} item 当前选中项
 * @param {HTMLElement} container 描述容器
 * @param {AbortSignal} signal 取消信号
 * @param {number} sequence 请求序号，用于防止过期响应回写
 * @returns {Promise<void>}
 */
  async function renderDescription(item, container, signal, sequence) {
    if (!item.description && !item.descriptionUrl) {
      container.replaceChildren();
      return;
    }
    try {
      // 描述和下一级数据并行加载；描述失败不能阻止用户继续看到下载项。
      const content = item.descriptionUrl
        ? await loadDescription(item.descriptionUrl, signal)
        : item.description;
      if (!isCurrent(sequence)) return;
      // 只有数据明确标记为 html 才会走净化后的富文本渲染，默认严格按文本显示。
      if (item.descriptionFormat === 'html') {
        const fragment = await createSafeContent(content, { type: 'html', baseUrl: item.descriptionUrl });
        if (isCurrent(sequence)) container.replaceChildren(fragment);
      } else {
        container.textContent = content;
      }
    } catch (error) {
      if (error.kind !== 'abort' && isCurrent(sequence)) {
        container.textContent = t('common.selectors.descLoadFailed', { message: error.message });
      }
    }
  }

/**
 * 内联 children 归一化处理。
 * 若声明了 apiVersion 则通过适配器转换；自动选择默认线路由上层
 * （downloadController 对多线路调用 selectAutoDefault）预先标记好，
 * 这里只负责结构转换，不再自行挑选默认项。
 * @param {object} item 含 children/items 的节点
 * @returns {Array<object>} 归一化后的子节点
 */
  function normalizeInlineChildren(item) {
    // 内联 children 常用于本站配置；仍可声明 apiVersion 以复用某条线路的纯适配器。
    let children = item.children || item.items || [];
    if (item.apiVersion) {
      children = adaptDownloadData(children, item.apiVersion, { source: item.sourceName || item.name });
    }
    return children;
  }

/**
 * 解析选择项并获取下一级节点。
 * 根据 item 的类型决定是请求外部 API、使用内联 children，还是直接作为叶子节点。
 * @param {object} item 当前选中项
 * @param {number} nextLevel 下一级层级索引
 * @param {Array<string>} inheritedFilter 继承的 URL 正则白名单
 * @param {AbortSignal} signal 取消信号
 * @param {number} sequence 请求序号
 * @returns {Promise<void>}
 */
  async function resolveSelection(item, nextLevel, inheritedFilter, signal, sequence) {
    // 子级未声明 filter 时继承父级，子级声明后覆盖父级规则。
    const nextFilter = item.filter !== undefined ? item.filter : inheritedFilter;
    let nodes;
    // nextUrl 是惰性边界：只有用户选中该线路才访问外部镜像 API。
    if (item.nextUrl || (item.apiVersion && !item.children && !item.items)) {
      nodes = await loadDownloadNodes({
        url: item.nextUrl,
        apiVersion: item.apiVersion,
        softwareName,
        sourceName: item.sourceName || item.name,
        signal,
      });
    } else if (item.children || item.items) {
      nodes = normalizeInlineChildren(item);
    } else if (item.downloadUrl) {
      nodes = [item];
    } else {
      nodes = [];
    }
    // 外部请求完成后再次检查，绝不能把上一次选择的表格写回当前页面。
    if (!isCurrent(sequence)) return;
    renderNodes(nodes, nextLevel, nextFilter);
  }

/**
 * 处理用户选择项，加载描述和下一级节点。
 * 每次选择都会取消旧请求链，防止快速切换时出现竞态。
 * @param {object} item 选中的选项
 * @param {number} level 当前层级索引
 * @param {HTMLElement} description 描述显示容器
 * @param {Array<string>} inheritedFilter 继承的 URL 正则白名单
 * @returns {Promise<void>}
 */
  async function selectItem(item, level, description, inheritedFilter) {
    options.container.querySelector('.xf-cancel-notice')?.remove();
    // 新选择立即取消旧选择链，防止快速切换镜像时出现竞态与无用流量。
    activeController?.abort();
    activeController = new AbortController();
    const sequence = ++requestSequence;
    view.clearFrom(level + 1);
    view.setBusy(true);
    if (item.nameIsSoftware) softwareName = item.name;

    // 重试复用完全相同的选择上下文，但会取得新的序号和 AbortController。
    const retry = () => selectItem(item, level, description, inheritedFilter);
    try {
      // 描述不依赖下级节点，两者并行可避免用户等待两段串行网络延迟。
      await Promise.all([
        renderDescription(item, description, activeController.signal, sequence),
        resolveSelection(item, level + 1, inheritedFilter, activeController.signal, sequence),
      ]);
    } catch (error) {
      if (error.kind !== 'abort' && isCurrent(sequence)) {
        logError(error, '下载选项');
        view.renderError(level + 1, error, retry);
      }
    } finally {
      if (isCurrent(sequence)) view.setBusy(false);
    }
  }

/**
 * 根据节点类型决定渲染选择框或下载表格。
 * @param {Array<object>} nodes 已归一化的节点数组
 * @param {number} level 当前层级索引
 * @param {Array<string>} inheritedFilter 继承的 URL 正则白名单
 */
  function renderNodes(items, level, inheritedFilter) {
    if (!Array.isArray(items)) {
      view.renderError(level, new Error(t('common.selectors.mirrorDataInvalid')));
      return;
    }
    // view 只接收已归一化的节点；这里决定它应显示选择框还是最终下载表格。
    if (isBottomLevel(items)) {
      view.renderDownloads(items, level, inheritedFilter, options.onDownload);
      return;
    }
    // view 将“用户在第几级选中了什么”回调回来；controller 是唯一会发请求的层。
    view.renderSelect(items, level, (item, description) => {
      selectItem(item, level, description, inheritedFilter);
    });
  }

  function start() {
    // 根节点渲染后 view 会自动选择默认项，从而保留“打开下载页自动加载默认线路”的体验。
    renderNodes(options.dataSource, 0);
  }

  function abort() {
    // 先增加序号再取消，确保任何已在事件队列中的旧响应也立即失效。
    requestSequence += 1;
    activeController?.abort();
    activeController = null;
    view.setBusy(false);
    const notice = document.createElement('p');
    notice.className = 'xf-status xf-status-idle xf-cancel-notice';
    notice.textContent = t('common.selectors.loadStopped');
    options.container.appendChild(notice);
  }

  // 终止按钮由 view 的 busy 状态显示/隐藏，controller 只维护实际取消语义。
  const handleStopClick = () => abort();
  options.stopButton?.addEventListener('click', handleStopClick);
  return {
    abort,
    start,
    // 新 controller 接管前调用，解除旧监听，避免重试后同一按钮上监听器越积越多。
    dispose() {
      options.stopButton?.removeEventListener('click', handleStopClick);
    },
  };
}
