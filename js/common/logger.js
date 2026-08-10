import { showToast } from "./toast.js";
import { escapeHtml } from "../security/content.js";

// =========================== 配置 ===========================
/** 默认配置（当用户设置未配置时使用） */
const DEFAULT_CONFIG = {
  /** 是否在控制台输出日志 */
  enableConsole: true,
  /** 全局错误监听是否阻止默认行为 */
  preventDefault: true,
};

/** Toast 配置的存储键 */
const TOAST_CONFIG_KEYS = {
  enableToast: 'fdn-logger-enableToast',
  duration: 'fdn-logger-duration',
};

/**
 * 从用户设置中读取动态 Toast 配置
 * @returns {{enableToast: boolean, duration: number}}
 */
function getToastConfig() {
  try {
    const storedEnableToast = localStorage.getItem(TOAST_CONFIG_KEYS.enableToast);
    const enableToast = storedEnableToast === null ? true : storedEnableToast === 'true';
    const storedDuration = localStorage.getItem(TOAST_CONFIG_KEYS.duration);
    const duration = storedDuration === null ? 10000 : Number(storedDuration) || 10000;
    return { enableToast, duration };
  } catch {
    return { enableToast: true, duration: 10000 };
  }
}

// =========================== 工具函数 ===========================

/**
 * 从任意事件对象中提取 Error 实例
 * @param {any} e
 * @returns {Error}
 */
function extractError(e) {
  // 1. DOM 错误事件
  if (e instanceof ErrorEvent) {
    return e.error || new Error(e.message);
  }

  // 2. 未捕获的 Promise 拒绝
  if (e instanceof PromiseRejectionEvent) {
    const reason = e.reason;
    return reason instanceof Error ? reason : new Error(String(reason));
  }

  // 3. 本身就是 Error
  if (e instanceof Error) {
    return e;
  }

  // 4. 其他类型（字符串、数字、对象等）
  return new Error(String(e));
}

// =========================== 核心日志函数 ===========================
/** 日志级别与 Toast 图标的映射 */
const ICON_MAP = {
  info: 'info_outline',
  warn: 'error_outline',
  error: 'highlight_off',
};

/**
 * 内部通用日志发送
 * @param {'info' | 'warn' | 'error'} level
 * @param {any} err 可转换为 Error 的任何值
 * @param {string} [context] 上下文描述
 */
function _log(level, err, context) {
  const error = extractError(err);
  // TODO: context 前缀未国际化：英文界面下 Toast 仍会显示中文语境（如“读取设置”）。
  // 若要彻底国际化，需为各调用点提供翻译键或统一去掉前缀。
  const prefix = context ? `${context}: ` : '';
  const message = error.message;
  const toastConfig = getToastConfig();

  // 1. 控制台输出
  if (DEFAULT_CONFIG.enableConsole) {
    const consoleMethod = console[level] || console.log;
    consoleMethod(prefix, error);
  }

  // 2. Toast 提示
  if (toastConfig.enableToast) {
    try {
      const icon = ICON_MAP[level] || 'info';
      // 对 message 进行 HTML 转义，防止 XSS
      const safeMessage = escapeHtml(prefix + message);
      showToast(`<i class="mdui-icon material-icons">${icon}</i>${safeMessage}`, { duration: toastConfig.duration });
    } catch (toastErr) {
      // 若 showToast 本身抛出错误
      if (DEFAULT_CONFIG.enableConsole) {
        console.warn('Toast 显示失败:', toastErr);
      }
    }
  }
}

// =========================== 导出 API ===========================
/** 记录信息日志
 * @param {any} err 可转换为 Error 的任何值
 * @param {string} [context] 上下文描述
 */
export function logInfo(err, context) {
  _log('info', err, context);
}

/** 记录警告日志
 * @param {any} err 可转换为 Error 的任何值
 * @param {string} [context] 上下文描述
 */
export function logWarn(err, context) {
  _log('warn', err, context);
}
/** 记录错误日志
 * @param {any} err 可转换为 Error 的任何值
 * @param {string} [context] 上下文描述
 */
export function logError(err, context) {
  _log('error', err, context);
}

// =========================== 全局兜底监听 ===========================
let listenersRegistered = false;

/**
 * 注册全局错误捕获监听（默认自动调用，也可手动调用以确保只注册一次）
 */
export function registerGlobalHandlers() {
  if (listenersRegistered) return;
  listenersRegistered = true;

  window.addEventListener('error', (e) => {
    if (DEFAULT_CONFIG.preventDefault) e.preventDefault();
    logError(e, 'JS运行时致命错误');
  });

  window.addEventListener('unhandledrejection', (e) => {
    if (DEFAULT_CONFIG.preventDefault) e.preventDefault();
    logError(e, '未捕获的Promise错误');
  });
}

// 自动注册（模块加载时生效）
registerGlobalHandlers();
