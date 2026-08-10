/**
 * i18n 国际化核心模块
 *
 * 设计目标：绝不影响站点可用性。
 * - 翻译键缺失时按用户设置的语言顺序依次回退，再回退到键本身，绝不抛错；
 * - 所有 DOM 翻译逐元素容错，单个元素失败不影响其他元素；
 * - 语言顺序保存在本地偏好中，语言设置页可实时排序预览；
 * - 默认简体中文，未检测到支持的语言时保持中文。
 */

import zhCN from '../i18n/zh-CN.js';
import enUS from '../i18n/en-US.js';
import { readPreference, writePreference } from '../domain/preferences.js';
import { logWarn } from './logger.js';

/** 语言偏好存储键（旧版单值） */
const LANGUAGE_KEY = 'fdn-language';

/** 语言顺序偏好存储键（数组：第一位为界面语言，其余为回退顺序） */
const LANGUAGE_ORDER_KEY = 'fdn-language-order';

/** 支持的语言包 */
const LANGUAGE_PACKS = {
  'zh-CN': zhCN,
  'en-US': enUS,
};

/** 语言显示名称（用于语言选择器） */
export const LANGUAGE_NAMES = {
  'zh-CN': '简体中文',
  'en-US': 'English',
};

let currentLang = 'zh-CN';
let languageOrder = ['zh-CN', 'en-US'];
let initPromise = null;

/**
 * 读取嵌套翻译值。
 * 键段中的点号可用反斜杠转义（如 tags.MC\\.1.20），避免动态键本身含点时路径断裂。
 * @param {object} pack 语言包
 * @param {string} key 点号分隔的键路径
 * @returns {string|undefined}
 */
function getNestedValue(pack, key) {
  let value = pack;
  const parts = String(key).split(/(?<!\\)\./).map((part) => part.replace(/\\\./g, '.'));
  for (const part of parts) {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, part)) {
      value = value[part];
    } else {
      return undefined;
    }
  }
  return typeof value === 'string' ? value : undefined;
}

/**
 * 转义动态键段中的点号与反斜杠，避免被当成路径分隔符。
 * 例如标签名 "MC 1.20" 应生成 `tags.${escapeKeySegment(name)}`。
 * @param {string} segment 动态键段
 * @returns {string}
 */
export function escapeKeySegment(segment) {
  return String(segment).replace(/\\/g, '\\\\').replace(/\./g, '\\.');
}

/**
 * 按语言顺序查找翻译；找不到时返回 undefined，供 t/tOr 区分“缺失”与“翻译值恰好等于键名”。
 * @param {string} key 翻译键
 * @returns {string|undefined}
 */
function lookupTranslation(key) {
  for (const lang of languageOrder) {
    const value = getNestedValue(LANGUAGE_PACKS[lang], key);
    if (value !== undefined) return value;
  }
  return undefined;
}

/**
 * 替换 {param} 占位符。
 * @param {string} text 原文
 * @param {object} params 参数映射
 * @param {Set<string>} skip 需要保留原样的参数名（用于 DOM 占位符元素）
 * @returns {string}
 */
function interpolate(text, params, skip) {
  if (!params || Object.keys(params).length === 0) return text;
  return text.replace(/\{(\w+)\}/g, (match, name) => {
    if (skip && skip.has(name)) return match;
    return Object.prototype.hasOwnProperty.call(params, name) ? String(params[name]) : match;
  });
}

/**
 * 翻译函数。
 * @param {string} key 翻译键，如 'common.nav.resourceList'
 * @param {object} [params] 参数替换 {name: value}
 * @param {Set<string>} [skip] 不替换的占位符名集合
 * @returns {string}
 */
export function t(key, params = {}, skip = null) {
  try {
    const value = lookupTranslation(key);
    if (value !== undefined) return interpolate(value, params, skip);
  } catch (error) {
    logWarn(error, `i18n 翻译失败: ${key}`);
  }
  return key;
}

/**
 * 获取当前语言代码。
 * @returns {string} 'zh-CN' | 'en-US'
 */
export function getCurrentLang() {
  return currentLang;
}

/**
 * 获取当前语言顺序列表（第一位为界面语言，其余为回退顺序）。
 * @returns {Array<string>} 语言代码数组
 */
export function getLanguageOrder() {
  return [...languageOrder];
}

/**
 * 规范化语言顺序：只保留支持的语言、去重，并把缺失的支持语言补到末尾。
 * @param {Array<string>} list 原始顺序
 * @returns {Array<string>}
 */
function normalizeLanguageOrder(list) {
  const normalized = [];
  const supported = Object.keys(LANGUAGE_PACKS);
  for (const code of Array.isArray(list) ? list : []) {
    if (LANGUAGE_PACKS[code] && !normalized.includes(code)) normalized.push(code);
  }
  for (const code of supported) {
    if (!normalized.includes(code)) normalized.push(code);
  }
  return normalized;
}

/**
 * 读取语言顺序偏好；兼容旧版单值偏好，无任何偏好时按浏览器语言生成默认顺序。
 * @returns {Array<string>}
 */
function loadLanguageOrder() {
  const saved = readPreference(LANGUAGE_ORDER_KEY);
  if (saved) {
    try {
      const parsed = JSON.parse(saved);
      if (Array.isArray(parsed) && parsed.length) {
        const order = normalizeLanguageOrder(parsed);
        // 把清洗后的顺序写回，清除重复/无效项，避免每次加载都重复规范化。
        writePreference(LANGUAGE_ORDER_KEY, JSON.stringify(order));
        return order;
      }
    } catch (error) {
      logWarn(error, '解析语言顺序偏好');
    }
  }
  const legacy = readPreference(LANGUAGE_KEY);
  if (legacy && LANGUAGE_PACKS[legacy]) {
    const order = normalizeLanguageOrder([legacy]);
    writePreference(LANGUAGE_ORDER_KEY, JSON.stringify(order));
    return order;
  }
  const order = normalizeLanguageOrder([detectBrowserLang()]);
  writePreference(LANGUAGE_ORDER_KEY, JSON.stringify(order));
  return order;
}

/**
 * 设置语言顺序并保存偏好。
 * 列表第一位为界面显示语言；翻译键缺失时按列表顺序依次回退。
 * @param {Array<string>} order 语言代码数组
 * @param {{reload?: boolean}} [options] reload=true 时切换后刷新页面（默认）
 */
export function setLanguageOrder(order, { reload = true } = {}) {
  const normalized = normalizeLanguageOrder(order);
  if (!normalized.length) return;
  languageOrder = normalized;
  currentLang = normalized[0];
  try {
    writePreference(LANGUAGE_ORDER_KEY, JSON.stringify(normalized));
    document.documentElement.lang = currentLang;
  } catch (error) {
    logWarn(error, '保存语言顺序');
  }
  try {
    // applyTranslations();
    // 注释掉，强行让用户刷新页面
  } catch (error) {
    logWarn(error, '应用语言翻译');
  }
  if (reload) {
    try {
      window.location.reload();
    } catch (error) {
      logWarn(error, '刷新页面');
    }
  }
}

/**
 * 获取所有支持的语言列表。
 * @returns {Array<{code: string, name: string}>}
 */
export function getSupportedLanguages() {
  return Object.keys(LANGUAGE_PACKS).map((code) => ({
    code,
    name: LANGUAGE_NAMES[code] || code,
  }));
}

/**
 * 对 DOM 应用翻译。
 * 支持两种用法：
 * - data-i18n="key"：翻译文本内容；
 * - data-i18n="key" data-i18n-attr="attr"：翻译指定属性（如 title/alt/content）。
 * 混合内容请用 data-i18n-placeholder="name" 标记子元素，翻译文本中以 {name} 保留。
 * @param {ParentNode} [root=document] 扫描根节点
 */
export function applyTranslations(root = document) {
  if (!root || typeof root.querySelectorAll !== 'function') return;
  let elements = [];
  try {
    // 先处理 root 自身（若它带有 data-i18n），再处理其全部后代。
    if (typeof root.matches === 'function' && root.matches('[data-i18n]')) {
      elements.push(root);
    }
    elements.push(...root.querySelectorAll('[data-i18n]'));
  } catch (error) {
    logWarn(error, 'i18n 扫描 DOM');
    return;
  }

  elements.forEach((el) => {
    try {
      const key = el.getAttribute('data-i18n');
      if (!key) return;

      let params = {};
      const paramsStr = el.getAttribute('data-i18n-params');
      if (paramsStr) {
        try {
          params = JSON.parse(paramsStr) || {};
        } catch (_) {
          logWarn(`解析 i18n 参数失败: ${paramsStr}`);
        }
      }

      const attr = el.getAttribute('data-i18n-attr');
      if (attr) {
        el.setAttribute(attr, t(key, params));
        return;
      }

      // 收集占位符子元素并临时移出 DOM，翻译后再按 {name} 文本位置还原。
      // 注意：占位符元素必须在设置 textContent 之前移除，否则会被 textContent 覆盖销毁。
      const placeholders = new Map();
      el.querySelectorAll('[data-i18n-placeholder]').forEach((child) => {
        const name = child.getAttribute('data-i18n-placeholder');
        if (name && !placeholders.has(name)) {
          placeholders.set(name, child);
          child.remove();
        }
      });

      const skip = new Set(placeholders.keys());
      el.textContent = t(key, params, skip);

      // 还原占位符：同一 token 出现多次时用克隆逐个插入，避免 appendChild 移动同一节点导致文本错位；
      // 翻译中完全缺失 token 时追加到末尾兜底，避免子元素（链接等）被永久丢弃。
      placeholders.forEach((child, name) => {
        const token = `{${name}}`;
        const textNodes = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue.includes(token)) textNodes.push(node);
        }
        let inserted = false;
        for (const textNode of textNodes) {
          const parts = textNode.nodeValue.split(token);
          const parent = textNode.parentNode;
          const fragment = document.createDocumentFragment();
          parts.forEach((part, index) => {
            if (index > 0) {
              fragment.appendChild(inserted ? child.cloneNode(true) : child);
              inserted = true;
            }
            if (part) fragment.appendChild(document.createTextNode(part));
          });
          parent.replaceChild(fragment, textNode);
        }
        if (!inserted) {
          logWarn(`i18n 翻译缺少占位符 ${token}（键：${el.getAttribute('data-i18n')}），已追加到元素末尾`);
          el.appendChild(child);
        }
      });
    } catch (error) {
      logWarn(error, `i18n 应用翻译失败: ${el.getAttribute('data-i18n')}`);
    }
  });
}

/**
 * 翻译动态插入的内容（如抽屉、公告等）。
 * @param {ParentNode} container 新内容容器
 */
export function translateDynamicContent(container) {
  applyTranslations(container);
}

/**
 * 检测浏览器语言。
 * @returns {string} 支持的语言代码，不支持时返回 'zh-CN'
 */
function detectBrowserLang() {
  try {
    const lang = String(navigator.language || navigator.userLanguage || 'zh-CN').toLowerCase();
    if (lang.startsWith('zh')) return 'zh-CN';
    if (lang.startsWith('en')) return 'en-US';
  } catch (_) {
    // 忽略检测异常
  }
  return 'zh-CN';
}

/**
 * 初始化 i18n：恢复保存的语言或检测浏览器语言，并在 DOM 就绪后应用翻译。
 * @returns {Promise<void>}
 */
export function initI18n() {
  if (initPromise) return initPromise;

  initPromise = new Promise((resolve) => {
    try {
      languageOrder = loadLanguageOrder();
      currentLang = languageOrder[0] || 'zh-CN';
      document.documentElement.lang = currentLang;
    } catch (error) {
      logWarn(error, '初始化 i18n');
    }

    const apply = () => {
      try {
        applyTranslations();
      } catch (error) {
        logWarn(error, '应用初始翻译');
      }
      resolve();
    };

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', apply, { once: true });
    } else {
      apply();
    }
  });

  return initPromise;
}

/**
 * 翻译标签名（数据源中的中文标签），无对应翻译时原样返回。
 * @param {string} name 标签名
 * @returns {string}
 */
export function translateTag(name) {
  if (!name) return name;
  return tOr(`tags.${escapeKeySegment(name)}`, name);
}

/**
 * 翻译键存在时返回翻译值，否则回退到原文本（用于数据源里的中文内容）。
 * @param {string} key 翻译键
 * @param {string} fallback 键不存在时返回的原文
 * @returns {string}
 */
export function tOr(key, fallback) {
  try {
    const value = lookupTranslation(key);
    if (value !== undefined) return interpolate(value);
  } catch (error) {
    logWarn(error, `i18n 翻译失败: ${key}`);
  }
  return fallback;
}

/**
 * 生成本地资源的本地化路径；当前为中文或远程地址时返回 null。
 * 例如 '/data/announcement.html' → '/data/announcement.en-US.html'。
 * @param {string} path 本地资源路径（以 / 开头）
 * @returns {string|null}
 */
export function getLocalizedPath(path) {
  if (currentLang === 'zh-CN') return null;
  if (typeof path !== 'string' || !path.startsWith('/')) return null;
  // 先剥离 query/hash，避免查询参数或锚点里的点被误当成扩展名；
  // 只对带扩展名的本地文件生成本地化路径；无扩展名时返回 null，避免调用方重复请求同一 URL。
  const suffixIndex = path.search(/[?#]/);
  const pathOnly = suffixIndex === -1 ? path : path.slice(0, suffixIndex);
  const suffix = suffixIndex === -1 ? '' : path.slice(suffixIndex);
  const extensionIndex = pathOnly.lastIndexOf('.');
  const lastSlashIndex = pathOnly.lastIndexOf('/');
  if (extensionIndex <= lastSlashIndex || extensionIndex === pathOnly.length - 1) return null;
  return `${pathOnly.slice(0, extensionIndex)}.${currentLang}${pathOnly.slice(extensionIndex)}${suffix}`;
}
