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
 * 路由到指定 apiVer 的 adapter，转换上游响应为统一下载节点。
 * @param {unknown} payload 上游 API 已解析的 JSON
 * @param {string|undefined} apiVersion data/mirror.json 中的 apiVer
 * @param {{source?: string, baseUrl?: string, latestVersion?: string|null}} context adapter 共享上下文
 * @returns {Array<object>} 统一下载节点数组
 */
export function adaptDownloadData(payload, apiVersion, context = {}) {
  // 为所有 adapter 补齐同一份上下文，未登记协议自动退回兼容性的 plain adapter。
  const normalizedContext = {
    source: context.source || apiVersion || t('common.unknownMirror'),
    baseUrl: context.baseUrl || window.location.origin,
    latestVersion: context.latestVersion || payload?.latest || null,
  };
  return (ADAPTERS.get(apiVersion) || adaptPlain)(payload, normalizedContext);
}
