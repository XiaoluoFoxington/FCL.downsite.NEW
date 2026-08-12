import { createLanguageController } from './controllers/languageController.js';

/**
 * 语言设置页入口。
 * 列表顺序即语言优先级：第一位为界面显示语言，其余语言在翻译缺失时按顺序回退。
 * 排序复用可拖拽表格组件（拖拽 + 插入指示线 + 编程式 move），修改后立即保存并实时生效。
 */
document.addEventListener('DOMContentLoaded', () => {
  const listContainer = document.getElementById('language-list');
  const compareContainer = document.getElementById('language-compare');
  const loadBtn = document.getElementById('loadLanguageTableBtn');
  const loadDescription = document.getElementById('loadLanguageDescription');
  if (!listContainer) return;

  const controller = createLanguageController({ listContainer, compareContainer });
  controller.load();

  // 加载语言比较表：点击按钮后渲染表格并隐藏按钮。
  if (loadBtn && compareContainer) {
    loadBtn.addEventListener('click', () => {
      controller.loadTable();
      loadDescription.remove();
    });
  }
});