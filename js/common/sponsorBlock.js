import { readPreference, writePreference } from '../domain/preferences.js';
import { getText } from '../http/client.js';
import { createSafeContent } from '../security/content.js';
import { logWarn } from './logger.js';
import { t } from './i18n.js';

/**
 * 下载后的赞助视图。
 * 与 sponsorRemind（按访问次数提醒）相互独立：本视图由“用指定线路下载”这一动作触发，
 * 在同一下载页内做视图切换——不弹窗、不跳转、不把下载地址写进 URL。
 */

/** 触发本视图的线路 id：0 即站长提供的线路1。按 id 判断，避免依赖会改名/翻译的线路名。 */
const SPONSOR_BLOCK_MIRROR_ID = 0;

/** 永久关闭本视图的偏好键（与 sponsorRemind 的键分开，互不影响）。 */
const SPONSOR_BLOCK_PERMANENT_DISABLED_KEY = 'fdn-sponsorBlockPermanentDisabled';

/** 模板路径。文案全部走 {{key}} 占位，由 i18n 在净化前替换。 */
const SPONSOR_BLOCK_TEMPLATE_URL = '/data/sponsorBlock.html';

/**
 * 判断某个下载项是否应触发赞助视图。
 * @param {object} item 统一下载叶子节点
 * @returns {boolean} 命中触发线路且未被永久关闭时为 true
 */
export function isSponsorBlockEligible(item) {
  if (item?.mirrorId !== SPONSOR_BLOCK_MIRROR_ID) return false;
  return readPreference(SPONSOR_BLOCK_PERMANENT_DISABLED_KEY, 'false') !== 'true';
}

/**
 * 创建赞助视图状态机。
 * 赞助视图与下载面板互斥显示：切换时隐藏下载面板而不卸载其 DOM，
 * 这样用户已选的线路、版本与筛选条件都能在返回后原样保留。
 * @param {{sponsorContainer: HTMLElement, downloadPanel: HTMLElement}} options 视图挂载点与被替换的面板
 * @returns {{show: (trigger?: HTMLElement|null) => Promise<void>, hide: () => void}}
 */
export function createSponsorBlockGate({ sponsorContainer, downloadPanel }) {
  let visible = false;
  let loading = false;
  let trigger = null;

  /**
   * 显示/隐藏下载面板。
   * hidden 负责不可见，inert 负责把被隐藏区域移出焦点顺序与无障碍树，二者缺一不可。
   * @param {boolean} hidden 是否隐藏下载面板
   */
  function setDownloadPanelHidden(hidden) {
    downloadPanel.hidden = hidden;
    downloadPanel.toggleAttribute('inert', hidden);
  }

  /** 退出赞助视图，恢复下载面板并把焦点归还给触发下载的链接。 */
  function hide() {
    if (!visible) return;
    visible = false;
    sponsorContainer.hidden = true;
    sponsorContainer.replaceChildren();
    setDownloadPanelHidden(false);
    trigger?.focus?.();
    trigger = null;
  }

  /**
   * 切换到赞助视图。
   * @param {HTMLElement|null} [sourceTrigger] 触发下载的链接，用于返回时归还焦点
   */
  async function show(sourceTrigger = null) {
    // 内容就绪前不切换：避免加载态闪一下又切回来的抖动。
    if (visible || loading) return;
    loading = true;
    try {
      const sponsorHtml = await getText(SPONSOR_BLOCK_TEMPLATE_URL, { cache: true });
      // 与 sponsorRemind 同理：{{key}} 必须在 DOMPurify 净化前替换，
      // 因为 createSafeContent 会剥离 data-* 属性，DOM 级翻译标记无法存活。
      const localizedHtml = sponsorHtml.replace(/\{\{([\w.]+)\}\}/g, (match, key) => t(key));
      sponsorContainer.className = 'mdui-panel-item mdui-panel-item-open xf-sponsorBlock';
      sponsorContainer.replaceChildren(await createSafeContent(localizedHtml));
      const backBtn = sponsorContainer.querySelector('#sponsorBlockBackBtn');
      const closeForeverBtn = sponsorContainer.querySelector('#sponsorBlockCloseForeverBtn');
      if (!backBtn || !closeForeverBtn) throw new Error(t('common.sponsorBlockTemplateMissing'));
      backBtn.addEventListener('click', hide);
      closeForeverBtn.addEventListener('click', () => {
        writePreference(SPONSOR_BLOCK_PERMANENT_DISABLED_KEY, 'true');
        hide();
      });
      trigger = sourceTrigger;
      sponsorContainer.hidden = false;
      setDownloadPanelHidden(true);
      visible = true;
      window.mdui?.mutation();
      // 视图已切换，把焦点移到新视图标题，键盘与读屏用户才能感知内容变化。
      const heading = sponsorContainer.querySelector('.mdui-panel-item-header');
      heading?.setAttribute('tabindex', '-1');
      heading?.focus();
    } catch (error) {
      // 赞助视图属于非必要内容：失败时保持下载页原样可用，只记录控制台日志，不弹 Toast 打扰。
      logWarn(error, t('logger.context.sponsorBlock'), { noToast: true });
      sponsorContainer.hidden = true;
      sponsorContainer.replaceChildren();
    } finally {
      loading = false;
    }
  }

  return { show, hide };
}