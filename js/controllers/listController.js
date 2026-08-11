import { readPreference } from '../domain/preferences.js';
import { getSoftwareCatalog, getTags } from '../repositories/siteRepository.js';
import { debounce } from '../views/commonView.js';
import { renderFilterTags, renderListError, renderListLoading, renderSoftwareList, setFilterIndicator } from '../views/listView.js';
import { logError } from '../common/logger.js';
import { t } from '../common/i18n.js';

/**
 * 资源列表 controller。
 * elements.tags：标签按钮挂载点；elements.list：软件卡片挂载点；
 * elements.search：搜索输入框；elements.searchTagRelation：搜索词与标签的关系（与/或/非）；
 * elements.tagTagRelation：标签之间的关系（与/或）。它们均来自 list.html 的固定 ID/类名。
 */
export function createListController(elements) {
  // 筛选状态保存在 controller，view 每次只接收已经过滤好的纯数据。
  let catalog = [];
  let tagMap = new Map();
  let activeTagIds = new Set();
  let searchText = '';
  // 读取用户设置的默认打开方式，未设置时默认为详情页。
  let openMethod = readPreference('fdn-default-open-method') || 'detail';

  function applyFilters() {
    // 搜索同时匹配名称和数字 ID；标签按 tagTagRelation 决定与/或，
    // 搜索词与标签按 searchTagRelation 决定与/或/非。仅一侧生效时关系不参与组合。
    const normalizedSearch = searchText.trim().toLowerCase();
    const searchActive = !!normalizedSearch;
    const tagsActive = !!activeTagIds.size;
    const tagTagRelation = elements.tagTagRelation?.value || 'and';
    const searchTagRelation = elements.searchTagRelation?.value || 'and';

    const visible = catalog.filter((item) => {
      // tagIds 在目录中是数字，按钮 dataset 始终是字符串，所以比较前统一转字符串。
      const matchesSearch = !searchActive
        || item.name.toLowerCase().includes(normalizedSearch)
        || String(item.id).includes(normalizedSearch);
      const matchesTags = !tagsActive
        || (tagTagRelation === 'or'
          ? [...activeTagIds].some((selectedId) => item.tagIds.some((tagId) => String(tagId) === selectedId))
          : [...activeTagIds].every((selectedId) => item.tagIds.some((tagId) => String(tagId) === selectedId)));
      // 仅一侧筛选生效时直接取该侧结果；两侧同时生效时按 searchTagRelation 组合。
      if (!searchActive || !tagsActive) return matchesSearch && matchesTags;
      if (searchTagRelation === 'or') return matchesSearch || matchesTags;
      if (searchTagRelation === 'not') return matchesSearch && !matchesTags;
      return matchesSearch && matchesTags;
    });
    // 关系下拉框只决定组合方式，本身不算筛选条件；只有搜索词或选中标签存在时才亮起图标。
    setFilterIndicator(elements.filterIndicatorOn, elements.filterIndicatorOff, searchActive || tagsActive);
    renderSoftwareList(elements.list, visible, tagMap, openMethod);
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
      renderFilterTags(elements.tags, tags, (ids) => {
        activeTagIds = ids;
        applyFilters();
      });
      applyFilters();
    } catch (error) {
      logError(error, '资源列表');
      renderListError(elements, error, load);
    }
  }

  // 搜索输入框使用防抖，其他筛选条件（标签、关系下拉）立即响应
  const debouncedApply = debounce(applyFilters);
  elements.search.addEventListener('input', () => {
    searchText = elements.search.value;
    debouncedApply();
  });
  elements.searchTagRelation?.addEventListener('change', applyFilters);
  elements.tagTagRelation?.addEventListener('change', applyFilters);
  return { load };
}
