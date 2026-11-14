/**
 * 下载表格筛选模块。
 * 所有筛选逻辑集中在这里处理：类别定义、文件归类、可见性计算。
 * 视图只负责渲染勾选框并把用户的选择传回来，与选择器的自动选择模块
 * （autoSelect.js）一样，调用方无需关心筛选策略的细节。
 *
 * 类别（按优先级从高到低）：
 * - dataSource：命中数据源配置的 URL 正则白名单（detail.json 的 filter，如 "\\.apk$"）；
 * - system：命中当前系统安装包正则（SYSTEM_PATTERNS 按 os.name 取用的一条完整表达式，
 *   如 Windows 的 `\.(?:exe|msi|msix|...)$|(^|[-_.])(?:windows|win)(?![a-z])`）；
 * - archive：压缩包，`\.(?:zip|zipx|7z|rar|tar|gz|bz2|xz|zst|lz4|lzma|cab|iso)$`；
 * - source：源码包，`\.(?:tar\.(?:gz|xz|bz2|zst|lz|lz4|lzma)|tgz|tbz2?|txz|tzst)$`；
 * - developer：开发者产物，扩展名（.sum/.sig/.asc 等）与名称（SHA256SUMS、update.json、
 *   sbom 等）写在同一表达式里。
 *
 * 所有类别的正则都集中在本文件的两张表里（SYSTEM_PATTERNS、CATEGORY_PATTERNS），
 * 每条都是完整表达式，不再跨文件拼装；只有 dataSource 来自 detail.json 的数组，
 * 在入口处用非捕获组合并成一条。面板标签展示的就是实际生效的那一整条，
 * 用户看到什么就匹配什么。
 * 匹配对象是完整的下载 URL（含 query string），不是单独的 pathname。
 * 其中 dataSource 是唯一由站点作者手写的正则，其余四类由本模块生成。
 *
 * 可见性按优先级管线计算，与 autoSelect.js 的步骤管道同构：
 * 每个勾选的类别从"上一个筛剩下的"文件中领取自己的命中项，未命中则继续传给下一个；
 * 文件被第一个（优先级最高）勾选类别命中即显示，未被任何勾选类别命中的文件隐藏。
 * "显示全部"优先级最高，勾选时直接领取全部文件；它与类别勾选互斥，
 * 该互斥由视图维护，本模块只负责按 state 判定可见性。
 *
 * 首屏默认勾选"数据源"与"当前系统"（如可用），压缩包/源码包/开发者产物默认隐藏；
 * 两者都不可用时回退为勾选"显示全部"，避免首屏被筛成空表。
 */

import { logWarn } from '../common/logger.js';
import { t } from '../common/i18n.js';

/**
 * 系统类别的筛选正则。
 * 键为 UAParser os.name 的小写值；值为该平台一条完整的正则表达式，
 * 扩展名结尾与名称中段两类条件都写在这一条里（`|` 分隔）。
 *
 * 表达式按"正则"而非"扩展名"维护，因此既要求文件名以该扩展名结尾（避免 .apk.sha256、
 * .exe.txt 之类被误判），又能直接容纳命中名称中段的写法，例如 windows 的
 * `(^|[-_.])(?:windows|win)(?![a-z])` 能捞起 xxx-windows-v1.2.3.zip 这类含系统名的包。
 * 中段片段的后边界是"不紧跟字母"的负向断言，而非必须是分隔符：win32/win64、linux64、
 * osx64 这类数字粘连命名同样命中，而 winery、swing 这类字母粘连词仍被前/后边界排除。
 * 表达式编译时统一加 i 标志（故 [a-z] 同时挡得住大写），自身不写 ^...$ 全文锚点
 * （由后缀 $ 与片段自带边界控制）。
 *
 * 压缩包/源码包不属于任何系统的原生格式，由 CATEGORY_PATTERNS 单独分类。
 * 鸿蒙的纯血与否按"基线"区分：OpenHarmony 才是纯血鸿蒙，不兼容 Android，只认 .hap
 * （应用安装包）与 .app（应用市场分发格式）；HarmonyOS 是非纯血版本，本质仍是
 * 兼容 Android 的发行版，只认 .apk 系列，不认 .hap/.app。两者名称片段各自独立，
 * 避免纯血包被误归到非纯血版。
 */
const SYSTEM_PATTERNS = {
  android: '\\.(?:apk|apks|xapk|apkm)$|(^|[-_.])android(?![a-z])',
  windows: '\\.(?:exe|msi|msix|appx|appxbundle|msixbundle)$|(^|[-_.])(?:windows|win)(?![a-z])',
  'mac os': '\\.(?:dmg|pkg)$|(^|[-_.])(?:mac|macos|osx|darwin)(?![a-z])',
  linux: '\\.(?:appimage|deb|rpm|flatpak|snap)$|(^|[-_.])linux(?![a-z])',
  harmonyos: '\\.(?:apk|apks|xapk|apkm)$|(^|[-_.])(?:harmonyos|hmos)(?![a-z])',
  openharmony: '\\.(?:hap|app)$|(^|[-_.])openharmony(?![a-z])',
};

/**
 * 类型类别的筛选正则，每个类别一条完整表达式（由 createFilterConfig 统一加 i 标志编译）。
 * - archive：压缩包，覆盖常见归档/压缩容器（含分发的 .tar 与单文件压缩 .gz/.bz2/.xz/.zst 等，
 *   以及光盘镜像 .iso、Windows 安装包容器 .cab）；
 * - source：源码包，覆盖 tar 系列复合扩展名（tar.gz/tar.xz/tar.bz2/tar.zst/tar.lz 等）
 *   与各自的短写法（tgz/txz/tbz2/tzst）；与 archive 的重叠（如 .tar.gz 也是 .gz）是刻意的，
 *   两类都勾选时不会重复显示，只勾选其中一类也能看到它；
 * - developer：开发者产物，含 .sum（GNU 校验和）、.sig/.asc（GPG 签名）、.minisig、
 *   .sha256/.sha512/.md5 等摘要后缀，以及 SHA256SUMS、checksums、md5sums 等摘要文件名、
 *   自动更新清单（update.json、latest.yml、app-update.yml、version-manifest.json）、
 *   供应链清单/证明（sbom、spdx、intoto、sigstore、provenance）。
 */
const CATEGORY_PATTERNS = {
  archive: '\\.(?:zip|zipx|7z|rar|tar|gz|bz2|xz|zst|lz4|lzma|cab|iso)$',
  source: '\\.(?:tar\\.(?:gz|xz|bz2|zst|lz|lz4|lzma)|tgz|tbz2?|txz|tzst)$',
  developer: '\\.(?:sum|sig|asc|minisig|sha1|sha256|sha512|md5)$|(^|[/._-])(?:sha-?(?:1|224|256|384|512)(?:sums?|checksums?)?|checksums?|hashes|md5sums?)([/._-]|$)|(^|[/._-])(?:latest|update|version|manifest|channel)([._-][\\w.-]+)?\\.(?:json|ya?ml)([?#]|$)|app-update\\.ya?ml([?#]|$)|(^|[/._-])(?:sbom|spdx|intoto|sigstore|provenance)([/._-]|\\.|$)',
};

/** 类别的优先级顺序（从高到低）；"显示全部"隐含为最高优先级，先于所有类别。 */
const CATEGORY_ORDER = ['dataSource', 'system', 'archive', 'source', 'developer'];

/**
 * 把多个正则片段合并为一整个正则。
 * 每个片段各自包一层非捕获组，保留片段自带的锚点与边界语义，
 * 因此 `a$` 与 `b$` 合并后仍是"分别以 a / b 结尾"，而不是整条共享锚点。
 * @param {Array<string>} patterns 正则片段列表
 * @returns {string} 单一正则表达式文本（空列表时为空字符串）
 */
function combinePatterns(patterns) {
  return patterns.map((pattern) => `(?:${pattern})`).join('|');
}

/**
 * 编译单一正则（大小写不敏感）。
 * 非法表达式必须 try/catch 防护，返回 null 并记录日志，避免配置错误导致渲染崩溃。
 * @param {string} source 正则表达式文本
 * @returns {RegExp|null} 编译结果，空串或非法表达式返回 null
 */
function compileRegex(source) {
  if (!source) return null;
  try {
    return new RegExp(source, 'i');
  } catch (error) {
    logWarn(error, t('logger.context.invalidFilterRegex', { pattern: source }));
    return null;
  }
}

/**
 * 把用户配置的正则列表合并编译为一整个正则：
 * 逐条校验并丢弃非法表达式（各自记日志），再把剩余片段合并编译，
 * 这样某一条写错不会连累同一类别的其他条件。
 * @param {Array<string>} patterns 正则片段列表
 * @returns {RegExp|null} 编译结果，无有效条件时返回 null
 */
function compilePatternList(patterns) {
  const validPatterns = patterns.filter((pattern) => compileRegex(pattern) !== null);
  return compileRegex(combinePatterns(validPatterns));
}

/**
 * 构建筛选配置：类别列表（含标签、是否启用与默认勾选）、
 * 默认勾选状态、文件归类函数与可见性判定。
 * @param {object} [options]
 * @param {Array<string>} [options.filter] 数据源配置的 URL 正则白名单（detail.json 的 filter）；
 *   手写正则，作用于完整下载 URL，大小写不敏感，非法表达式会被跳过并记录日志
 * @param {string} [options.osName] 当前系统显示名（UAParser os.name，如 "Windows"），
 *   同时用于从 SYSTEM_PATTERNS 取对应的一条正则
 * @returns {{categories: Array<{key: string, label: string, enabled: boolean, defaultChecked: boolean}>, createDefaultState: () => {showAll: boolean, checked: Record<string, boolean>}, classify: (item: object) => Set<string>, isVisible: (categoryKeys: Set<string>, state: object) => boolean}}
 */
export function createFilterConfig({ filter, osName = '' } = {}) {
  const dataSourcePatterns = Array.isArray(filter)
    ? filter.filter((pattern) => typeof pattern === 'string' && pattern)
    : [];
  // 系统类别按 UAParser os.name 的小写值取一条完整正则；未识别系统为空串，不启用该类。
  const systemPattern = SYSTEM_PATTERNS[String(osName || '').toLowerCase()] || '';
  // 每个类别只保留两样东西：展示用的正则文本，以及编译好的那一条 RegExp。
  const dataSourcePattern = combinePatterns(dataSourcePatterns);
  const dataSourceRegex = compilePatternList(dataSourcePatterns);
  const systemRegex = compileRegex(systemPattern);
  const archiveRegex = compileRegex(CATEGORY_PATTERNS.archive);
  const sourceRegex = compileRegex(CATEGORY_PATTERNS.source);
  const developerRegex = compileRegex(CATEGORY_PATTERNS.developer);
  // 类别顺序即面板中勾选框的展示顺序，也即优先级顺序；enabled 为 false 的类别在面板中不渲染。
  // defaultChecked 为 true 的类别在首屏默认勾选。标签展示的就是该类别的整条正则。
  const none = t('common.filterCategory.none');
  const categories = [
    {
      key: 'dataSource',
      label: t('common.filterCategory.dataSource', { items: dataSourcePattern || none }),
      enabled: dataSourcePatterns.length > 0,
      defaultChecked: true,
    },
    {
      key: 'system',
      label: t('common.filterCategory.system', {
        osName,
        items: systemPattern || none,
      }),
      enabled: Boolean(systemPattern),
      defaultChecked: true,
    },
    {
      key: 'archive',
      label: t('common.filterCategory.archive', { items: CATEGORY_PATTERNS.archive }),
      enabled: true,
      defaultChecked: false,
    },
    {
      key: 'source',
      label: t('common.filterCategory.source', { items: CATEGORY_PATTERNS.source }),
      enabled: true,
      defaultChecked: false,
    },
    {
      key: 'developer',
      label: t('common.filterCategory.developer', { items: CATEGORY_PATTERNS.developer }),
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
    if (dataSourceRegex?.test(url)) keys.add('dataSource');
    if (systemRegex?.test(url)) keys.add('system');
    if (archiveRegex?.test(url)) keys.add('archive');
    if (sourceRegex?.test(url)) keys.add('source');
    if (developerRegex?.test(url)) keys.add('developer');
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
