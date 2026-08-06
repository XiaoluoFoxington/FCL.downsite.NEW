import { createDownloadController } from './controllers/downloadController.js';
import { getSoftwareId, renderStatus, setErrorTitle } from './views/commonView.js';

/**
 * 下载页入口。
 * container 由 selector view 逐级填充；stopButton 仅作用于正在进行的当前选择链；
 * detailButton 会由公共 header helper 补上 ?id= 参数。
 */
// 下载页入口不直接访问镜像 API；它只把页面元素交给专用 controller。
document.addEventListener('DOMContentLoaded', () => {
  const elements = {
    container: document.getElementById('selectors'),
    stopButton: document.getElementById('forceStopLoadBtn'),
    detailButton: document.getElementById('detailBtn'),
    messageWrapper: document.getElementById('messageWrapper'),
    messageContainer: document.getElementById('messageContainer'),
  };
  const softwareId = getSoftwareId();
  // 无效 ID 时保留页面框架并显示可读错误，而非让模块初始化异常中断。
  if (softwareId === null) {
    setErrorTitle();
    renderStatus(elements.container, 'error', { message: '未指定有效的软件 ID' });
    return;
  }
  createDownloadController(elements, softwareId).load();
});
