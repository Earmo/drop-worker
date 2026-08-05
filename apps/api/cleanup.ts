import type { RuntimeServices } from "./platform";

export async function runCleanup(services: RuntimeServices, now = Date.now()): Promise<{
  expiredUploads: number;
  purgedItems: number;
}> {
  await services.metadata.ensureSchema();
  const expiredUploads = await services.metadata.listExpiredUploads(now);
  let expiredCount = 0;
  for (const candidate of expiredUploads) {
    const finalStatus = candidate.status === "cancelling" ? "cancelled" : "expired";
    const upload = await services.metadata.beginUploadCleanup(candidate.ownerId, candidate.id, finalStatus);
    if (!upload) continue;
    try {
      await services.blobs.abortMultipart(upload.objectKey, upload.providerUploadId);
      const finished = await services.metadata.finishUploadCleanup(upload.ownerId, upload.id, finalStatus);
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
  const expiredTrash = await services.metadata.listExpiredTrash(purgeBefore);
  let purgedItems = 0;
  for (const candidate of expiredTrash) {
    const item = await services.metadata.beginPurge(candidate.ownerId, candidate.id);
    if (!item) continue;
    try {
      if (item.objectKey) await services.blobs.delete(item.objectKey);
      if (await services.metadata.permanentlyDelete(item.ownerId, item.id)) purgedItems += 1;
    } catch (error) {
      console.error(JSON.stringify({
        message: "purge item failed",
        itemId: item.id,
        error: error instanceof Error ? error.message : "unknown",
      }));
    }
  }
  await services.metadata.deleteExpiredSessions(now);
  return { expiredUploads: expiredCount, purgedItems };
}
