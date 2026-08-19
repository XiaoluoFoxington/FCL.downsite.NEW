/**
 * 自动选择模块。
 * 接受候选节点数组，经过一串有序步骤后标记默认线路并返回新数组。
 * 调用方无需关心选择策略；未来扩展（如按用户地区就近选择线路）
 * 只需在此管道中插入新步骤，selectAutoDefault 的接口保持不变。
 *
 * 语义区分：
 * - 所有线路都参与"自动选择"流程；
 * - notJoinRandom 仅表示该线路不参与流程中的"随机选择"这一步
 *   （即永远不会被随机挑选为默认线路，但仍可作为回退结果）。
 */

/**
 * 随机挑选——用于分散镜像负载。
 * 只在参与随机选择的线路（notJoinRandom !== true）中均匀随机取一条；
 * 全部线路都不参与随机选择时返回 null，由调用方回退。
 * @param {Array<object>} items 候选节点数组
 * @returns {object|null} 被选中的节点；无参与随机选择的线路时为 null
 */
function pickRandomlyAmong(items) {
  const pool = items.filter((item) => item.notJoinRandom !== true);
  if (!pool.length) return null;
  return pool[Math.floor(Math.random() * pool.length)];
}

/**
 * 自动选择默认节点。
 * 不修改原数组项，返回新数组；找不到可参与节点时原样返回。
 * @param {Array<object>} items 候选节点数组
 * @returns {Array<object>} 新数组，其中一项被标记为 default: true
 */
export function selectAutoDefault(items) {
  const original = items;
  const random = pickRandomlyAmong(original) ?? original[0]; // 随机挑选：全部线路不参与随机选择时回退到第一条，自动选择依然完成。
  const final = random;
  return items.map((item) => ({ ...item, default: item === final }));
}
