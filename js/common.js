// 每页共用的入口脚本。新增共用 ES Module 请在此处 import。
import './common/a11y.js';
import './common/theme.js';
import './common/drawer.js';
import './common/verWatermaek.js';


// 共用的第三方非 ES Module 脚本，通过动态创建 <script> 元素加载。
// counter.dev 统计：独立运行，不影响站点功能，无需前置加载。
(function () {
  const script = document.createElement('script');
  script.src = 'https://cdn.counter.dev/script.js';
  script.dataset.id = 'e767f9af-c08e-48c9-a440-666584514259';
  script.dataset.utcoffset = '8';
  document.head.appendChild(script);
})();
