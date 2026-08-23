import { createListController } from './controllers/listController.js';

/**
 * 列表页入口。筛选表达式输入框、列表容器与筛选指示图标均交给 controller，
 * 页面脚本本身不保存目录、标签或筛选状态。
 */
// 资源列表所有筛选状态由 controller 保存，避免在 DOM dataset 中保存业务状态。
document.addEventListener('DOMContentLoaded', () => {
  const controller = createListController({
    list: document.getElementById('list-content'),
    search: document.getElementById('filter-expression-field').querySelector('.mdui-textfield-input'),
    filterField: document.getElementById('filter-expression-field'),
    filterHelp: document.getElementById('filter-help-panel-body'),
    filterHelpTags: document.getElementById('filter-help-tags'),
    filterIndicatorOn: document.getElementById('filter-active-indicator-on'),
    filterIndicatorOff: document.getElementById('filter-active-indicator-off'),
  });
  controller.load();
});
