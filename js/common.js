// 每页共用的入口脚本。新增共用 ES Module 请在此处 import。
import './common/logger.js';
import { logWarn } from './common/logger.js';
import { initI18n } from './common/i18n.js';
import './common/a11y.js';
import './common/theme.js';
import './common/drawer.js';
import './common/verWatermark.js';
import './common/sponsorRemind.js';

// 初始化 i18n：恢复语言偏好并在 DOM 就绪后应用翻译。
// 放在其他共用模块之前执行，保证动态渲染也能读取到正确的语言。
initI18n();

// 共用的第三方非 ES Module 脚本，通过动态创建 <script> 元素加载。
// 统计脚本：独立运行，不影响站点功能，无需前置加载。
(function () {
  const script = document.createElement('script');
  script.id = 'LA_COLLECT';
  script.src = '//sdk.51.la/js-sdk-pro.min.js';
  script.charset = 'UTF-8';
  document.head.appendChild(script);
  script.onload = function () {
    if (typeof LA !== 'undefined' && typeof LA.init === 'function') {
      LA.init({ id: '3Qf548Mk9X7m1VlP', ck: '3Qf548Mk9X7m1VlP' });
    } else {
      logWarn('统计脚本加载成功，但 LA 对象未定义');
    }
  };
  script.onerror = function () {
    logWarn('统计脚本加载失败');
  };
})();
