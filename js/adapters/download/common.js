/**
 * 下载适配器共用工具。
 * adapter 的职责是把上游任意结构变为两类节点：
 * 1. 分组节点：{ name, default?, children }；
 * 2. 下载叶子：{ name, version, architecture, size, description, downloadUrl, available, source }。
 */

// 不假设版本一定遵循严格 SemVer；提取连续数字可覆盖常见的 v1.2.3、2024.01 等命名。
const VERSION_NUMBER = /\d+/g;

/**
 * 按版本从新到旧排序，供按版本分组的镜像选择默认项。
 * @param {string|number} left 版本字符串
 * @param {string|number} right 版本字符串
 * @returns {number} 负数表示 left 更新，正数表示 right 更新，0 表示相同
 */
export function compareVersionsDescending(left, right) {
  const leftParts = String(left).match(VERSION_NUMBER)?.map(Number) || [];
  const rightParts = String(right).match(VERSION_NUMBER)?.map(Number) || [];
  for (let index = 0; index < Math.max(leftParts.length, rightParts.length); index += 1) {
    const difference = (rightParts[index] || 0) - (leftParts[index] || 0);
    if (difference) return difference;
  }
  return 0;
}

/**
 * 抽取不同上游的同义字段，构造唯一允许交给 view 的下载叶子结构。
 * source 是人类可读线路名称；version 由父级分组传入，供后续展示/分析扩展。
 * @param {object} item 上游原始项
 * @param {string} source 线路显示名
 * @param {string} [version=''] 版本号
 * @returns {{name: string, version: string, architecture: string, size: number|null, description: string, downloadUrl: string, available: boolean, source: string}}
 */
export function normalizeDownloadItem(item, source, version = '') {
  // 各镜像字段名不同，只有这里允许读取其原始字段；后续 controller/view 只认识统一模型。
  const downloadUrl = item.downloadUrl || item.url || item.link || item.download_link || '';
  return {
    name: item.name || item.file_name || '',
    version,
    architecture: item.architecture || item.arch || '',
    size: item.size ?? item.size_bytes ?? null,
    description: item.description || item.unavailable_reason || '',
    downloadUrl,
    available: item.available !== false,
    source,
  };
}

/**
 * 按配置随机标记一个 default=true 节点；notJoinRandom=true 的节点永不参与。
 * @param {Array<object>} items 候选节点数组
 * @returns {Array<object>} 新数组，其中一项被标记为 default: true
 */
export function randomlySelectDefault(items) {
  // 不修改原数组项，避免同一份镜像响应被下一次选择复用时保留过期 default 状态。
  const candidates = items.filter((item) => item.notJoinRandom !== true);
  if (!candidates.length) return items;
  const chosen = candidates[Math.floor(Math.random() * candidates.length)];
  return items.map((item) => ({ ...item, default: item === chosen }));
}
