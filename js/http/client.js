/**
 * 浏览器网络访问的唯一入口。
 *
 * options.signal：由页面/选择器传入，表示用户主动取消；
 * options.timeoutMs：单次请求超时毫秒数，默认 15 秒；
 * options.cache：是否复用本页生命周期内同 URL、同响应类型的 Promise。
 */

import { t, getLocalizedPath } from '../common/i18n.js';

// 仅缓存本页生命周期内的“进行中/成功”请求；刷新页面后由浏览器 HTTP 缓存接管。
// 键同时包含响应类型，避免同一 URL 被按 JSON 与文本两种方式解析时发生混用。
const responseCache = new Map();

/**
 * 所有网络层错误的统一表示。
 * kind 用于 controller 决定提示语和取消后的 UI 行为，不能只依赖浏览器各异的 Error.message。
 */
export class HttpError extends Error {
  constructor(message, { kind = 'network', url = '', status = null, cause } = {}) {
    super(message, { cause });
    this.name = 'HttpError';
    this.kind = kind;
    this.url = url;
    this.status = status;
  }
}

/**
 * 合并外部取消信号与内部超时信号。
 * @param {AbortSignal|undefined} callerSignal controller 提供的用户取消信号
 * @param {number} timeoutMs 超时毫秒数，传入非正数时不启用超时
 * @returns {{signal: AbortSignal, didTimeOut: () => boolean, cleanup: () => void}}
 */
function createRequestSignal(callerSignal, timeoutMs) {
  // 不直接给 fetch 使用调用者 signal：这里额外合并了超时信号，任一方取消都会结束请求。
  const controller = new AbortController();
  let timedOut = false;

  // 保留外部取消原因，方便调用方区分“用户切换线路”和普通网络失败。
  const abortFromCaller = () => controller.abort(callerSignal.reason);
  if (callerSignal) {
    if (callerSignal.aborted) abortFromCaller();
    else callerSignal.addEventListener('abort', abortFromCaller, { once: true });
  }

  // AbortController 本身不区分超时与用户取消，因此额外记录 timedOut 作为分类依据。
  const timeoutId = timeoutMs > 0
    ? window.setTimeout(() => {
      timedOut = true;
      controller.abort(new DOMException(t('common.http.timeout'), 'TimeoutError'));
    }, timeoutMs)
    : null;

  return {
    signal: controller.signal,
    didTimeOut: () => timedOut,
    cleanup() {
      if (timeoutId !== null) window.clearTimeout(timeoutId);
      callerSignal?.removeEventListener('abort', abortFromCaller);
    },
  };
}

/**
 * 执行并解析一次请求。
 * @param {string} url 绝对地址或本站根路径地址
 * @param {'json'|'text'} responseType 成功响应的解析方式
 * @param {{signal?: AbortSignal, timeoutMs?: number, cache?: boolean}} options 请求控制项
 * @returns {Promise<unknown>} 已解析的响应；失败时抛出 HttpError
 */
async function request(url, responseType, options = {}) {
  const {
    signal,
    timeoutMs = 15000,
    cache = false,
  } = options;
  const cacheKey = `${responseType}:${url}`;

  // 缓存 Promise 而不是解析后的值：同一时刻多个消费者只会真正发起一次请求。
  if (cache && responseCache.has(cacheKey)) {
    return responseCache.get(cacheKey);
  }

  const requestPromise = (async () => {
    const requestSignal = createRequestSignal(signal, timeoutMs);
    try {
      // 所有业务代码只能经由本模块请求，确保 HTTP 状态与解析错误不会被遗漏。
      const response = await fetch(url, { signal: requestSignal.signal });
      if (!response.ok) {
        throw new HttpError(t('common.http.error', { status: response.status, statusText: response.statusText || t('common.http.failed') }), {
          kind: 'http',
          url,
          status: response.status,
        });
      }

      try {
        return responseType === 'json' ? await response.json() : await response.text();
      } catch (cause) {
        throw new HttpError(responseType === 'json' ? t('common.http.invalidJson') : t('common.http.unreadable'), {
          kind: 'parse',
          url,
          cause,
        });
      }
    } catch (error) {
      if (error instanceof HttpError) throw error;
      // 判断顺序不能颠倒：超时同样会触发 abort，需要优先给用户“超时”而非“已取消”。
      if (requestSignal.didTimeOut()) {
        throw new HttpError(t('common.http.timeoutUrl', { url }), { kind: 'timeout', url, cause: error });
      }
      if (requestSignal.signal.aborted) {
        throw new HttpError(t('common.http.aborted'), { kind: 'abort', url, cause: error });
      }
      throw new HttpError(t('common.http.network', { url }), { kind: 'network', url, cause: error });
    } finally {
      requestSignal.cleanup();
    }
  })();

  if (cache) {
    responseCache.set(cacheKey, requestPromise);
    // 失败请求不可缓存，否则点击“重试”会永远复用同一个 rejected Promise。
    requestPromise.catch(() => responseCache.delete(cacheKey));
  }
  return requestPromise;
}

/**
 * 获取 JSON 数据，适用于本站目录、标签、镜像配置及外部镜像 API。
 * @param {string} url 请求 URL
 * @param {{signal?: AbortSignal, timeoutMs?: number, cache?: boolean}} options 请求控制项
 * @returns {Promise<object|Array>} 已解析的 JSON 数据
 */
export function getJSON(url, options) {
  return request(url, 'json', options);
}

/**
 * 获取纯文本，适用于介绍 Markdown、HTML 和线路描述。
 * @param {string} url 请求 URL
 * @param {{signal?: AbortSignal, timeoutMs?: number, cache?: boolean}} options 请求控制项
 * @returns {Promise<string>} 响应文本
 */
export function getText(url, options) {
  return request(url, 'text', options);
}

/**
 * 获取本地文本资源；优先请求当前语言的本地化版本，失败时回退到原路径。
 * 用户主动取消的请求会继续向上抛出，不会静默回退。
 * @param {string} url 本地资源路径（如 '/data/announcement.html'）
 * @param {{signal?: AbortSignal, timeoutMs?: number, cache?: boolean}} options 请求控制项
 * @returns {Promise<string>} 响应文本
 */
export async function getLocalizedText(url, options = {}) {
  const localizedPath = getLocalizedPath(url);
  if (!localizedPath) return getText(url, options);
  try {
    return await getText(localizedPath, options);
  } catch (error) {
    // 用户主动取消的请求必须继续向上抛出，不会静默回退。
    if (error?.kind === 'abort') throw error;
    // 只对“资源不存在”类 HTTP 错误（404/403）回退原文；超时/网络失败直接抛出，
    // 避免先白等一次完整超时再重试，也避免吞掉真实错误。
    if (error?.kind !== 'http' || (error.status !== 404 && error.status !== 403)) throw error;
    return getText(url, options);
  }
}

/**
 * 清理内存请求缓存。
 * @param {string} [url] 指定资源；省略时清理当前页面的全部缓存
 */
export function clearResponseCache(url) {
  // url 为空时清空本页全部缓存；传入 URL 时只失效该资源的 JSON/文本两个变体。
  for (const key of responseCache.keys()) {
    if (!url || key.endsWith(`:${url}`)) responseCache.delete(key);
  }
}
