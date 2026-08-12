import {
  getSupportedLanguages,
  getLanguageOrder,
  setLanguageOrder,
  t,
} from '../common/i18n.js';
import { showSnackbar } from '../views/uiComponents.js';
import { debounce } from '../views/commonView.js';
import { createSortableTable } from '../views/sortableTable.js';
import { createRow, createColumns } from '../views/languageView.js';

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

  return { load };
}
