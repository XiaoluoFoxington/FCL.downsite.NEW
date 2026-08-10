import { detectSystemInfo, checkOSRequirement } from '../domain/systemInfo.js';
import { getMirrors, getSoftware } from '../repositories/siteRepository.js';
import { createDownloadSelectorController } from './downloadSelectorController.js';
import { renderStatus, renderMessages, setErrorTitle, setSoftwareHeader } from '../views/commonView.js';
import { joinUrl } from '../security/content.js';
import { logError } from '../common/logger.js';
import { t, tOr } from '../common/i18n.js';

/**
 * 下载页 controller。
 * elements.container：选择器和下载表格的唯一挂载点；
 * elements.stopButton：只取消当前外部请求链，不会离开当前页面；
 * softwareId：由 URL 校验后的整数 ID。
 */
export function createDownloadController(elements, softwareId) {
  let selectorController = null;

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
          notJoinRandom: download.notJoinRandom, // 这个傻逼地方害我找了一个小时，专门写这个注释吐槽一下。
        };
      });
      if (!mirrorItems.length) throw new Error(t('common.noMirrorInfo'));

      elements.container.replaceChildren();
      // 根层只有“当前软件”一个自动选项，下一层才是用户可切换的镜像线路。
      selectorController = createDownloadSelectorController({
        container: elements.container,
        stopButton: elements.stopButton,
        matchedArchitecture: system.matchedArchitecture,
        softwareName: basic.name,
        dataSource: [{ name: basic.name, nameIsSoftware: true, children: mirrorItems, random: detail.randomSelectMirror, notJoinRandom: detail.notJoinRandom, filter: detail.filter, description: detail.description }],
      });
      selectorController.start();
    } catch (error) {
      logError(error, '下载页初始化');
      setErrorTitle();
      if (elements.messageWrapper) elements.messageWrapper.hidden = true;
      renderStatus(elements.container, 'error', { message: error.message, onRetry: load });
    }
  }
  return { load };
}
