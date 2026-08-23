import { readPreference } from '../domain/preferences.js';
import { getSoftwareCatalog, getTags } from '../repositories/siteRepository.js';
import { debounce, setFilterIndicator } from '../views/commonView.js';
import { enableFilterHelpInserts, renderFilterHelpTags, renderListError, renderListLoading, renderSoftwareList } from '../views/listView.js';
import { logError } from '../common/logger.js';
import { t } from '../common/i18n.js';

/** 条件之间的关系符号。 */
const RELATION_CHARS = '&|!';

/**
 * 解析筛选表达式为条件数组。
 * 单个条件格式：关系 + 键 + ": " + 值；关系（& 与 / | 或 / ! 非）在首个条件上可省略，
 * 其余条件必须以关系开头。值内出现关系符号时必须用反斜杠转义（\& \| \!）。
 * 例：`name: fold & tag: mc\!je` → [{ rel: null, key: 'name', value: 'fold' },
 *                                   { rel: '&', key: 'tag', value: 'mc!je' }]
 * @param {string} input 用户输入的筛选表达式
 * @returns {Array<{rel: (string|null), key: string, value: string}>|null}
 *   空输入返回空数组；表达式非法返回 null（调用方应提示用户而不应用筛选）。
 */
export function parseFilterExpression(input) {
  const s = input.trim();
  if (!s) return [];
  const conditions = [];
  let i = 0;
  let needRelation = false;

  while (i < s.length) {
    // 跳过分隔空白
    while (i < s.length && /\s/.test(s[i])) i++;
    if (i >= s.length) break;

    // 可选的关系前缀（首个条件省略时为 null）
    let rel = null;
    if (RELATION_CHARS.includes(s[i])) {
      rel = s[i];
      i++;
      while (i < s.length && /\s/.test(s[i])) i++;
      if (i >= s.length) return null; // 关系后面没有条件
    } else if (needRelation) {
      return null; // 条件之间必须用关系连接
    }

    // 键：直到冒号
    const keyStart = i;
    while (i < s.length && s[i] !== ':') i++;
    if (i >= s.length) return null; // 缺少冒号
    const key = s.slice(keyStart, i).trim();
    i++; // 跳过冒号
    if (i < s.length && s[i] === ' ') i++; // 允许 ": " 或 ":"

    if (key !== 'name' && key !== 'tag') return null;

    // 值：直到未转义的关系符号或字符串结束
    let value = '';
    while (i < s.length) {
      const c = s[i];
      if (c === '\\' && i + 1 < s.length && RELATION_CHARS.includes(s[i + 1])) {
        value += s[i + 1];
        i += 2;
        continue;
      }
      if (RELATION_CHARS.includes(c)) break;
      value += c;
      i++;
    }
    value = value.trim();
    if (!value) return null; // 值不能为空

    conditions.push({ rel, key, value: value.toLowerCase() });
    needRelation = true;
  }
  return conditions;
}

/**
 * 资源列表 controller。
 * elements.search：筛选表达式输入框；elements.filterField：输入框外层（用于错误态）；
 * elements.filterHelp：筛选帮助面板（可点击文本插入输入框）；elements.list：软件卡片挂载点。
 * 它们均来自 list.html 的固定 ID/类名。
 */
export function createListController(elements) {
  // 筛选状态保存在 controller，view 每次只接收已经过滤好的纯数据。
  let catalog = [];
  let tagMap = new Map();
  // 已解析的筛选条件，空数组代表无筛选。
  let conditions = [];
  // 读取用户设置的默认打开方式，未设置时默认为详情页。
  let openMethod = readPreference('fdn-default-open-method') || 'detail';

  /** 单个条件是否命中某软件：name 匹配名称，tag 匹配任意标签名（均忽略大小写）。 */
  function matchesCondition(item, condition) {
    if (condition.key === 'name') {
      return item.name.toLowerCase().includes(condition.value);
    }
    return item.tagIds.some((tagId) => (tagMap.get(tagId) || '').toLowerCase().includes(condition.value));
  }

  function applyFilters() {
    // 条件按书写顺序从左到右组合：首个条件直接生效，& 与、| 或、! 非 依次作用于累计结果。
    const filterActive = conditions.length > 0;
    const visible = catalog.filter((item) => {
      let acc = null;
      for (const condition of conditions) {
        const matched = matchesCondition(item, condition);
        if (condition.rel === null || condition.rel === '&') {
          acc = acc === null ? matched : acc && matched;
        } else if (condition.rel === '|') {
          acc = acc === null ? matched : acc || matched;
        } else { // '!'
          acc = acc === null ? !matched : acc && !matched;
        }
      }
      return acc === null ? true : acc;
    });
    setFilterIndicator(elements.filterIndicatorOn, elements.filterIndicatorOff, filterActive);
    renderSoftwareList(elements.list, visible, tagMap, openMethod);
  }

  /** 表达式非法时点亮错误提示，合法或为空时恢复。 */
  function setFilterError(invalid) {
    elements.filterField?.classList.toggle('mdui-textfield-invalid', invalid);
  }

  async function load() {
    renderListLoading(elements);
    try {
      // 目录与标签无依赖关系，列表页首屏固定为两次并行静态请求。
      const [software, tags] = await Promise.all([getSoftwareCatalog(), getTags()]);
      const knownTags = new Set(tags.map((tag) => tag.id));
      software.forEach((item) => item.tagIds.forEach((id) => {
        if (!knownTags.has(id)) throw new Error(t('common.repository.unknownTag', { itemId: item.id, id }));
      }));
      catalog = software;
      tagMap = new Map(tags.map((tag) => [tag.id, tag.name]));
      // 把全部可用标签列进筛选帮助面板，点击即可插入 tag: <标签名>。
      renderFilterHelpTags(elements.filterHelpTags, tags);
      applyFilters();
    } catch (error) {
      logError(error, '资源列表');
      renderListError(elements, error, load);
    }
  }

  // 筛选表达式输入使用防抖，边输入边解析，非法时不应用筛选并提示。
  const debouncedApply = debounce(() => {
    conditions = parseFilterExpression(elements.search.value);
    setFilterError(conditions === null);
    if (conditions === null) conditions = [];
    applyFilters();
  });
  elements.search.addEventListener('input', debouncedApply);
  // 帮助面板中的可点击文本（示例/关系/键/转义）点击后插入到筛选输入框。
  enableFilterHelpInserts(elements.filterHelp, elements.search);
  return { load };
}
