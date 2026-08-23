/**
 * 下载表格筛选模块。
 * 所有筛选逻辑集中在这里处理：类别定义、文件归类、可见性计算。
 * 视图只负责渲染勾选框并把用户的选择传回来，与选择器的自动选择模块
 * （autoSelect.js）一样，调用方无需关心筛选策略的细节。
 *
 * 类别（按优先级从高到低）：
 * - dataSource：命中数据源配置的 URL 正则白名单（detail.json 的 filter，如 ".apk"）；
 * - system：命中当前系统安装包扩展名白名单（如 Windows 的 exe/msi）；
 * - archive：压缩包（zip、7z）；
 * - source：源码包（tar.gz、tar.xz、tgz、txz）。
 *
 * 可见性按优先级管线计算，与 autoSelect.js 的步骤管道同构：
 * 每个勾选的类别从"上一个筛剩下的"文件中领取自己的命中项，未命中则继续传给下一个；
 * 文件被第一个（优先级最高）勾选类别命中即显示，未被任何勾选类别命中的文件隐藏。
 * "显示全部"优先级最高，勾选时直接领取全部文件；它与类别勾选互斥，
 * 该互斥由视图维护，本模块只负责按 state 判定可见性。
 *
 * 首屏默认勾选"数据源"与"当前系统"（如可用），压缩包/源码包默认隐藏；
 * 两者都不可用时回退为勾选"显示全部"，避免首屏被筛成空表。
 */

import { logWarn } from '../common/logger.js';

/** 压缩包扩展名（不含点，小写）。 */
export const ARCHIVE_EXTENSIONS = ['zip', '7z'];

/** 源码包扩展名（不含点，小写；tar.gz 等复合扩展名整体匹配）。 */
export const SOURCE_EXTENSIONS = ['tar.gz', 'tar.xz', 'tgz', 'txz'];

/** 类别的优先级顺序（从高到低）；"显示全部"隐含为最高优先级，先于所有类别。 */
const CATEGORY_ORDER = ['dataSource', 'system', 'archive', 'source'];

/**
 * 判断下载 URL 是否命中扩展名列表。
 * 只比较 URL 路径部分的文件扩展名（大小写不敏感），支持 tar.gz 等复合扩展名。
 * @param {string} url 下载地址
 * @param {Array<string>} extensions 扩展名列表（不含点，小写）
 * @returns {boolean} 命中返回 true
 */
function matchesExtensions(url, extensions) {
  try {
    const pathname = new URL(url, window.location.href).pathname.toLowerCase();
    return extensions.some((ext) => pathname.endsWith(`.${ext.toLowerCase()}`));
  } catch (_) {
    return false;
  }
}

/**
 * 构建筛选配置：类别列表（含标签、是否启用与默认勾选）、
 * 默认勾选状态、文件归类函数与可见性判定。
 * @param {object} [options]
 * @param {Array<string>} [options.filter] 数据源配置的 URL 正则白名单（detail.json 的 filter）
 * @param {Array<string>} [options.osExtensions] 当前系统安装包扩展名白名单（不含点，小写）
 * @param {string} [options.osName] 当前系统显示名（UAParser os.name，如 "Windows"）
 * @returns {{categories: Array<{key: string, label: string, enabled: boolean, defaultChecked: boolean}>, createDefaultState: () => {showAll: boolean, checked: Record<string, boolean>}, classify: (item: object) => Set<string>, isVisible: (categoryKeys: Set<string>, state: object) => boolean}}
 */
export function createFilterConfig({ filter, osExtensions = [], osName = '' } = {}) {
  const patterns = Array.isArray(filter)
    ? filter.filter((pattern) => typeof pattern === 'string' && pattern)
    : [];
  const systemExtensions = osExtensions.map((ext) => ext.toLowerCase());
  // 类别顺序即面板中勾选框的展示顺序，也即优先级顺序；enabled 为 false 的类别在面板中不渲染。
  // defaultChecked 为 true 的类别在首屏默认勾选。
  const categories = [
    {
      key: 'dataSource',
      label: `数据源中筛选条件（${patterns.join(', ') || '无'}）`,
      enabled: patterns.length > 0,
      defaultChecked: true,
    },
    {
      key: 'system',
      label: `当前系统（${osName}）筛选条件（${systemExtensions.map((ext) => `.${ext}`).join(', ') || '无'}）`,
      enabled: systemExtensions.length > 0,
      defaultChecked: true,
    },
    {
      key: 'archive',
      label: `压缩包（${ARCHIVE_EXTENSIONS.map((ext) => `.${ext}`).join(', ')}）`,
      enabled: true,
      defaultChecked: false,
    },
    {
      key: 'source',
      label: `源码包（${SOURCE_EXTENSIONS.map((ext) => `.${ext}`).join(', ')}）`,
      enabled: true,
      defaultChecked: false,
    },
  ];

  /**
   * 生成首屏默认勾选状态：默认勾选"数据源"与"当前系统"（如可用）。
   * 两者都不可用时（如无法识别系统且数据源未配置筛选）回退为勾选"显示全部"，
   * 避免首屏被筛成空表。
   * @returns {{showAll: boolean, checked: Record<string, boolean>}} 默认勾选状态
   */
  function createDefaultState() {
    const checked = {};
    let defaultCheckedCount = 0;
    for (const category of categories) {
      if (!category.enabled) continue;
      checked[category.key] = category.defaultChecked;
      if (category.defaultChecked) defaultCheckedCount += 1;
    }
    return { showAll: defaultCheckedCount === 0, checked };
  }

  /**
   * 判定下载项命中的类别。
   * @param {{downloadUrl?: string}} item 统一下载叶子节点
   * @returns {Set<string>} 命中的类别 key 集合（可为多个；全未命中时为空集合）
   */
  function classify(item) {
    const url = item?.downloadUrl || '';
    const keys = new Set();
    // 数据源 filter 是 URL 正则白名单；非法正则必须用 try/catch 防护，避免渲染崩溃。
    if (patterns.some((pattern) => {
      try {
        return new RegExp(pattern).test(url);
      } catch (error) {
        logWarn(error, { key: 'logger.context.invalidFilterRegex', params: { pattern } });
        return false;
      }
    })) keys.add('dataSource');
    if (matchesExtensions(url, systemExtensions)) keys.add('system');
    if (matchesExtensions(url, ARCHIVE_EXTENSIONS)) keys.add('archive');
    if (matchesExtensions(url, SOURCE_EXTENSIONS)) keys.add('source');
    return keys;
  }

  /**
   * 判定下载项在给定勾选状态下是否可见（按优先级管线）。
   * "显示全部"勾选时无条件可见；否则从最高优先级类别开始，
   * 第一个勾选且命中该文件的类别将其领取并显示，未被任何勾选类别领取的文件隐藏。
   * @param {Set<string>} categoryKeys classify 返回的类别集合
   * @param {{showAll: boolean, checked: Record<string, boolean>}} state 勾选状态
   * @returns {boolean} 可见返回 true
   */
  function isVisible(categoryKeys, state) {
    if (state?.showAll) return true;
    for (const key of CATEGORY_ORDER) {
      if (state?.checked?.[key] && categoryKeys.has(key)) return true;
    }
    return false;
  }

  return { categories, createDefaultState, classify, isVisible };
}
