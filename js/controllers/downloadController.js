import { detectSystemInfo, checkOSRequirement, getSystemDownloadExtensions } from '../domain/systemInfo.js';
import { selectAutoDefault } from '../domain/autoSelect.js';
import { getMirrors, getSoftware } from '../repositories/siteRepository.js';
import { createDownloadSelectorController } from './downloadSelectorController.js';
import { createSponsorBlockGate, isSponsorBlockEligible } from '../common/sponsorBlock.js';
import { renderStatus, renderMessages, setErrorTitle, setSoftwareHeader } from '../views/commonView.js';
import { joinUrl } from '../security/content.js';
import { logError } from '../common/logger.js';
import { t, tOr } from '../common/i18n.js';

/**
 * 下载页 controller。
 * elements.container：选择器和下载表格的唯一挂载点；
 * elements.stopButton：只取消当前外部请求链，不会离开当前页面；
 * elements.sponsorBlockContainer / elements.downloadPanel：下载后赞助视图的挂载点与要暂时隐藏的面板；
 * softwareId：由 URL 校验后的整数 ID。
 */
export function createDownloadController(elements, softwareId) {
  let selectorController = null;
  // 缺少任一元素时整体降级为“不拦截”，下载行为不受影响。
  const sponsorBlock = elements.sponsorBlockContainer && elements.downloadPanel
    ? createSponsorBlockGate({
      sponsorContainer: elements.sponsorBlockContainer,
      downloadPanel: elements.downloadPanel,
    })
    : null;

  /**
   * 下载按钮点击回调。
   * 故意不调用 preventDefault：下载链接是 target="_blank"，让新标签照常开始下载，
   * 当前页再切换到赞助视图，两件事互不阻塞。
   * @param {object} item 统一下载叶子节点
   * @param {Event} [event] 点击事件，currentTarget 为下载链接，用于视图返回时归还焦点
   */
  function handleDownload(item, event) {
    if (!sponsorBlock || !isSponsorBlockEligible(item)) return;
    sponsorBlock.show(event?.currentTarget || null);
  }

  async function load() {
    // 点击重试前先终止旧选择器并解除其按钮监听，避免旧请求回写 DOM、监听器随重试累积。
    selectorController?.dispose();
    selectorController?.abort();
    renderStatus(elements.container, 'loading', { message: t('down.loadingMirrors') });
    if (elements.messageWrapper) elements.messageWrapper.hidden = true;
    try {
      // 本站静态元数据与 UA 识别互不依赖，应并行完成以缩短下载页首屏时间。
      const [{ basic, detail }, mirrors, system] = await Promise.all([
        getSoftware(softwareId),
        getMirrors(),
        Promise.resolve().then(detectSystemInfo),
      ]);
      setSoftwareHeader(basic, {
        titlePrefix: t('down.title'),
        detailButton: elements.detailButton,
      });
      renderMessages(elements.messageWrapper, elements.messageContainer, [
        ...(detail.message || []).map((msg, index) => ({
          ...msg,
          text: tOr(`detailMessage.${softwareId}.${index}`, msg.text),
        })),
        ...checkOSRequirement(detail.OSRequest, system),
      ]);
      // 通过 ID 建索引，既减少查找复杂度，也能明确检测 detail.json 中的错误 mirrorId。
      const mirrorMap = new Map(mirrors.map((mirror) => [mirror.id, mirror]));
      // detail.download 项结构为 { mirrorId, key }：mirrorId 查配置，key 拼接到镜像 baseUrl 后请求。
      const mirrorItems = (detail.download || []).map((download) => {
        const mirror = mirrorMap.get(download.mirrorId);
        if (!mirror) throw new Error(t('detail.missingMirror', { id: download.mirrorId }));
        return {
          // name/sourceName 用于 UI 与最终统一下载项中的 source 字段。
          name: tOr(`mirror.${mirror.id}`, mirror.name),
          sourceName: mirror.name,
          nextUrl: joinUrl(mirror.baseUrl, download.key),
          // apiVer 为空时走 plain adapter，允许旧镜像逐步迁移。
          apiVersion: mirror.apiVer,
          notJoinRandom: mirror.notJoinRandom, // 是否参与随机选择由 mirror.json 统一管理。
          // mirrorId 会经 adapter 注册表标记到下载叶子上，供下载后的赞助视图识别线路。
          mirrorId: mirror.id,
          // 线路描述（data/mirror.json 的 description），由 selector 渲染在选择框下方；按线路 id 翻译。
          description: tOr(`mirrorDescription.${mirror.id}`, mirror.description),
        };
      });
      if (!mirrorItems.length) throw new Error(t('common.noMirrorInfo'));
      // 存在多条线路时自动进入自动选择：由 domain 模块挑选默认线路，selector 只负责渲染。
      const autoMirrorItems = mirrorItems.length > 1 ? selectAutoDefault(mirrorItems) : mirrorItems;

      elements.container.replaceChildren();
      // 根层只有“当前软件”一个自动选项，下一层才是用户可切换的镜像线路。
      selectorController = createDownloadSelectorController({
        container: elements.container,
        stopButton: elements.stopButton,
        matchedArchitecture: system.matchedArchitecture,
        // 系统自动筛选：根据当前系统生成安装包扩展名白名单，供筛选面板的"当前系统"类别使用。
        osExtensions: getSystemDownloadExtensions(system?.fullResult?.os?.name),
        // 系统显示名用于筛选面板的类别标签，如"当前系统（Windows）筛选条件（…）"。
        osName: system?.fullResult?.os?.name || '',
        softwareName: basic.name,
        dataSource: [{ name: basic.name, nameIsSoftware: true, children: autoMirrorItems, filter: detail.filter, description: detail.description }],
        // 下载按钮点击后由本 controller 决定是否切换到赞助视图。
        onDownload: handleDownload,
      });
      selectorController.start();
    } catch (error) {
      logError(error, t('logger.context.downloadPageInit'));
      setErrorTitle();
      if (elements.messageWrapper) elements.messageWrapper.hidden = true;
      renderStatus(elements.container, 'error', { message: error.message, onRetry: load });
    }
  }
  return { load };
}
