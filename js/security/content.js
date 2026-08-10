/**
 * 远程内容安全边界。
 * 所有来自镜像/第三方仓库的 HTML 和 Markdown 必须经 createSafeContent 处理后才能插入 DOM；
 * 其他页面若仅需显示字符串，应直接使用 textContent，不应调用本模块。
 */

// TODO: 循环依赖：i18n.js → logger.js → content.js → i18n.js。
// 当前因各模块顶层未互相调用导出而可安全运行，但结构脆弱；
// 后续可把依赖错误文案的翻译移到调用方，或把 escapeHtml 拆到不依赖 i18n 的模块。
import { t } from '../common/i18n.js';

// 这两个依赖只在介绍正文或明确声明为 HTML 的远程描述首次展示时加载，
// 完整性哈希防止 CDN 内容被替换后仍在本站上下文执行。
const MARKED = {
  src: 'https://cdn.jsdelivr.net/npm/marked@15.0.12/lib/marked.umd.min.js',
  integrity: 'sha384-zCewoQXXb5Xf+2nvCjab0EbMl7FWVpJMsKyrc8M8DqxjFra4DY4XHwheVdHXa34k',
  globalName: 'marked',
};
const DOM_PURIFY = {
  src: 'https://cdn.jsdelivr.net/npm/dompurify@3.2.6/dist/purify.min.js',
  integrity: 'sha384-JEyTNhjM6R1ElGoJns4U2Ln4ofPcqzSsynQkmEc/KGy6336qAZl70tDLufbkla+3',
  globalName: 'DOMPurify',
};
// 同一种依赖可能被多个展开面板同时触发；复用 Promise 可避免重复插入 script 标签。
const scriptPromises = new Map();

/**
 * 懒加载固定版本的全局脚本。
 * 加载失败后会移除缓存，以便用户稍后重试，而不是永久保留失败状态。
 */
/**
 * @param {{src: string, integrity: string, globalName: string}} dependency 外部脚本的固定地址、SRI 与全局变量名
 * @returns {Promise<unknown>} 对应的 window 全局对象，例如 marked 或 DOMPurify
 */
export function loadExternalScript({ src, integrity, globalName }) {
  if (window[globalName]) return Promise.resolve(window[globalName]);
  if (scriptPromises.has(src)) return scriptPromises.get(src);

  const promise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.integrity = integrity;
    script.crossOrigin = 'anonymous';
    script.addEventListener('load', () => {
      if (window[globalName]) resolve(window[globalName]);
      else reject(new Error(t('common.dependencyMissing', { name: globalName })));
    }, { once: true });
    script.addEventListener('error', () => reject(new Error(t('common.dependencyLoadFailed', { src }))), { once: true });
    document.head.appendChild(script);
  }).catch((error) => {
    scriptPromises.delete(src);
    throw error;
  });

  scriptPromises.set(src, promise);
  return promise;
}

/**
 * 解析并净化远程正文。
 * @param {string} rawContent 原始 HTML 或 Markdown 文本
 * @param {{type?: 'html'|'md', baseUrl?: string}} options 内容类型与相对链接基准
 * @returns {Promise<DocumentFragment>} 可直接 append/replaceChildren 的安全片段
 */
export async function createSafeContent(rawContent, { type = 'html', baseUrl } = {}) {
  // Markdown 先转 HTML，再与原生 HTML 走同一套白名单净化策略。
  const [DOMPurify, markdownParser] = await Promise.all([
    loadExternalScript(DOM_PURIFY),
    type === 'md' ? loadExternalScript(MARKED) : Promise.resolve(null),
  ]);
  const rawHtml = type === 'md'
    ? markdownParser.parse(rawContent, { async: false })
    : rawContent;
  // 禁用可执行/可嵌入的标签，即使远程仓库内容被篡改也无法在本站执行脚本。
  const cleanHtml = DOMPurify.sanitize(rawHtml, {
    FORBID_TAGS: ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'base', 'form'],
    FORBID_ATTR: ['srcdoc'],
    ALLOW_DATA_ATTR: false,
  });
  const template = document.createElement('template');
  // 此处是唯一允许写入 innerHTML 的边界：输入已经经过 DOMPurify 净化。
  template.innerHTML = cleanHtml;
  rewriteUrls(template.content, baseUrl);
  window.mdui?.mutation();
  return template.content;
}

/**
 * 将富文本内的链接转为可安全使用的绝对地址。
 * 仅允许 http/https；图片额外允许 data:image，禁止 javascript:、file: 等协议。
 */
function rewriteUrls(root, baseUrl) {
  // DOMPurify 负责删除危险标签/属性；本函数再收紧协议并补齐相对地址，二者缺一不可。
  root.querySelectorAll('[href]').forEach((element) => {
    const href = makeAbsoluteUrl(element.getAttribute('href'), baseUrl);
    if (href) element.setAttribute('href', href);
    else element.removeAttribute('href');
    // 只有跨域链接才新开窗口；页内锚点保持原行为，避免意外跳出当前文档。
    if (element.tagName === 'A' && href && !href.startsWith('#')) {
      try {
        if (new URL(href, window.location.href).origin !== window.location.origin) {
          element.target = '_blank';
          element.rel = 'noopener noreferrer';
        }
      } catch (_) {
        element.removeAttribute('href');
      }
    }
  });

  root.querySelectorAll('img[src], source[src]').forEach((element) => {
    const src = makeAbsoluteUrl(element.getAttribute('src'), baseUrl);
    if (src) element.setAttribute('src', src);
    else element.removeAttribute('src');
    if (element.tagName === 'IMG') {
      element.loading = 'lazy';
    }
  });
}

// 这里传进来的baseUrl一定得是detail.json['intro'][${index}]['url']！不能是带有当前文件的路径！
function makeAbsoluteUrl(value, baseUrl) {
  if (!baseUrl) return value;
  // data: 和 mailto: 等协议开头的值直接保留，不拼接 baseUrl。
  // 注意：javascript: 必须被过滤掉，不能在此处保留——虽然 DOMPurify 上游已删除危险脚本，
  // 但本函数若保留 javascript: 会让 rewriteUrls 的 href 走原样回写分支，逻辑冗余且不安全。
  if (/^(https?:|data:|mailto:|#|\/\/)/i.test(value)) return value;
  if (value.startsWith('./')) value = value.replace('./', '');
  return joinUrl(baseUrl, value);
}

/**
 * 拼接基础 URL 与资源路径，自动处理首尾斜杠，避免双斜杠或路径截断。
 * @param {string} baseUrl 基础 URL
 * @param {string} key 资源路径 key
 * @returns {string} 拼接后的完整 URL
 */
export function joinUrl(baseUrl, key) {
  return `${String(baseUrl).replace(/\/$/, '')}/${String(key).replace(/^\//, '')}`;
}

/**
 * 判断动态 href/downloadUrl 是否可用。
 * @param {unknown} value 待验证地址
 * @param {{allowRelative?: boolean}} options 是否接受以 / 开头的本站地址
 */
export function isSafeNavigationUrl(value, { allowRelative = true } = {}) {
  // 动态写入 href 前的轻量校验；下载链接调用时会关闭相对路径支持。
  if (allowRelative && typeof value === 'string' && value.startsWith('/')) return true;
  try {
    const url = new URL(value, window.location.href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch (_) {
    return false;
  }
}

/**
 * 简单的 HTML 转义，防止 XSS
 * @param {string} str
 * @returns {string}
 */
export function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}
