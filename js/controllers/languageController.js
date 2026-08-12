import {
  getSupportedLanguages,
  getLanguageOrder,
  setLanguageOrder,
  LANGUAGE_PACKS,
  t,
} from '../common/i18n.js';
import { showSnackbar } from '../views/uiComponents.js';
import { debounce } from '../views/commonView.js';
import { createSortableTable } from '../views/sortableTable.js';
import { createRow, createColumns, createComparisonTable } from '../views/languageView.js';

/**
 * 语言设置页 controller。
 * 构建语言顺序表格，重排后立即保存语言优先级并实时生效。
 * elements.listContainer 为语言列表挂载点。
 */
export function createLanguageController(elements) {
  let sortable = null;

  // 保存提示防抖：连续排序时只弹最后一次，避免 Toast 堆叠。
  const debouncedSavedToast = debounce(() => {
    showSnackbar(t('language.saved'));
  }, 500);

  function load() {
    const order = getLanguageOrder();
    const supported = getSupportedLanguages();
    // 按用户顺序排列，未出现在顺序里的语言（理论不会发生）补到末尾。
    const sorted = [
      ...order.map((code) => supported.find((lang) => lang.code === code)).filter(Boolean),
      ...supported.filter((lang) => !order.includes(lang.code)),
    ];
    sortable = createSortableTable(elements.listContainer, {
      columns: createColumns(),
      items: sorted,
      renderRow: (lang, index) => createRow(lang, index, sorted.length, (from, to) => sortable?.move(from, to)),
      onReorder: (nextItems) => {
        setLanguageOrder(nextItems.map((lang) => lang.code), { reload: false });
        debouncedSavedToast();
      },
    });
  }

  // ========== 语言比较表 ==========

  /**
   * 将嵌套语言包扁平化为 key → value 映射。
   * 键路径用点号分隔；键段本身含点号时用反斜杠转义。
   * @param {object} pack 语言包
   * @param {string} prefix 当前键前缀
   * @returns {Object<string, string>}
   */
  function flattenPack(pack, prefix = '') {
    const result = {};
    for (const key of Object.keys(pack)) {
      const value = pack[key];
      const fullKey = prefix ? `${prefix}.${escapeKey(key)}` : escapeKey(key);
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        Object.assign(result, flattenPack(value, fullKey));
      } else if (typeof value === 'string') {
        result[fullKey] = value;
      }
    }
    return result;
  }

  /** 转义键段中的点号与反斜杠，与 i18n.js 中 escapeKeySegment 逻辑一致。 */
  // TODO: 一致？那就导出然后复用啊
  function escapeKey(name) {
    return String(name).replace(/\\/g, '\\\\').replace(/\./g, '\\.');
  }

  /**
   * 将扁平化的 key → value 还原为嵌套对象（用于生成新语言包）。
   * @param {Object<string, string>} flat 扁平映射
   * @returns {object}
   */
  function unflattenToPack(flat) {
    const root = {};
    for (const [rawKey, value] of Object.entries(flat)) {
      const parts = [];
      let current = '';
      let escaped = false;
      for (const ch of rawKey) {
        if (escaped) {
          current += ch;
          escaped = false;
        } else if (ch === '\\') {
          escaped = true;
        } else if (ch === '.') {
          parts.push(current);
          current = '';
        } else {
          current += ch;
        }
      }
      parts.push(current);
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        if (!node[parts[i]]) node[parts[i]] = {};
        node = node[parts[i]];
      }
      node[parts[parts.length - 1]] = value;
    }
    return root;
  }

  /** 触发浏览器下载文件。 */
  function downloadFile(filename, content) {
    const blob = new Blob([content], { type: 'application/javascript;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  }

  /** 下载已有语言包（从 LANGUAGE_PACKS 重建 JS 文件）。 */
  function downloadExistingPack(code) {
    const pack = LANGUAGE_PACKS[code];
    if (!pack) {
      showSnackbar(t('language.tableDownloadFail'));
      return;
    }
    try {
      const json = JSON.stringify(pack, null, 2);
      const content = `const ${code.replace(/-/g, '_')} = ${json};\nexport default ${code.replace(/-/g, '_')};\n`;
      const filename = `${code}.js`;
      downloadFile(filename, content);
      showSnackbar(t('language.tableDownloadSuccess', { file: filename }));
    } catch (_) {
      showSnackbar(t('language.tableDownloadFail'));
    }
  }

  /** 新语言包代码有效性校验：只允许字母、数字、连字符。 */
  function isValidCode(code) {
    return /^[a-zA-Z][a-zA-Z0-9-]*$/.test(code);
  }

  /** 下载新语言列生成的语言包。 */
  function downloadNewPack(code, flatValues) {
    if (!code || !isValidCode(code)) {
      showSnackbar(t('language.tableNewLangCodeInvalid'));
      return;
    }
    if (Object.keys(flatValues).length === 0) {
      showSnackbar(t('language.tableDownloadFail'));
      return;
    }
    try {
      const pack = unflattenToPack(flatValues);
      const json = JSON.stringify(pack, null, 2);
      const safeName = code.replace(/-/g, '_');
      const content = `const ${safeName} = ${json};\nexport default ${safeName};\n`;
      const filename = `${code}.js`;
      downloadFile(filename, content);
      showSnackbar(t('language.tableDownloadSuccess', { file: filename }));
    } catch (_) {
      showSnackbar(t('language.tableDownloadFail'));
    }
  }

  /**
   * 加载并渲染语言比较表。
   * 点击加载按钮后调用：遍历所有语言包的键，扁平化后渲染为可编辑表格。
   */
  function loadTable() {
    const container = elements.compareContainer;
    if (!container) return;

    const languages = getSupportedLanguages();
    const flatPacks = languages.map((lang) => ({
      code: lang.code,
      flat: flattenPack(LANGUAGE_PACKS[lang.code]),
    }));

    // 合并所有语言的键（按第一个语言包的键顺序，其余补到末尾）。
    const allKeys = [...new Set(flatPacks.flatMap((p) => Object.keys(p.flat)))];

    const rows = allKeys.map((key) => ({
      key,
      values: Object.fromEntries(flatPacks.map((p) => [p.code, p.flat[key] ?? undefined])),
    }));

    const table = createComparisonTable(container, {
      languages,
      rows,
      onDownload: (code) => downloadExistingPack(code),
    });

    // 绑定新语言列下载按钮：收集新列输入，生成语言包。
    table.newDownloadBtn.addEventListener('click', () => {
      const code = table.newCodeInput.value.trim();
      const flat = table.collectNewColumn();
      downloadNewPack(code, flat);
    });
  }

  return { load, loadTable };
}