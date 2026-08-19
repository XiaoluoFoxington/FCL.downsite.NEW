import { createDetailController } from './controllers/detailController.js';
import { getSoftwareId } from './views/commonView.js';
import { renderDetailError } from './views/detailView.js';
import { t } from './common/i18n.js';

/**
 * 详情页入口。
 * elements 的键名与 detailView 约定：body 为 tbody，operations 为操作按钮区域，
 * download/intro/history 为会携带当前软件 ID 的三个入口。
 */
// 页面入口只收集 DOM 与 URL 参数；具体加载、校验和渲染分别交给 controller/view。
document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    body: document.getElementById('basic-info-body'),
    isAutoSelect: document.getElementById('is-auto-select'),
    mirrorInfoBody: document.getElementById('mirror-info-body'),
    operations: document.getElementById('operationTable'),
    download: document.getElementById('btn-download'),
    intro: document.getElementById('btn-intro'),
    history: document.getElementById('btn-history'),
    messageWrapper: document.getElementById('messageWrapper'),
    messageContainer: document.getElementById('messageContainer'),
  };
  const softwareId = getSoftwareId();
  // 入口处提前拒绝无效参数，避免 repository 访问不存在的 /data/software/NaN。
  if (softwareId === null) {
    renderDetailError(elements, new Error(t('common.osNotSpecified')));
    return;
  }
  createDetailController(elements, softwareId).load();
});
