import { incrementVisitCount } from '../domain/siteInfo.js';
import { readPreference, writePreference } from '../domain/preferences.js';
import { createPanel } from '../views/uiComponents.js';
import { getText } from '../http/client.js';
import { createSafeContent } from '../security/content.js';
import { renderStatus } from '../views/commonView.js';
import { t } from './i18n.js';

/**
 * 赞助提醒，用于在访问次数达到10的倍数时显示赞助提醒
 */

const SPONSOR_REMIND_PERMANENT_DISABLED_KEY = 'fdn-sponsorRemindPermanentDisabled';

document.addEventListener('DOMContentLoaded', async () => {
  await showSponsorRemindIfAllow(document.getElementById('sponsorRemindContainer'));
  window.mdui?.mutation();
});

/**
 * 是否允许显示赞助提醒，条件如下：
 * - 访问次数必须是10的倍数
 * - 没有设置永久关闭
 * @returns {object} 是否允许显示赞助提醒和当前访问次数
 * @property {boolean} allowShow 是否允许显示赞助提醒
 * @property {number} visitCount 当前访问次数
 */
function allowShowSponsorRemind() {
  const visitCount = incrementVisitCount();
  const isPermanentDisabled = readPreference(SPONSOR_REMIND_PERMANENT_DISABLED_KEY, 'false') === 'true';
  return {
    allowShow: visitCount % 10 === 0 && !isPermanentDisabled,
    visitCount
  };
}

/**
 * 判断并显示赞助提醒
 * @param {HTMLElement} container 容器元素
 * 
 */
async function showSponsorRemindIfAllow(container) {
  if (!container) return; // 没有容器时避免增加访问次数
  const { allowShow, visitCount } = allowShowSponsorRemind();
  if (!allowShow) return;
  await showSponsorRemind(container, visitCount);
}

/**
 * 显示赞助提醒
 * @param {HTMLElement} container 容器元素
 * @param {number} visitCount 当前访问次数
 */
async function showSponsorRemind(container, visitCount) {
  renderStatus(container, 'loading', { message: t('common.loadingSponsorRemind') });
  try {
    container.className = 'mdui-panel-item mdui-panel-item-open xf-sponsorRemind';
    const sponsorHtml = await getText('/data/sponsorRemind.html', { cache: true });
    // 模板用 {{key}} 标记文案，必须在 DOMPurify 净化前完成翻译：
    // createSafeContent 配置会剥离 data-* 属性，DOM 级翻译标记无法存活。
    // {count} 只替换访问次数文案里的占位符，避免误伤模板中其他字面 {count}。
    const visitCountHtml = t('sponsorRemind.visitCount').replace(/\{count\}/g, '<span id="visitCount"></span>');
    const localizedHtml = sponsorHtml
      .replace(/\{\{sponsorRemind\.visitCount\}\}/g, () => visitCountHtml)
      .replace(/\{\{([\w.]+)\}\}/g, (match, key) => t(key));
    // 注意：不能在此处对整段 HTML 再做 .replace(/\{count\}/g, '')——
    // 那会把其他已替换翻译中合法的 {count} 字面量也一并删掉。
    // 访问次数占位符已在 visitCountHtml 构造时处理完毕，模板本身不含 {count}。
    container.replaceChildren(await createSafeContent(localizedHtml));
    const visitCountEl = container.querySelector('#visitCount');
    const closeBtn = container.querySelector('#sponsorRemindCloseBtn');
    if (!visitCountEl || !closeBtn) {
      throw new Error(t('common.sponsorRemindTemplateMissing'));
    }
    visitCountEl.textContent = visitCount;
    closeBtn.addEventListener('click', () => {
      disableSponsorRemind(container);
    });
  } catch (error) {
    renderStatus(container, 'error', { message: error.message, onRetry: () => showSponsorRemind(container, visitCount) });
  }
}

/**
 * 永久关闭赞助提醒
 * @param {HTMLElement} sponsorRemindElement 赞助提醒元素
 */
function disableSponsorRemind(sponsorRemindElement) {
  writePreference(SPONSOR_REMIND_PERMANENT_DISABLED_KEY, 'true');
  sponsorRemindElement?.remove();
}
