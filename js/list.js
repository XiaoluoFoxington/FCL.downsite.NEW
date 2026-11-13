import { createListController } from './controllers/listController.js';

/**
 * 列表页入口。可视化筛选编辑器、列表容器与筛选指示图标均交给 controller，
 * 页面脚本本身不保存目录、标签或筛选状态。
 */
// 资源列表所有筛选状态由 controller 保存，避免在 DOM dataset 中保存业务状态。
document.addEventListener('DOMContentLoaded', () => {
  const controller = createListController({
    list: document.getElementById('list-content'),
    filterVisualEditor: document.getElementById('filter-visual-editor'),
    filterVisualRows: document.getElementById('filter-visual-rows'),
    filterVisualAdd: document.getElementById('filter-visual-add'),
    filterVisualClear: document.getElementById('filter-visual-clear'),
    filterVisualTagList: document.getElementById('filter-visual-tag-list'),
    filterIndicatorOn: document.getElementById('filter-active-indicator-on'),
    filterIndicatorOff: document.getElementById('filter-active-indicator-off'),
    refreshButton: document.getElementById('list-action-refresh'),
    clearBookmarksButton: document.getElementById('list-action-clear-bookmarks'),
    restoreBookmarksButton: document.getElementById('list-action-restore-bookmarks'),
  });
  controller.load();
});
