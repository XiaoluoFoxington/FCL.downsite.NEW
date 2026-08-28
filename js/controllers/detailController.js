import { completeOrphanTags, getMirrors, getSoftware, getTags } from '../repositories/siteRepository.js';
import { renderDetail, renderDetailError, renderDetailLoading } from '../views/detailView.js';
import { logError } from '../common/logger.js';

/**
 * 详情 controller 只协调数据与 view：软件详情、标签与线路目录可并行加载，
 * view 不需要知道网络层和数据校验规则。
 */
export function createDetailController(elements, softwareId) {
  /**
   * 重新加载当前详情页。失败时把自身作为重试回调交给 view，
   * 因此 view 不需要知道软件 ID 或请求函数。
   */
  async function load() {
    renderDetailLoading(elements);
    try {
      const [{ basic, detail }, tags, mirrors] = await Promise.all([
        getSoftware(softwareId),
        getTags(),
        getMirrors(),
      ]);
      // 资源引用了不存在的标签 ID 时不崩页面：现场补全为"未知标签-{id}"。
      const allTags = completeOrphanTags(tags, basic.tagIds.map((id) => ({ itemId: basic.id, id })));
      renderDetail(elements, softwareId, basic, detail, allTags, mirrors);
    } catch (error) {
      logError(error, '详情页');
      renderDetailError(elements, error, load);
    }
  }
  return { load };
}
