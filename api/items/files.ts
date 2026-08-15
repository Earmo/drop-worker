import { fileDownloadResponse, isPreviewableImage, publicFileRedirect } from "../download";
import { errorResponse, type ApiApp } from "../http";

/**
 * 属主文件下载。公开分享下载走 sharing，避免把访客 token 校验混进条目模块。
 */
export function registerItemFileRoutes(api: ApiApp): void {
  api.on(["GET", "HEAD"], "/api/files/:id", async (c) => {
    const item = await c.env.services.metadata.items.getItem(c.get("identity").ownerId, c.req.param("id"));
    if (!item || item.type !== "file" || !item.objectKey) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "文件不存在", 404);
    }
    const fileName = item.displayName || item.originalName || "download";
    const attachmentOnly = c.req.query("download") === "1";
    if (c.env.services.publicFilesUrl && (attachmentOnly || !isPreviewableImage(item.mimeType))) {
      const redirect = await publicFileRedirect(c.env.services.blobs, c.env.services.publicFilesUrl, item.objectKey);
      return redirect ?? errorResponse(c.get("requestId"), "FILE_MISSING", "文件数据不可用", 404);
    }
    const response = await fileDownloadResponse({
      request: c.req.raw,
      blobs: c.env.services.blobs,
      objectKey: item.objectKey,
      fileName,
      mimeType: item.mimeType,
      attachmentOnly,
    });
    return response ?? errorResponse(c.get("requestId"), "FILE_MISSING", "文件数据不可用", 404);
  });
}
