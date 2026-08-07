/**
 * Toast 临时消息组件。
 * 独立于 MDUI Snackbar，支持多实例同时显示。
 * 功能：自定义显示时间、尺寸、位置（四角）、复杂 HTML 内容。
 * 动画：直接出现 → 根据时间线性渐隐（无位移）。
 * 风格：MD1，与 MDUI 1.0.2 视觉协调。
 *
 * @module toast
 */

/** 位置枚举 → 容器类名后缀映射 */
const POSITION_SUFFIX = {
  'top-left': 'tl',
  'top-right': 'tr',
  'bottom-left': 'bl',
  'bottom-right': 'br',
};

/** 容器缓存（以容器类名后缀为键） */
const containers = new Map();

/**
 * 获取（或惰性创建）指定角落的 Toast 容器。
 * @param {string} position 位置标识
 * @returns {HTMLDivElement}
 */
function getContainer(position) {
  const suffix = POSITION_SUFFIX[position] || 'br';
  const containerClass = `toast-container-${suffix}`;

  if (!containers.has(containerClass)) {
    // 利用组合类选择器精准定位
    let el = document.querySelector(`.toast-container.${containerClass}`);
    if (!el) {
      el = document.createElement('div');
      el.className = `toast-container ${containerClass}`;
      document.body.appendChild(el);
    }
    containers.set(containerClass, el);
  }
  return containers.get(containerClass);
}

/**
 * 显示一条 Toast 临时消息。
 *
 * @param {string} content 消息内容，支持 HTML（innerHTML）。
 * @param {object} [options] 选项。
 * @param {number} [options.duration=10000] 显示/渐隐时间（毫秒），最小 100ms。
 * @param {string} [options.size=''] 尺寸：''（默认）| 'sm' | 'lg'。
 * @param {string} [options.position='bottom-right'] 位置：
 *   'top-left' | 'top-right' | 'bottom-left' | 'bottom-right'。
 * @returns {{ close: Function, element: HTMLDivElement }}
 *   close() 可手动提前关闭；element 为 Toast 的 DOM 引用。
 */
export function showToast(content, options = {}) {
  const {
    duration = 10000,
    size = '',
    position = 'bottom-right',
  } = options;

  // 保证有效时长：若未传或为 0/负数，取 100ms；否则取原值并确保不小于 100ms
  const safeDuration = Math.max(100, duration ?? 10000);
  const container = getContainer(position);

  // 创建 Toast 元素
  const toast = document.createElement('div');
  toast.className = 'toast' + (size ? ` toast-${size}` : '');
  toast.classList.add('mdui-color-theme-accent');
  toast.innerHTML = content;

  container.appendChild(toast);

  let removed = false;
  const remove = () => {
    if (removed) return;
    removed = true;
    toast.remove();
  };

  // 强制回流确保初始 opacity:1 渲染完成，再启动渐隐过渡
  toast.offsetHeight; // eslint-disable-line no-unused-expressions
  toast.style.transition = `opacity ${safeDuration}ms linear`;
  toast.style.opacity = '0';

  // 过渡结束后自动移除
  toast.addEventListener('transitionend', remove, { once: true });

  return {
    /**
     * 手动关闭此 Toast（250ms 快速渐隐）。
     */
    close() {
      if (removed) return;
      toast.style.transition = 'opacity 250ms linear';
      toast.style.opacity = '0';
      // transitionend 会自动触发 remove，无需额外操作
    },
    /** Toast 的 DOM 元素引用 */
    element: toast,
  };
}