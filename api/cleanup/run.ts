import type { AppContext } from "../platform";
import { abortUpload } from "../uploads/transport";

/**
 * 后台清理：回收过期/取消中的上传，永久删除超期回收站条目，并去掉过期分享与会话。
 *
 * 每条流水线都先写入处理中状态，对象存储失败时下次运行可以继续接管，而不会丢失待处理记录。
 */
export async function runCleanup(services: AppContext, now = Date.now()): Promise<{
  expiredUploads: number;
  purgedItems: number;
}> {
  await services.metadata.lifecycle.ensureSchema();
  const expiredUploads = await services.metadata.uploads.listExpiredUploads(now);
  let expiredCount = 0;
  for (const candidate of expiredUploads) {
    // cancelling 表示用户主动取消，expiring 表示超过 24 小时未完成；两者都需要先 abort multipart。
    const finalStatus = candidate.status === "cancelling" ? "cancelled" : "expired";
    const upload = await services.metadata.uploads.beginUploadCleanup(candidate.ownerId, candidate.id, finalStatus);
    if (!upload) continue;
    try {
      await abortUpload(services, upload);
      const finished = await services.metadata.uploads.finishUploadCleanup(upload.ownerId, upload.id, finalStatus);
      if (finished && finalStatus === "expired") expiredCount += 1;
    } catch (error) {
      console.error(JSON.stringify({
        message: "expired upload cleanup failed",
        uploadId: upload.id,
        error: error instanceof Error ? error.message : "unknown",
      }));
    }
  }

  const purgeBefore = now - 30 * 24 * 60 * 60 * 1000;
  const expiredTrash = await services.metadata.uploads.listExpiredTrash(purgeBefore);
  let purgedItems = 0;
  for (const candidate of expiredTrash) {
    // 负数 deleted_at 是“正在永久删除”的租约标记，防止多个清理执行器重复删除同一对象。
    const item = await services.metadata.items.beginPurge(candidate.ownerId, candidate.id);
    if (!item) continue;
    try {
      if (item.objectKey) await services.blobs.delete(item.objectKey);
      if (await services.metadata.items.permanentlyDelete(item.ownerId, item.id)) purgedItems += 1;
    } catch (error) {
      console.error(JSON.stringify({
        message: "purge item failed",
        itemId: item.id,
        error: error instanceof Error ? error.message : "unknown",
      }));
    }
  }
  // 会话和验证码只保留到期时间，清理它们不会影响仍在有效期内的登录设备。
  await services.metadata.shares.deleteExpiredShares(
    now - 30 * 24 * 60 * 60 * 1000,
    now - 15 * 60 * 1000,
  );
  await services.metadata.auth.deleteExpiredSessions(now);
  return { expiredUploads: expiredCount, purgedItems };
}
