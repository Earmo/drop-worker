import type { DropItem, ExportBundle } from "../../packages/contracts";
import type { StoredShare } from "../platform";
import { shareSummary } from "../sharing/helpers";

const EXPORT_SHARE_HISTORY_MS = 30 * 24 * 60 * 60 * 1000;

function publicItem(item: DropItem): DropItem {
  // 显式挑选公开字段，防止 StoredItem 上的 ownerId/objectKey 随对象展开进入审阅清单。
  return {
    id: item.id,
    type: item.type,
    content: item.content,
    title: item.title,
    originalName: item.originalName,
    displayName: item.displayName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    favorite: item.favorite,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
}

/**
 * 创建可供人工审阅的数据清单。
 *
 * 输入可以是带内部字段的存储记录；输出只保留公开条目和分享摘要，不包含所有者、
 * 对象键、分享 URL、访问口令及其哈希。已进入最终清理状态的条目和超过 30 天的
 * 分享历史不会进入清单，但仍保留在完整备份的 manifest 中供恢复使用。
 */
export function createExportBundle(
  items: readonly DropItem[],
  storedShares: readonly StoredShare[],
  now: number,
  publicUrl = new URL("https://drop-worker.invalid"),
): ExportBundle {
  const shares = storedShares
    .filter((share) =>
      share.revokedAt === null && (share.expiresAt > now || share.expiresAt >= now - EXPORT_SHARE_HISTORY_MS),
    )
    .map((share) => {
      const summary = shareSummary(share, now, publicUrl);
      return {
        id: summary.id,
        name: summary.name,
        customName: summary.customName,
        members: summary.members,
        itemCount: summary.itemCount,
        accessMode: summary.accessMode,
        status: summary.status,
        createdAt: summary.createdAt,
        expiresAt: summary.expiresAt,
        revokedAt: summary.revokedAt,
        accessCount: summary.accessCount,
        downloadCount: summary.downloadCount,
        lastAccessedAt: summary.lastAccessedAt,
      };
    });
  return {
    format: "drop-worker-export",
    version: 2,
    exportedAt: new Date(now).toISOString(),
    items: items
      .filter((item) => item.deletedAt === null || item.deletedAt > 0)
      .map(publicItem),
    shares,
  };
}
