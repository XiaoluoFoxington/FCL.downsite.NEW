import { t } from '../common/i18n.js';

/** 条件之间的关系选项：值与筛选表达式中的关系符号一致。 */
const RELATION_OPTIONS = [
  { value: '&', labelKey: 'common.relationAnd' },
  { value: '|', labelKey: 'common.relationOr' },
  { value: '!', labelKey: 'common.relationNot' },
];

/** 可筛选的键。 */
const KEY_OPTIONS = [
  { value: 'name', labelKey: 'list.filterVisualKeyName' },
  { value: 'tag', labelKey: 'list.filterVisualKeyTag' },
];

/**
 * 创建筛选条件可视化编辑器。
 * 条件行的增删改会通过 onChange 回传完整条件数组；外部调用 setConditions 可重置条件行。
 * 控件全部使用 MDUI 组件，条件行放在 MDUI 表格中保证列对齐，不额外定义视觉样式。
 * @param {{
 *   container: HTMLElement,
 *   rows: HTMLElement,
 *   addButton: HTMLElement,
 *   clearButton: HTMLElement,
 *   tagList: HTMLDataListElement,
 *   onChange: (conditions: Array<{rel: (string|null), key: string, value: string}>) => void,
 * }} elements
 */
export function createFilterEditorView(elements) {
  const { container, rows, addButton, clearButton, tagList, onChange } = elements;
  if (!container || !rows || !addButton) {
    return { setConditions() {}, setTags() {} };
  }

  const tagListId = tagList?.id || '';
  let current = [];

  /** 读取 DOM 中的条件行。首行没有关系下拉，关系固定为 null。 */
  function collect() {
    return Array.from(rows.querySelectorAll('[data-filter-row]')).map((row) => {
      const relation = row.querySelector('[data-filter-relation]');
      return {
        rel: relation ? relation.value || null : null,
        key: row.querySelector('[data-filter-key]').value,
        value: row.querySelector('[data-filter-value]').value,
      };
    });
  }

  /** 没有条件行时禁用清空按钮。 */
  function syncClearButton() {
    if (clearButton) clearButton.disabled = !current.length;
  }

  /** 条件行变化后收集并回传条件数组。 */
  function emit() {
    current = collect();
    syncClearButton();
    onChange(current);
  }

  /** 根据条件键切换值输入框的标签候选列表。 */
  function syncTagList(row) {
    const keySelect = row.querySelector('[data-filter-key]');
    const valueInput = row.querySelector('[data-filter-value]');
    if (tagListId && keySelect.value === 'tag') {
      valueInput.setAttribute('list', tagListId);
    } else {
      valueInput.removeAttribute('list');
    }
  }

  /** 创建一个 MDUI 下拉框，原生 select 上带 data 标记供后续读取与事件委托使用。 */
  function createSelect(dataAttr, ariaLabel) {
    const select = document.createElement('select');
    select.className = 'mdui-select mdui-block';
    select.dataset[dataAttr] = '';
    select.setAttribute('aria-label', ariaLabel);
    return select;
  }

  /** 创建一个表格单元格。 */
  function createCell() {
    return document.createElement('td');
  }

  /** 创建一行条件编辑器：关系 / 键 / 值 / 删除，放在表格行中保证各列对齐。 */
  function createRow(condition, index) {
    const row = document.createElement('tr');
    row.dataset.filterRow = '';

    // 关系列：首个条件没有关系前缀，用排版说明代替下拉。
    const relationCell = createCell();
    if (index === 0) {
      const first = document.createElement('span');
      first.className = 'mdui-typo-caption';
      first.textContent = t('list.filterVisualFirst');
      relationCell.appendChild(first);
    } else {
      const relation = createSelect('filterRelation', t('list.filterVisualRelation'));
      RELATION_OPTIONS.forEach(({ value, labelKey }) => {
        relation.add(new Option(`${value} ${t(labelKey)}`, value));
      });
      relation.value = condition.rel || '&';
      relationCell.appendChild(relation);
    }

    // 键列。
    const keyCell = createCell();
    const key = createSelect('filterKey', t('list.filterVisualKey'));
    KEY_OPTIONS.forEach(({ value, labelKey }) => {
      key.add(new Option(`${t(labelKey)} (${value})`, value));
    });
    key.value = condition.key;
    keyCell.appendChild(key);

    // 值列：MDUI 文本框。
    const valueCell = createCell();
    const field = document.createElement('div');
    field.className = 'mdui-textfield';
    const value = document.createElement('input');
    value.className = 'mdui-textfield-input';
    value.type = 'text';
    value.dataset.filterValue = '';
    value.value = condition.value;
    value.placeholder = t('list.filterVisualValuePlaceholder');
    value.setAttribute('aria-label', t('list.filterVisualValue'));
    field.appendChild(value);
    valueCell.appendChild(field);

    // 删除列。
    const removeCell = createCell();
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'mdui-btn mdui-btn-icon mdui-ripple';
    remove.dataset.filterRemove = '';
    remove.setAttribute('aria-label', t('list.filterVisualRemove'));
    remove.title = t('list.filterVisualRemove');
    const icon = document.createElement('i');
    icon.className = 'mdui-icon material-icons';
    icon.setAttribute('aria-hidden', 'true');
    icon.textContent = 'delete';
    remove.appendChild(icon);
    removeCell.appendChild(remove);

    row.append(relationCell, keyCell, valueCell, removeCell);
    syncTagList(row);
    return row;
  }

  /** 重绘全部条件行；没有条件时显示空态提示。 */
  function render() {
    if (!current.length) {
      const emptyRow = document.createElement('tr');
      const emptyCell = createCell();
      emptyCell.colSpan = 4;
      emptyCell.className = 'description';
      emptyCell.textContent = t('list.filterVisualEmpty');
      emptyRow.appendChild(emptyCell);
      rows.replaceChildren(emptyRow);
      syncClearButton();
      return;
    }
    const fragment = document.createDocumentFragment();
    current.forEach((condition, index) => fragment.appendChild(createRow(condition, index)));
    rows.replaceChildren(fragment);
    // 行内是动态插入的 MDUI 下拉框，必须在插入文档后初始化。
    window.mdui?.mutation();
    syncClearButton();
  }

  /** 用外部解析出的条件刷新编辑器。 */
  function setConditions(conditions) {
    current = (Array.isArray(conditions) ? conditions : []).map((condition, index) => ({
      rel: index === 0 ? null : (condition.rel || '&'),
      key: condition.key === 'tag' ? 'tag' : 'name',
      value: String(condition.value ?? ''),
    }));
    render();
  }

  /** 更新值输入框的标签候选列表。 */
  function setTags(tags) {
    if (!tagList) return;
    const fragment = document.createDocumentFragment();
    (Array.isArray(tags) ? tags : []).forEach((name) => {
      const option = document.createElement('option');
      option.value = String(name);
      fragment.appendChild(option);
    });
    tagList.replaceChildren(fragment);
  }

  // 值输入：输入即回传，实时刷新列表。
  rows.addEventListener('input', (event) => {
    if (event.target.matches('[data-filter-value]')) emit();
  });

  // 键/关系变更：键变化时同步标签候选列表。
  rows.addEventListener('change', (event) => {
    if (event.target.matches('[data-filter-key]')) {
      syncTagList(event.target.closest('[data-filter-row]'));
      emit();
    } else if (event.target.matches('[data-filter-relation]')) {
      emit();
    }
  });

  // 删除条件：重绘让剩余首行恢复为无关系前缀。
  rows.addEventListener('click', (event) => {
    const button = event.target.closest('[data-filter-remove]');
    if (!button) return;
    const row = button.closest('[data-filter-row]');
    const index = Array.from(rows.querySelectorAll('[data-filter-row]')).indexOf(row);
    current = collect();
    current.splice(index, 1);
    render();
    emit();
  });

  // 添加条件：追加一个空值条件并聚焦，填写后才参与筛选。
  addButton.addEventListener('click', () => {
    current = collect();
    current.push({ rel: '&', key: 'name', value: '' });
    render();
    const inputs = rows.querySelectorAll('[data-filter-value]');
    inputs[inputs.length - 1]?.focus();
  });

  // 清空全部条件。
  clearButton?.addEventListener('click', () => {
    current = [];
    render();
    emit();
  });

  render();

  return { setConditions, setTags };
}
