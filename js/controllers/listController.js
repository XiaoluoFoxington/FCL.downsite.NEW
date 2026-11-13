import { readPreference } from '../domain/preferences.js';
import { clearBookmarks, onBookmarkChange, restoreDefaultBookmarks } from '../domain/bookmarks.js';
import { completeOrphanTags, getSoftwareCatalog, getTags } from '../repositories/siteRepository.js';
import { setFilterIndicator } from '../views/commonView.js';
import { createFilterEditorView } from '../views/filterEditorView.js';
import { refreshBookmarkColumn, renderListError, renderListLoading, renderSoftwareList } from '../views/listView.js';
import { showSnackbar } from '../views/uiComponents.js';
import { clearResponseCache } from '../http/client.js';
import { logError } from '../common/logger.js';
import { t } from '../common/i18n.js';

/**
 * 资源列表 controller。
 * elements.filterVisualRows：可视化编辑器的条件行容器；elements.list：软件卡片挂载点；
 * elements.refreshButton / clearBookmarksButton / restoreBookmarksButton：操作面板按钮。
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

  // 可视化编辑器是筛选条件的唯一来源，条件变化后立即应用到列表。
  const filterEditor = createFilterEditorView({
    container: elements.filterVisualEditor,
    rows: elements.filterVisualRows,
    addButton: elements.filterVisualAdd,
    clearButton: elements.filterVisualClear,
    tagList: elements.filterVisualTagList,
    onChange: applyEditorConditions,
  });

  /**
   * 接收编辑器条件：忽略尚未填写值的行，并让首个有效条件不带关系前缀。
   * 值与匹配逻辑一致地转小写，空数组代表无筛选。
   */
  function applyEditorConditions(next) {
    const usable = next.filter((condition) => condition.value.trim());
    conditions = usable.map((condition, index) => ({
      rel: index === 0 ? null : (condition.rel || '&'),
      key: condition.key === 'tag' ? 'tag' : 'name',
      value: condition.value.trim().toLowerCase(),
    }));
    applyFilters();
  }

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

  /** 加载目录与标签；成功返回 true，失败返回 false（错误界面由 renderListError 呈现）。 */
  async function load() {
    renderListLoading(elements);
    try {
      // 目录与标签无依赖关系，列表页首屏固定为两次并行静态请求。
      const [software, tags] = await Promise.all([getSoftwareCatalog(), getTags()]);
      // 资源引用了不存在的标签 ID 时不崩页面：现场补全为"未知标签-{id}"。
      const references = software.flatMap((item) => item.tagIds.map((id) => ({ itemId: item.id, id })));
      const allTags = completeOrphanTags(tags, references);
      catalog = software;
      tagMap = new Map(allTags.map((tag) => [tag.id, tag.name]));
      // 值输入框使用标签名作为候选，避免用户手记标签名。
      filterEditor.setTags(allTags.map((tag) => tag.name));
      filterEditor.setConditions(conditions);
      applyFilters();
      return true;
    } catch (error) {
      logError(error, t('logger.context.resourceList'));
      renderListError(elements, error, load);
      return false;
    }
  }

  /** 刷新：先失效本页的请求缓存，再重新拉取目录与标签。 */
  async function refreshCatalog() {
    clearResponseCache();
    if (await load()) showSnackbar(t('list.actionRefreshDone'));
  }

  /** 清空收藏；确认后由 onBookmarkChange 统一刷新表格收藏列。 */
  function handleClearBookmarks() {
    if (!window.confirm(t('list.actionClearBookmarksConfirm'))) return;
    clearBookmarks();
    showSnackbar(t('list.actionClearBookmarksDone'));
  }

  /** 还原默认收藏；确认后由 onBookmarkChange 统一刷新表格收藏列。 */
  function handleRestoreDefaultBookmarks() {
    if (!window.confirm(t('list.actionRestoreDefaultBookmarksConfirm'))) return;
    restoreDefaultBookmarks();
    showSnackbar(t('list.actionRestoreDefaultBookmarksDone'));
  }

  // 操作面板按钮：刷新目录、清空收藏、还原默认收藏。
  elements.refreshButton?.addEventListener('click', refreshCatalog);
  elements.clearBookmarksButton?.addEventListener('click', handleClearBookmarks);
  elements.restoreBookmarksButton?.addEventListener('click', handleRestoreDefaultBookmarks);
  // 收藏在表格外被变更时，同步表格收藏列，避免显示与实际状态不一致。
  onBookmarkChange(() => refreshBookmarkColumn(elements.list));
  return { load };
}
