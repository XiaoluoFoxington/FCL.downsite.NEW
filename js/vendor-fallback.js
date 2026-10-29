/**
 * 第三方 CDN 依赖的本地回退。
 *
 * 本文件以普通 <script>（非 module）同步加载在所有页面 <head> 的最前面，
 * 通过捕获阶段监听资源加载失败的 error 事件（资源 error 不冒泡，只能在捕获阶段拿到），
 * 命中映射表时把地址换成仓库内 vendor/ 下的固定版本副本，保证 CDN 不可达时站点仍能正常显示与运行。
 *
 * 覆盖页面里直接出现的 link / script / img；运行时动态插入且无法用属性兜底的依赖，
 * 由各自模块自行重试（见 js/security/content.js 与 js/common.js 的统计脚本）。
 * 本地副本与远程固定版本字节一致，SRI 哈希相同；切换地址时仍会移除 integrity，
 * 避免同源加载因 CORS 属性残留而失败。升级依赖版本时需同步更新本文件、vendor/ 目录，
 * 以及 js/security/content.js 中 marked / DOMPurify 的本地副本路径。
 */
(function () {
  'use strict';

  /** 远程依赖地址 → 仓库内副本地址。marked / DOMPurify 由 js/security/content.js 自行重试，不在此处登记。 */
  const LOCAL_FALLBACK = {
    'https://unpkg.com/mdui@1.0.2/dist/css/mdui.min.css': '/vendor/mdui/1.0.2/css/mdui.min.css',
    'https://unpkg.com/material-icons@1.13.14/iconfont/material-icons.css': '/vendor/material-icons/1.13.14/material-icons.css',
    'https://unpkg.com/mdui@1.0.2/dist/js/mdui.min.js': '/vendor/mdui/1.0.2/js/mdui.min.js',
    'https://cdn.jsdelivr.net/npm/ua-parser-js@2.0.7/dist/ua-parser.pack.min.js': '/vendor/ua-parser-js/2.0.7/ua-parser.pack.min.js',
    'https://sdk.51.la/icon/1-1.png': '/vendor/51la/icon/1-1.png',
  };

  /**
   * 取元素的远程地址。使用 href/src 属性可拿到浏览器解析后的绝对地址，与映射表键值一致。
   * @param {Element} element 触发 error 的元素
   * @returns {string} 绝对地址；不在支持列表内返回空串
   */
  function remoteUrlOf(element) {
    if (element.tagName === 'LINK') return element.href;
    if (element.tagName === 'SCRIPT') return element.src;
    if (element.tagName === 'IMG') return element.src;
    return '';
  }

  document.addEventListener('error', function (event) {
    const element = event.target;
    if (!element || !element.tagName) return;
    const localUrl = LOCAL_FALLBACK[remoteUrlOf(element)];
    if (!localUrl) return;

    element.removeAttribute('integrity');
    element.removeAttribute('crossorigin');

    // 解析期间的脚本用 document.write 同步插入，保证后续 module 脚本执行时依赖已就绪；
    // 解析结束后（极端情况）退回修改 src，避免 document.write 清空当前文档。
    if (element.tagName === 'SCRIPT' && document.readyState === 'loading') {
      document.write('<script src="' + localUrl + '"><\/script>');
      return;
    }
    if (element.tagName === 'LINK') element.href = localUrl;
    else element.src = localUrl;
  }, true);
})();
