import { createListController } from './controllers/listController.js';

/**
 * 列表页入口。tags/list/search 以及两个关系下拉框均交给 controller，
 * 页面脚本本身不保存目录、标签或筛选状态。
 */
// 资源列表所有筛选状态由 controller 保存，避免在 DOM dataset 中保存业务状态。
document.addEventListener('DOMContentLoaded', () => {
  const controller = createListController({
    tags: document.getElementById('filter-tag'),
    list: document.getElementById('list-content'),
    search: document.querySelector('.mdui-textfield-input'),
    searchTagRelation: document.getElementById('relation-between-searchWord-and-tag'),
    tagTagRelation: document.getElementById('relation-between-tag-and-tag'),
    filterIndicatorOn: document.getElementById('filter-active-indicator-on'),
    filterIndicatorOff: document.getElementById('filter-active-indicator-off'),
  });
  controller.load();
});
