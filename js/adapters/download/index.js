import { adaptCxsjmc } from './cxsjmc.js';
import { adaptFengyuan } from './fengyuan.js';
import { adaptFrostlynx } from './frostlynx.js';
import { adaptLemwood } from './lemwood.js';
import { adaptPlain } from './plain.js';
import { adaptLinkong } from './Linkong.js';
import { adaptWay2old } from './way2old.js';
import { t } from '../../common/i18n.js';

/**
 * 下载协议注册表。
 * data/mirror.json 的 apiVer 是唯一的路由键；新增 apiVer 只能在此登记，
 * 这样网络层、选择器 controller 和 view 无需感知具体下载站。
 */
// 新增线路时：新增纯转换文件，再仅在这里登记 apiVer；不要修改选择器或渲染器。
const ADAPTERS = new Map([
  ['Way2old', adaptWay2old],
  ['frostlynx', adaptFrostlynx],
  ['Lemwood', adaptLemwood],
  ['LemwoodLatest', (payload, context) => adaptLemwood(payload, context, { latestOnly: true })],
  ['fengyuan', adaptFengyuan],
  ['cxsjmc', adaptCxsjmc],
  ['Linkong', adaptLinkong],
]);

/**
 * 递归把线路 id 标记到节点上。
 * 统一在注册表边界注入，新增 adapter 无需各自处理；叶子节点因此可以凭
 * mirrorId 判断来源线路，而不必依赖可能改名或翻译的线路显示名。
 * @param {Array<object>} nodes 统一下载节点数组
 * @param {number|null} mirrorId data/mirror.json 中的线路 id
 * @returns {Array<object>} 带 mirrorId 的节点数组（原对象不被修改）
 */
function stampMirrorId(nodes, mirrorId) {
  if (mirrorId == null) return nodes;
  return nodes.map((node) => {
    const stamped = { ...node, mirrorId };
    if (Array.isArray(stamped.children)) stamped.children = stampMirrorId(stamped.children, mirrorId);
    if (Array.isArray(stamped.items)) stamped.items = stampMirrorId(stamped.items, mirrorId);
    return stamped;
  });
}

/**
 * 路由到指定 apiVer 的 adapter，转换上游响应为统一下载节点。
 * @param {unknown} payload 上游 API 已解析的 JSON
 * @param {string|undefined} apiVersion data/mirror.json 中的 apiVer
 * @param {{source?: string, baseUrl?: string, latestVersion?: string|null, mirrorId?: number|null}} context adapter 共享上下文
 * @returns {Array<object>} 统一下载节点数组
 */
export function adaptDownloadData(payload, apiVersion, context = {}) {
  // 为所有 adapter 补齐同一份上下文，未登记协议自动退回兼容性的 plain adapter。
  const normalizedContext = {
    source: context.source || apiVersion || t('common.unknownMirror'),
    baseUrl: context.baseUrl || window.location.origin,
    latestVersion: context.latestVersion || payload?.latest || null,
    mirrorId: context.mirrorId ?? null,
  };
  const nodes = (ADAPTERS.get(apiVersion) || adaptPlain)(payload, normalizedContext);
  return stampMirrorId(nodes, normalizedContext.mirrorId);
}
