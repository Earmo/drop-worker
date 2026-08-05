import type { RuntimeServices } from "./platform";

export async function runCleanup(services: RuntimeServices, now = Date.now()): Promise<{
  expiredUploads: number;
  purgedItems: number;
}> {
  await services.metadata.ensureSchema();
  const expiredUploads = await services.metadata.listExpiredUploads(now);
  let expiredCount = 0;
  for (const upload of expiredUploads) {
    await services.blobs.abortMultipart(upload.objectKey, upload.providerUploadId).catch(() => undefined);
    if (await services.metadata.markUpload(upload.ownerId, upload.id, "expired")) expiredCount += 1;
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
