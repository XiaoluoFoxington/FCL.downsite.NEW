/**
 * 页面吉祥物插画
 * 在每个页面右下角固定悬浮一张"趴在墙上"的狐狸插画（RTL 语言下镜像到左下角）。
 * 纯装饰元素：不参与交互、不进入无障碍树，也不遮挡点击（pointer-events 由 CSS 关闭）。
 * 滚动位置不在页面底部时不显示，滚到最底部时才显示；
 * 图片为带透明通道的 AVIF，因此白天/夜间主题与 RTL 方向下都无需换图。
 */

/** 图片路径。尺寸由 css/xf.css 中的 --xf-fox-corner-width 决定。 */
const IMAGE_SRC = '/media/img/fox-corner.avif';

/** 元素 id。同时被 css/xf.css 与 css/rtl.css 选择，改名需同步。 */
const CONTAINER_ID = 'xf-foxCorner';

/** 到底部时切换的类名，控制 opacity: 0（样式见 css/xf.css）。 */
const AT_BOTTOM_CLASS = 'xf-foxCorner-atBottom';

/** 判定"已到底部"的容差（像素），吸收不同浏览器的取整差异。 */
const BOTTOM_TOLERANCE = 1;

/**
 * 当前滚动位置是否已在页面底部。
 * 页面不足一屏时视为一直在底部。
 * @returns {boolean}
 */
function isAtBottom() {
  const scrollTop = window.scrollY || document.documentElement.scrollTop;
  return window.innerHeight + scrollTop >= document.documentElement.scrollHeight - BOTTOM_TOLERANCE;
}

document.addEventListener('DOMContentLoaded', function () {
  // 页面重复引入 common.js 时不重复创建。
  if (document.getElementById(CONTAINER_ID)) return;

  const img = document.createElement('img');
  img.id = CONTAINER_ID;
  img.src = IMAGE_SRC;
  // 纯装饰：空 alt + aria-hidden，避免读屏软件朗读；pointer-events 由 CSS 关闭。
  img.alt = '';
  img.setAttribute('aria-hidden', 'true');
  // 图片缺失时不要留下破图占位（浏览器对空 alt 的破图渲染各版本不一致）。
  img.addEventListener('error', function () {
    img.remove();
  });

  // 固定定位元素直接挂在 body 下，避免祖先元素形成包含块导致定位偏移。
  document.body.appendChild(img);

  // 滚动/窗口尺寸变化时同步透明度。
  // 不用 rAF 节流：后台标签页或窗口不可见时 rAF 可能暂停，会让状态停留在旧值。
  const syncBottomState = () => {
    img.classList.toggle(AT_BOTTOM_CLASS, isAtBottom());
  };

  window.addEventListener('scroll', syncBottomState, { passive: true });
  window.addEventListener('resize', syncBottomState);
  // 图片/字体等资源加载完成后页面高度可能变化，补算一次避免初始状态过期。
  window.addEventListener('load', syncBottomState, { once: true });
  syncBottomState();
});
