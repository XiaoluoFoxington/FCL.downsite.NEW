import { createRhController } from './controllers/rhController.js';
import { getSoftwareId, renderStatus, setErrorTitle } from './views/commonView.js';
import { t } from './common/i18n.js';

/**
 * 版本历史页入口。
 * container 由 rhView 渲染为 MDUI 折叠面板，首次加载显示 spinner。
 */
document.addEventListener('DOMContentLoaded', () => {
  const container = document.getElementById('rh-container');
  const softwareId = getSoftwareId();

  if (softwareId === null) {
    setErrorTitle();
    renderStatus(container, 'error', { message: t('common.osNotSpecified') });
    return;
  }

  createRhController(container, softwareId).load();
});
