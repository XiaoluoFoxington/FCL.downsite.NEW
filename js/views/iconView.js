/**
 * 图标渲染视图。
 *
 * 统一资源图标的创建逻辑，供列表页、详情页与收藏列表复用：
 * - 普通位图（.avif/.png/.webp 等）沿用 <img> 渲染，行为与旧代码一致；
 * - SVG 图标（以 .svg 结尾）异步拉取后作为**内联 SVG** 注入 DOM，
 *   使其 fill 可直接继承页面 currentColor，从而实时跟随主题的强调色
 *   （父容器加 mdui-text-color-theme-accent），背景保持透明。
 *
 * 内联 SVG 属于远程内容，注入前经 sanitizeSvg 白名单净化，禁止脚本与外部引用。
 */

import { getText } from '../http/client.js';
import { logWarn } from '../common/logger.js';
import { t } from '../common/i18n.js';

/** 判定一个图标地址是否为 SVG。仅看扩展名，忽略 query/hash。 */
export function isSvgIcon(icon) {
  if (typeof icon !== 'string' || !icon) return false;
  const path = icon.split(/[?#]/)[0];
  return /\.svg$/i.test(path);
}

/**
 * 净化 SVG DOM：移除可执行与可外部引用的内容。
 * 只做「删除危险节点/属性」的白名单式清理，不重写其余绘制属性，
 * 保证 currentColor 等继承行为不被破坏。
 * @param {SVGElement} svg 已解析的 SVG 根元素
 * @returns {SVGElement} 同一个（原地净化后的）SVG 根元素
 */
function sanitizeSvg(svg) {
  // 1) 移除脚本、外部嵌入与动画中的脚本入口。
  svg.querySelectorAll('script, foreignObject, iframe, object, embed, use').forEach((el) => el.remove());

  // 2) 移除所有 on* 事件属性与指向外部的 href / xlink:href（允许页内 #id 引用）。
  const walk = (el) => {
    for (const attr of Array.from(el.attributes || [])) {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) {
        el.removeAttribute(attr.name);
        continue;
      }
      if (name === 'href' || name === 'xlink:href') {
        const value = String(attr.value || '').trim();
        if (!value.startsWith('#')) el.removeAttribute(attr.name);
      }
    }
    for (const child of Array.from(el.children || [])) walk(child);
  };
  walk(svg);

  return svg;
}

/**
 * 解析 SVG 文本为已净化的 SVG 元素；失败时返回 null。
 * @param {string} text SVG 源文本
 * @returns {SVGElement|null}
 */
function parseSvg(text) {
  try {
    const parsed = new DOMParser().parseFromString(text, 'image/svg+xml');
    // 解析失败时浏览器会返回包含 <parsererror> 的文档，需显式识别。
    if (!parsed || parsed.querySelector('parsererror')) return null;
    const svg = parsed.documentElement;
    if (!svg || svg.nodeName.toLowerCase() !== 'svg') return null;
    // 跨文档节点需导入到当前文档，否则无法直接插入。
    return document.importNode(svg, true);
  } catch (error) {
    logWarn(error, '解析 SVG 图标', { noToast: true });
    return null;
  }
}

/**
 * 创建图标元素。
 *
 * 非 SVG：同步返回 <img>，与旧行为完全一致。
 * SVG：同步返回一个占位 <span> 包裹层，内部异步填入内联 SVG；
 *      失败时在包裹层内回退为 <img> 指向原始地址，保证不破坏页面。
 *
 * @param {{icon?: string, name?: string, size?: number, className?: string, imgClassName?: string}} options
 * @returns {HTMLElement} 图标元素（<img> 或 <span> 包裹层）
 */
export function createIconElement({ icon, name = '', size = 24, className = '', imgClassName = '' } = {}) {
  const src = icon || '/media/img/picMissing.webp';

  if (!isSvgIcon(src)) {
    const img = document.createElement('img');
    img.src = src;
    img.alt = name;
    img.width = size;
    img.height = size;
    img.loading = 'lazy';
    if (imgClassName) img.className = imgClassName;
    if (className) img.className = (img.className ? img.className + ' ' : '') + className;
    return img;
  }

  // SVG 包裹层：承载尺寸与强调色（currentColor 由这里的文字色决定），背景透明。
  const wrapper = document.createElement('span');
  wrapper.className = 'xf-icon-svg mdui-text-color-theme-accent';
  if (className) wrapper.className += ' ' + className;
  wrapper.style.width = `${size}px`;
  wrapper.style.height = `${size}px`;
  wrapper.setAttribute('role', 'img');
  wrapper.setAttribute('aria-label', name);

  // 异步拉取并注入；首屏先渲染回退位图，避免空白闪烁与布局抖动。
  const fallback = () => {
    const img = document.createElement('img');
    img.src = src;
    img.alt = name;
    img.width = size;
    img.height = size;
    img.loading = 'lazy';
    if (imgClassName) img.className = imgClassName;
    wrapper.replaceChildren(img);
  };

  getText(src, { cache: true })
    .then((text) => {
      const svg = parseSvg(text);
      if (!svg) {
        logWarn(t('common.icon.parseFailed', { src }), 'SVG 图标', { noToast: true });
        fallback();
        return;
      }
      sanitizeSvg(svg);
      // 由包裹层控制尺寸与颜色：SVG 自身铺满并继承 currentColor。
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      svg.setAttribute('width', '100%');
      svg.setAttribute('height', '100%');
      svg.setAttribute('focusable', 'false');
      svg.setAttribute('aria-hidden', 'true');
      wrapper.replaceChildren(svg);
    })
    .catch((error) => {
      logWarn(error, `加载 SVG 图标 ${src}`, { noToast: true });
      fallback();
    });

  return wrapper;
}
