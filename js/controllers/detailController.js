import { getMirrors, getSoftware, getTags } from '../repositories/siteRepository.js';
import { renderDetail, renderDetailError, renderDetailLoading } from '../views/detailView.js';
import { logError } from '../common/logger.js';
import { t } from '../common/i18n.js';

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
      // 在渲染前验证外键，避免把孤立的 tagId 默默展示成数字。
      const knownTags = new Set(tags.map((tag) => tag.id));
      basic.tagIds.forEach((id) => {
    if (!knownTags.has(id)) throw new Error(t('common.repository.unknownTag', { id }));
      });
      renderDetail(elements, softwareId, basic, detail, tags, mirrors);
    } catch (error) {
      logError(error, '详情页');
      renderDetailError(elements, error, load);
    }
  }
  return { load };
}
