import { getJSON } from '../http/client.js';
import { t } from '../common/i18n.js';

/**
 * 本站静态数据仓库。
 * catalog 项：{ id, name, icon, tagIds, detailUrl }；
 * detail 文件：包含 info、intro、download 等页面所需的扩展信息；
 * 这里不修改源对象，返回值可安全地在多个 controller 间复用。
 */

// Repository 负责“取数据并验证数据契约”，不创建 DOM，也不掺入页面交互状态。
/**
 * 检查 JSON 顶层是否为数组。
 * @param {*} value 待检查的值
 * @param {string} label 用于生成面向站长的配置错误提示
 * @returns {Array} 校验后的数组
 */
function assertArray(value, label) {
  if (!Array.isArray(value)) throw new Error(t('common.repository.invalidArray', { label }));
  return value;
}

/**
 * 检查配置中每个对象都具有唯一整数 ID。
 * @param {Array<object>} items 待检查的配置项数组
 * @param {string} label 用于生成错误提示的标签名
 * @returns {Array<object>} 校验后的配置项数组
 */
function assertUniqueIds(items, label) {
  const ids = new Set();
  for (const item of items) {
    if (!Number.isInteger(item?.id)) throw new Error(t('common.repository.invalidId', { label }));
    if (ids.has(item.id)) throw new Error(t('common.repository.duplicateId', { label, id: item.id }));
    ids.add(item.id);
  }
  return items;
}

/**
 * 获取软件目录；列表页只调用此函数，不再按条目请求 basic.json。
 * @param {object} [options] HTTP 请求选项
 * @returns {Promise<Array<object>>} 软件目录数组
 */
export async function getSoftwareCatalog(options = {}) {
  // 软件目录是列表页的唯一基础数据源，避免旧实现按软件逐一请求 basic.json。
  const items = assertUniqueIds(
    assertArray(await getJSON('/data/software.json', { ...options, cache: true }), t('common.repository.software')),
    t('common.repository.software'),
  );
  items.forEach((item) => {
    if (!item.name || !item.detailUrl || !Array.isArray(item.tagIds)) {
      throw new Error(t('common.repository.softwareIncomplete', { id: item.id }));
    }
  });
  return items;
}

/**
 * 获取标签字典。
 * @param {object} [options] HTTP 请求选项
 * @returns {Promise<Array<object>>} 标签数组，项结构为 { id, name }
 */
export async function getTags(options = {}) {
  return assertUniqueIds(
    assertArray(await getJSON('/data/tag.json', { ...options, cache: true }), t('common.repository.tags')),
    t('common.repository.tags'),
  );
}

/**
 * 获取线路目录。
 * @param {object} [options] HTTP 请求选项
 * @returns {Promise<Array<object>>} 线路数组，项结构至少包含 { id, name, baseUrl }，可选 apiVer
 */
export async function getMirrors(options = {}) {
  return assertUniqueIds(
    assertArray(await getJSON('/data/mirror.json', { ...options, cache: true }), t('common.repository.mirrors')),
    t('common.repository.mirrors'),
  );
}

/**
 * 获取抽屉延迟展示的反馈渠道。
 * @param {object} [options] HTTP 请求选项
 * @returns {Promise<Array<object>>} 反馈渠道数组，项结构为 { name, href }
 */
export async function getFeedbackChannels(options = {}) {
  return assertArray(await getJSON('/data/feedback.json', { ...options, cache: true }), t('common.repository.feedback'));
}

/**
 * 获取设置配置树。
 * @param {object} [options] HTTP 请求选项
 * @returns {Promise<Array<object>>} 设置配置树，顶层为数组，每项为设置分类节点
 */
export async function getSettings(options = {}) {
  const data = await getJSON('/data/setting.json', { ...options, cache: true });
  if (!Array.isArray(data)) throw new Error(t('common.repository.settingsInvalid'));
  return data;
}

/**
 * 获取某软件的"目录基础信息 + 独立详情 JSON"。
 * @param {number} id 软件 ID，来自 URL 查询参数
 * @param {object} [options] HTTP 请求选项
 * @returns {Promise<{basic: object, detail: object}>}
 */
export async function getSoftware(id, options = {}) {
  // 先从目录定位详情路径，而不是将路径规则硬编码到各个页面入口中。
  const catalog = await getSoftwareCatalog(options);
  const basic = catalog.find((item) => item.id === id);
  if (!basic) throw new Error(t('common.repository.softwareNotFound', { id }));
  const detail = await getJSON(basic.detailUrl, { ...options, cache: true });
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)) {
    throw new Error(t('common.repository.detailInvalid', { id }));
  }
  return { basic, detail };
}
