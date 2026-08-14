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
import jaJP from '../i18n/ja-JP.js';
import frFR from '../i18n/fr-FR.js';
import ruRU from '../i18n/ru-RU.js';
import ar from '../i18n/ar.js';
import esES from '../i18n/es-ES.js';
import { readPreference, writePreference } from '../domain/preferences.js';
import { logWarn } from './logger.js';

/** 语言偏好存储键（旧版单值） */
const LANGUAGE_KEY = 'fdn-language';

/** 语言顺序偏好存储键（数组：第一位为界面语言，其余为回退顺序） */
const LANGUAGE_ORDER_KEY = 'fdn-language-order';

/** 从右到左（RTL）书写方向的语言主代码集合。新增 RTL 语言时在此登记。 */
const RTL_BASE_LANGS = new Set(['ar', 'he', 'fa', 'ur', 'ps', 'dv', 'ku', 'sd']);

/** 支持的语言包（比较表等场景需要直接读取语言包内容） */
export const LANGUAGE_PACKS = {
  'zh-CN': zhCN,
  'en-US': enUS,
  'ja-JP': jaJP,
  'fr-FR': frFR,
  'ru-RU': ruRU,
  'ar': ar,
  'es-ES': esES,
};

/** 语言显示名称（用于语言选择器） */
export const LANGUAGE_NAMES = {
  'zh-CN': '简体中文',
  'en-US': 'English',
  'ja-JP': '日本語',
  'fr-FR': 'Français',
  'ru-RU': 'Русский',
  'ar': 'العربية',
  'es-ES': 'Español',
};

let currentLang = 'zh-CN';
let languageOrder = ['zh-CN', 'en-US', 'ja-JP', 'fr-FR', 'ru-RU', 'ar', 'es-ES'];
let initPromise = null;

/**
 * 读取嵌套翻译值。键段中的点号可用反斜杠转义（如 tags.MC\\.1.20），
 * 避免动态键本身含点时路径断裂。
 * @param {object} pack 语言包
 * @param {string} key 点号分隔的键路径
 * @returns {string|undefined}
 */
function getNestedValue(pack, key) {
  // 参数基本校验
  if (pack == null || typeof pack !== 'object' || key == null) {
    return undefined;
  }

  // 手动解析 key，按未被转义的点号分割，并还原转义的点号与反斜杠
  const parts = [];
  let currentPart = '';
  let escaped = false;

  const keyStr = String(key);
  for (let i = 0; i < keyStr.length; i++) {
    const ch = keyStr[i];
    if (escaped) {
      // 前一个字符是反斜杠：还原转义（\\ → \，\. → .）
      currentPart += ch;
      escaped = false;
    } else if (ch === '\\') {
      // 遇到反斜杠，标记转义，但不追加反斜杠本身
      escaped = true;
    } else if (ch === '.') {
      // 未转义的点号：分割
      parts.push(currentPart);
      currentPart = '';
    } else {
      currentPart += ch;
    }
  }
  // 处理最后一个片段（若 key 以反斜杠结尾，则 escaped 为 true，此时应追加反斜杠？但这种情况不合法，忽略）
  parts.push(currentPart);

  // 沿路径逐级查找
  let value = pack;
  for (const part of parts) {
    if (value && typeof value === 'object' && Object.prototype.hasOwnProperty.call(value, part)) {
      value = value[part];
    } else {
      return undefined;
    }
  }

  // 仅当最终值为字符串时返回，否则 undefined
  return typeof value === 'string' ? value : undefined;
}

/**
 * 转义动态键段中的点号与反斜杠，避免被当成路径分隔符。
 * 例如标签名 "MC 1.20" 应生成 `tags.${escapeKeySegment(name)}`。
 * 转义规则：\ → \\，. → \.；getNestedValue 负责反向还原。
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
  return text.replace(/\{([\w.]+)\}/g, (match, name) => {
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
    logWarn(error, { key: 'logger.context.i18nTranslateError', params: { key } });
  }
  return key;
}

/**
 * 获取当前语言代码。
 * @returns {string} 'zh-CN' | 'en-US' | 'ja-JP' | 'fr-FR' | 'ru-RU' | 'ar' | 'es-ES'
 */
export function getCurrentLang() {
  return currentLang;
}

/**
 * 判断语言是否为从右到左（RTL）书写方向。
 * 支持的语言代码（如 'ar'）或带区域的代码（如 'ar-SA'）均可判断。
 * @param {string} code 语言代码
 * @returns {boolean}
 */
export function isRTLLang(code) {
  if (typeof code !== 'string' || !code) return false;
  const base = code.split('-')[0].toLowerCase();
  return RTL_BASE_LANGS.has(base);
}

/**
 * 根据当前语言设置 <html dir> 书写方向（rtl/ltr）。
 * 语言切换后需刷新页面，因此仅需在初始化与保存顺序时调用。
 */
function applyDirection() {
  try {
    document.documentElement.dir = isRTLLang(currentLang) ? 'rtl' : 'ltr';
  } catch (error) {
    logWarn(error, '应用书写方向');
  }
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
    applyDirection();
  } catch (error) {
    logWarn(error, '保存语言顺序');
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
 * 混合内容中带 data-i18n 的直接子元素作为占位符处理：
 * - data-i18n="some.key"：翻译子元素，父模板中用 {some.key} 占位；
 * - data-i18n="[name]"：不翻译子元素，父模板中用 {name} 占位。
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

      // 跳过 data-i18n="[name]" 的不需要翻译的占位符元素
      if (key.startsWith('[') && key.endsWith(']')) return;

      let params = {};
      const paramsStr = el.getAttribute('data-i18n-params');
      if (paramsStr) {
        try {
          params = JSON.parse(paramsStr) || {};
        } catch (_) {
          logWarn(t('logger.context.invalidI18nParams', { params: paramsStr }));
        }
      }

      const attr = el.getAttribute('data-i18n-attr');
      if (attr) {
        el.setAttribute(attr, t(key, params));
        return;
      }

      // 收集直接子元素中的 [data-i18n] 占位符并临时移出 DOM。
      // 注意：占位符元素必须在设置 textContent 之前移除，否则会被 textContent 覆盖销毁。
      // 同名占位符全部移出，后续按 token 出现次数用克隆回插。
      const placeholders = new Map();
      Array.from(el.children).forEach((child) => {
        const childKey = child.getAttribute('data-i18n');
        if (!childKey) return;
        let name;
        if (childKey.startsWith('[') && childKey.endsWith(']')) {
          // data-i18n="[name]" - 不需要翻译的占位符
          name = childKey.slice(1, -1);
        } else {
          // data-i18n="some.key" - 需要翻译的占位符，key 即占位符名
          name = childKey;
        }
        if (!placeholders.has(name)) {
          placeholders.set(name, []);
        }
        placeholders.get(name).push(child);
        child.remove();
      });

      const skip = new Set(placeholders.keys());
      el.textContent = t(key, params, skip);

      // 还原占位符：同一 token 出现多次时用克隆逐个插入，避免 appendChild 移动同一节点导致文本错位；
      // 翻译中完全缺失 token 时追加到末尾兜底，避免子元素（链接等）被永久丢弃。
      placeholders.forEach((children, name) => {
        const token = `{${name}}`;
        const textNodes = [];
        const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        let node;
        while ((node = walker.nextNode())) {
          if (node.nodeValue.includes(token)) textNodes.push(node);
        }
        let inserted = false;
        let childIndex = 0;
        for (const textNode of textNodes) {
          const parts = textNode.nodeValue.split(token);
          const parent = textNode.parentNode;
          const fragment = document.createDocumentFragment();
          parts.forEach((part, index) => {
            if (index > 0) {
              const child = children[childIndex] || children[0];
              fragment.appendChild(inserted ? child.cloneNode(true) : child);
              inserted = true;
              childIndex++;
            }
            if (part) fragment.appendChild(document.createTextNode(part));
          });
          parent.replaceChild(fragment, textNode);
        }
        if (!inserted) {
          logWarn(t('logger.context.i18nMissingPlaceholder', { token, key: el.getAttribute('data-i18n') }));
          for (const child of children) {
            el.appendChild(child);
          }
        }
      });
    } catch (error) {
      logWarn(error, { key: 'logger.context.i18nApplyError', params: { key: el.getAttribute('data-i18n') } });
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
    if (lang.startsWith('ja')) return 'ja-JP';
    if (lang.startsWith('fr')) return 'fr-FR';
    if (lang.startsWith('ru')) return 'ru-RU';
    if (lang.startsWith('ar')) return 'ar';
    if (lang.startsWith('es')) return 'es-ES';
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
      applyDirection();
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
 * @param {object} [params] 参数替换 {name: value}
 * @returns {string}
 */
export function tOr(key, fallback, params = null) {
  try {
    const value = lookupTranslation(key);
    if (value !== undefined) return interpolate(value, params);
  } catch (error) {
    logWarn(error, { key: 'logger.context.i18nTranslateError', params: { key } });
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
