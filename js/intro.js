import { createIntroController } from './controllers/introController.js';
import { getSoftwareId, renderStatus, setErrorTitle } from './views/commonView.js';
import { t } from './common/i18n.js';

/**
 * 介绍页入口。container 初始显示 spinner，随后由 introView 替换为文档折叠面板；
 * 此处不会请求正文内容，也不会加载 Marked/DOMPurify。
 */
// 介绍页的正文懒加载逻辑位于 introController；入口仅负责一次性装配。
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('intro-content');
  const softwareId = getSoftwareId();
  if (softwareId === null) {
    setErrorTitle();
    renderStatus(container, 'error', { message: t('common.osNotSpecified') });
    return;
  }
  createIntroController(container, softwareId).load();
});
