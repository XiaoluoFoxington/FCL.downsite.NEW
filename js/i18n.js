/**
 * i18n 国际化模块
 *
 * 用法：
 * 1. 在 HTML 元素上添加 data-i18n 属性，值为翻译键名
 * 2. 在 common.js 中 import 并调用 initI18n() 初始化
 * 3. 语言切换时调用 setLanguage(lang)
 *
 * 支持的 data-* 属性：
 *   data-i18n          - 替换元素的 textContent
 *   data-i18n-title    - 替换元素的 title 属性
 *   data-i18n-placeholder - 替换 input 的 placeholder 属性
 *   data-i18n-html     - 替换元素的 innerHTML（谨慎使用）
 *   data-i18n-alt      - 替换 img 的 alt 属性
 */

const STORAGE_KEY = 'fdn-lang';
const FALLBACK_LANG = 'zh-CN';
const SUPPORTED_LANGS = ['zh-CN', 'en-US'];

/** 当前语言 */
let currentLang = FALLBACK_LANG;
/** 缓存翻译表 */
const translations = {};

/**
 * 检测用户首选语言
 * @returns {string}
 */
function detectLanguage() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED_LANGS.includes(stored)) return stored;
  } catch (_) { /* ignore */ }

  const navLang = navigator.language || navigator.userLanguage || '';
  if (navLang.startsWith('zh')) return 'zh-CN';
  return 'en-US';
}

/**
 * 加载指定语言的翻译表
 * @param {string} lang
 * @returns {Promise<object>}
 */
async function loadTranslations(lang) {
  if (translations[lang]) return translations[lang];
  try {
    const resp = await fetch(`/data/i18n/${lang}.json`);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
    translations[lang] = await resp.json();
    return translations[lang];
  } catch (error) {
    console.error(`[i18n] 加载翻译 ${lang} 失败`, error);
    // 尝试加载 fallback
    if (lang !== FALLBACK_LANG) {
      return loadTranslations(FALLBACK_LANG);
    }
    translations[FALLBACK_LANG] = {};
    return {};
  }
}

/**
 * 根据键名获取翻译文本
 * @param {string} key  点号分隔的键名，如 "nav.list"
 * @param {object} [params] 插值参数，如 { name: "FCL" }
 * @returns {string}
 */
export function t(key, params) {
  const table = translations[currentLang] || translations[FALLBACK_LANG] || {};
  const value = key.split('.').reduce((obj, k) => obj?.[k], table);
  if (value === undefined) {
    console.warn(`[i18n] 缺失翻译键: ${key}`);
    return key;
  }
  if (params && typeof value === 'string') {
    return value.replace(/\{(\w+)\}/g, (_, k) => params[k] ?? `{${k}}`);
  }
  return value;
}

/**
 * 翻译页面中所有带有 data-i18n 属性的元素
 */
export function translatePage() {
  document.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const text = t(key);
    if (text !== key) el.textContent = text;
  });

  document.querySelectorAll('[data-i18n-title]').forEach((el) => {
    const key = el.getAttribute('data-i18n-title');
    const text = t(key);
    if (text !== key) el.setAttribute('title', text);
  });

  document.querySelectorAll('[data-i18n-placeholder]').forEach((el) => {
    const key = el.getAttribute('data-i18n-placeholder');
    const text = t(key);
    if (text !== key) el.setAttribute('placeholder', text);
  });

  document.querySelectorAll('[data-i18n-html]').forEach((el) => {
    const key = el.getAttribute('data-i18n-html');
    const text = t(key);
    if (text !== key) el.innerHTML = text;
  });

  document.querySelectorAll('[data-i18n-alt]').forEach((el) => {
    const key = el.getAttribute('data-i18n-alt');
    const text = t(key);
    if (text !== key) el.setAttribute('alt', text);
  });
}

/**
 * 获取当前语言代码
 * @returns {string}
 */
export function getCurrentLang() {
  return currentLang;
}

/**
 * 获取支持的语言列表
 * @returns {string[]}
 */
export function getSupportedLangs() {
  return [...SUPPORTED_LANGS];
}

/**
 * 切换语言并刷新页面翻译
 * @param {string} lang
 */
export async function setLanguage(lang) {
  if (!SUPPORTED_LANGS.includes(lang)) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch (_) { /* ignore */ }
  document.documentElement.lang = lang;
  await loadTranslations(lang);
  translatePage();
  // 触发自定义事件，让其他模块可以监听语言变化
  document.dispatchEvent(new CustomEvent('i18n:changed', { detail: { lang } }));
}

/**
 * 初始化 i18n 模块
 * @returns {Promise<void>}
 */
export async function initI18n() {
  const lang = detectLanguage();
  currentLang = lang;
  document.documentElement.lang = lang;
  await loadTranslations(lang);
  translatePage();
}