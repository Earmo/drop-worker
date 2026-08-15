import {
  uploadCreateSchema,
  uploadPartUrlsSchema,
  uploadPartsConfirmSchema,
  UPLOAD_PART_SIZE,
  type UploadPartUrl,
} from "../../packages/contracts";
import { errorResponse, parseJson, type ApiApp } from "../http";
import { abortUpload, completeUploadStorage, uploadSessionResponse } from "./transport";

function attachmentContentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

/**
 * 分片上传路由。
 *
 * 创建会话时必须先向存储供应商领取 multipart，再原子预留配额；任一步失败都要 abort，
 * 否则会留下用户看不见的孤儿上传。完成请求保持幂等，以兼容网络重试。
 */
export function registerUploadRoutes(api: ApiApp): void {
  api.post("/api/uploads", async (c) => {
    const parsed = uploadCreateSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_UPLOAD", "文件信息无效或超过 500 MB", 400);
    }
    const ownerId = c.get("identity").ownerId;
    const objectKey = `objects/${crypto.randomUUID()}`;
    const contentDisposition = attachmentContentDisposition(parsed.data.fileName);
    const providerUploadId = await c.env.services.uploads.createMultipart(
      objectKey,
      parsed.data.mimeType,
      contentDisposition,
    );
    const now = Date.now();
    let upload;
    try {
      upload = await c.env.services.metadata.uploads.createUpload({
        ownerId,
        objectKey,
        providerUploadId,
        ...parsed.data,
        now,
        expiresAt: now + 24 * 60 * 60 * 1000,
      }, c.env.services.quotaBytes);
    } catch (error) {
      await c.env.services.uploads.abortUnpersisted(objectKey, providerUploadId).catch(() => undefined);
      throw error;
    }
    if (!upload) {
      await c.env.services.uploads.abortUnpersisted(objectKey, providerUploadId).catch(() => undefined);
      return errorResponse(c.get("requestId"), "QUOTA_EXCEEDED", "存储配额不足，请先清理文件", 409);
    }
    return c.json(uploadSessionResponse(c.env.services, upload), 201);
  });

  api.get("/api/uploads/:id", async (c) => {
    const upload = await c.env.services.metadata.uploads.getUpload(c.get("identity").ownerId, c.req.param("id"));
    if (!upload || !["uploading", "completed"].includes(upload.status)) return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在", 404);
    return c.json(uploadSessionResponse(c.env.services, upload));
  });

  api.post("/api/uploads/:id/part-urls", async (c) => {
    const ownerId = c.get("identity").ownerId;
    const upload = await c.env.services.metadata.uploads.getUpload(ownerId, c.req.param("id"));
    if (!upload || upload.status !== "uploading") {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
    }
    if (upload.expiresAt <= Date.now()) {
      return errorResponse(c.get("requestId"), "UPLOAD_EXPIRED", "上传任务已过期", 409);
    }
    if (c.env.services.uploads.mode(upload.providerUploadId) !== "direct") {
      return errorResponse(c.get("requestId"), "DIRECT_UPLOAD_UNAVAILABLE", "当前存储不支持直接上传", 409);
    }
    const parsed = uploadPartUrlsSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success || new Set(parsed.data.partNumbers).size !== parsed.data.partNumbers.length) {
      return errorResponse(c.get("requestId"), "INVALID_PART", "分片编号无效", 400);
    }
    const partCount = Math.ceil(upload.sizeBytes / UPLOAD_PART_SIZE);
    if (parsed.data.partNumbers.some((partNumber) => partNumber > partCount)) {
      return errorResponse(c.get("requestId"), "INVALID_PART", "分片编号超出文件范围", 400);
    }
    const expiresInSeconds = 15 * 60;
    const expiresAt = Date.now() + expiresInSeconds * 1_000;
    const urls: UploadPartUrl[] = await Promise.all(parsed.data.partNumbers.map(async (partNumber) => ({
      partNumber,
      expiresAt,
      url: await c.env.services.uploads.createPartUploadUrl(upload, partNumber, expiresInSeconds),
    })));
    return c.json({ urls });
  });

  api.post("/api/uploads/:id/parts/confirm", async (c) => {
    const ownerId = c.get("identity").ownerId;
    const upload = await c.env.services.metadata.uploads.getUpload(ownerId, c.req.param("id"));
    if (!upload || upload.status !== "uploading") {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
    }
    if (upload.expiresAt <= Date.now()) {
      return errorResponse(c.get("requestId"), "UPLOAD_EXPIRED", "上传任务已过期", 409);
    }
    if (c.env.services.uploads.mode(upload.providerUploadId) !== "direct") {
      return errorResponse(c.get("requestId"), "DIRECT_UPLOAD_UNAVAILABLE", "当前存储不支持直接上传", 409);
    }
    const parsed = uploadPartsConfirmSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success || new Set(parsed.data.parts.map((part) => part.partNumber)).size !== parsed.data.parts.length) {
      return errorResponse(c.get("requestId"), "INVALID_PART", "分片确认信息无效", 400);
    }
    const partCount = Math.ceil(upload.sizeBytes / UPLOAD_PART_SIZE);
    if (parsed.data.parts.some((part) => part.partNumber > partCount)) {
      return errorResponse(c.get("requestId"), "INVALID_PART", "分片编号超出文件范围", 400);
    }
    const parts = parsed.data.parts.map(({ partNumber, etag }) => ({
      partNumber,
      etag,
      sizeBytes: partNumber === partCount
        ? upload.sizeBytes - (partCount - 1) * UPLOAD_PART_SIZE
        : UPLOAD_PART_SIZE,
    }));
    const next = await c.env.services.metadata.uploads.saveUploadParts(ownerId, upload.id, parts);
    if (!next) return errorResponse(c.get("requestId"), "UPLOAD_STATE_ERROR", "无法保存分片状态", 409);
    return c.json(uploadSessionResponse(c.env.services, next));
  });

  api.put("/api/uploads/:id/parts/:partNumber", async (c) => {
    const ownerId = c.get("identity").ownerId;
    const upload = await c.env.services.metadata.uploads.getUpload(ownerId, c.req.param("id"));
    if (!upload || upload.status !== "uploading") {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
    }
    if (upload.expiresAt <= Date.now()) {
      return errorResponse(c.get("requestId"), "UPLOAD_EXPIRED", "上传任务已过期", 409);
    }
    if (c.env.services.uploads.mode(upload.providerUploadId) === "direct") {
      return errorResponse(c.get("requestId"), "DIRECT_UPLOAD_REQUIRED", "该上传任务必须直接上传到 R2", 409);
    }
    const partNumber = Number(c.req.param("partNumber"));
    if (!Number.isInteger(partNumber) || partNumber < 1 || partNumber > 10_000) {
      return errorResponse(c.get("requestId"), "INVALID_PART", "分片编号无效", 400);
    }
    const contentLength = Number(c.req.header("content-length") ?? "0");
    if (!Number.isFinite(contentLength) || contentLength <= 0 || contentLength > 16 * 1024 * 1024) {
      return errorResponse(c.get("requestId"), "INVALID_PART", "分片必须介于 1 B 和 16 MB 之间", 413);
    }
    const bytes = new Uint8Array(await c.req.arrayBuffer());
    if (bytes.byteLength !== contentLength) {
      return errorResponse(c.get("requestId"), "INVALID_PART", "分片长度不一致", 400);
    }
    const etag = await c.env.services.uploads.putPart(upload, partNumber, bytes);
    // 存储供应商确认分片后才写入 ETag 和大小；重复提交同一编号会覆盖元数据，支持断点续传重试。
    const next = await c.env.services.metadata.uploads.saveUploadParts(ownerId, upload.id, [{
      partNumber,
      etag,
      sizeBytes: bytes.byteLength,
    }]);
    if (!next) return errorResponse(c.get("requestId"), "UPLOAD_STATE_ERROR", "无法保存分片状态", 409);
    return c.json(uploadSessionResponse(c.env.services, next));
  });

  api.post("/api/uploads/:id/complete", async (c) => {
    const ownerId = c.get("identity").ownerId;
    const upload = await c.env.services.metadata.uploads.getUpload(ownerId, c.req.param("id"));
    if (!upload || !["uploading", "completed"].includes(upload.status)) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
    }
    if (upload.status === "completed") {
      // 完成请求可能因网络重试重复到达；已完成时直接返回已存在的条目，保持幂等。
      const item = await c.env.services.metadata.uploads.completeUpload(ownerId, upload.id);
      if (!item) return errorResponse(c.get("requestId"), "UPLOAD_STATE_ERROR", "无法读取已完成上传", 409);
      return c.json(item);
    }
    const uploadedBytes = upload.parts.reduce((total, part) => total + part.sizeBytes, 0);
    if (uploadedBytes !== upload.sizeBytes || upload.parts.length === 0) {
      return errorResponse(c.get("requestId"), "UPLOAD_INCOMPLETE", "文件分片尚未完整上传", 409);
    }
    try {
      // 供应商负责把已上传分片合并成对象；部分模拟存储可能已经合并成功但响应丢失，
      // 因此 catch 中会用对象大小做一次幂等兜底检查。
      await completeUploadStorage(c.env.services, upload);
      if ((await c.env.services.blobs.size(upload.objectKey)) !== upload.sizeBytes) {
        await c.env.services.blobs.delete(upload.objectKey).catch(() => undefined);
        throw new Error("完成后的对象大小与上传声明不一致");
      }
    } catch (error) {
      if ((await c.env.services.blobs.size(upload.objectKey)) !== upload.sizeBytes) throw error;
    }
    const item = await c.env.services.metadata.uploads.completeUpload(ownerId, upload.id);
    if (!item) return errorResponse(c.get("requestId"), "UPLOAD_STATE_ERROR", "无法完成上传", 409);
    return c.json(item, 201);
  });

  api.delete("/api/uploads/:id", async (c) => {
    const ownerId = c.get("identity").ownerId;
    const upload = await c.env.services.metadata.uploads.getUpload(ownerId, c.req.param("id"));
    if (!upload || !["uploading", "cancelling"].includes(upload.status)) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
    }
    const pending = await c.env.services.metadata.uploads.beginUploadCleanup(ownerId, upload.id, "cancelled");
    if (!pending) return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
    await abortUpload(c.env.services, pending);
    // 只有对象存储 abort 成功后才把数据库状态改为 cancelled；失败时保留 cancelling 供定时清理重试。
    await c.env.services.metadata.uploads.finishUploadCleanup(ownerId, pending.id, "cancelled");
    return c.json({ cancelled: true });
  });
}
