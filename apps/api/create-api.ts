import { Hono } from "hono";
import {
  bulkActionSchema,
  createShareSchema,
  createLinkSchema,
  createTextSchema,
  listItemsQuerySchema,
  updateItemSchema,
  uploadCreateSchema,
  uploadPartUrlsSchema,
  uploadPartsConfirmSchema,
  verifyShareSchema,
  UPLOAD_PART_SIZE,
  type ExportBundle,
  type PublicShareContent,
  type UploadPartUrl,
} from "../../packages/contracts";
import {
  errorResponse,
  installIdentityMiddleware,
  installRequestMiddleware,
  parseJson,
  ApiEnv
} from "./http";
import type { RuntimeServices } from "./platform";
import { fileDownloadResponse, isPreviewableImage } from "./download";
import { abortUpload, completeUploadStorage, uploadMode, uploadSessionResponse } from "./uploads";
import {
  createShareCookie,
  decryptShareCode,
  encryptShareCode,
  hasShareCookie,
  keyedDigest,
  randomShareCode,
  shareStatus,
  shareSummary,
  tokenForShare,
  verifyKeyedDigest,
} from "./sharing";

const api = new Hono<ApiEnv>();
installRequestMiddleware(api);

api.get("/health/live", (c) => c.json({ status: "ok" }));
api.get("/health/ready", async (c) => {
  try {
    await c.env.services.metadata.healthCheck();
    await c.env.services.metadata.ensureSchema();
    await c.env.services.metadata.ensureApplicationReady();
    await c.env.services.blobs.healthCheck();
    return c.json({ status: "ready" });
  } catch {
    return c.json({ status: "unavailable" }, 503);
  }
});

api.use("/api/public/shares/*", async (c, next) => {
  await next();
  c.header("cache-control", "private, no-store");
  c.header("x-robots-tag", "noindex, nofollow, noarchive");
});

api.get("/api/health", (c) =>
  c.json({ status: "ok", name: "drop-worker", time: new Date().toISOString() }),
);

api.get("/api/auth/status", async (c) => {
  const identity = await c.env.services.resolveIdentity(c.req.raw);
  return c.json({
    authenticated: Boolean(identity),
    mode: c.env.services.authMode,
    email: identity?.email ?? null,
    insecureHttp: c.env.services.insecureHttp,
  });
});

api.all("/api/auth/*", async (c) => {
  // 认证路由由部署适配器提供：Cloudflare 使用 D1/Email Service，本地使用 SQLite/Node SMTP。
  const response = await c.env.services.handleAuthRequest?.(c.req.raw);
  return response ?? errorResponse(c.get("requestId"), "NOT_FOUND", "认证操作不存在", 404);
});

async function resolvePublicShare(services: RuntimeServices, token: string, now: number) {
  if (!services.sharing.enabled || token.length < 32 || token.length > 128) return null;
  const tokenHash = await keyedDigest(services.sharing.secret, "share-token-hash", token);
  const share = await services.metadata.getShareByTokenHash(tokenHash);
  if (!share || shareStatus(share, now) !== "active") return null;
  if (share.item.type !== "text" && share.item.type !== "file") return null;
  return share;
}

function attachmentContentDisposition(fileName: string): string {
  return `attachment; filename*=UTF-8''${encodeURIComponent(fileName)}`;
}

async function publicFileRedirect(
  services: RuntimeServices,
  objectKey: string,
): Promise<Response | null> {
  if (!services.publicFilesUrl) return null;
  if (await services.blobs.size(objectKey) === null) return null;
  const encodedKey = objectKey.split("/").map(encodeURIComponent).join("/");
  const target = new URL(encodedKey, services.publicFilesUrl);
  return new Response(null, {
    status: 307,
    headers: {
      location: target.toString(),
      "cache-control": "private, no-store",
    },
  });
}

api.get("/api/public/shares/:token", async (c) => {
  const now = Date.now();
  const token = c.req.param("token");
  const share = await resolvePublicShare(c.env.services, token, now);
  if (!share) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
  if (
    share.accessMode === "code"
    && !(await hasShareCookie(c.req.raw, share.id, c.env.services.sharing.secret, now))
  ) {
    return errorResponse(c.get("requestId"), "SHARE_VERIFICATION_REQUIRED", "请确认访问口令", 401);
  }
  const content: PublicShareContent = share.item.type === "file"
    ? {
        type: "file",
        fileName: share.item.displayName || share.item.originalName || "download",
        mimeType: share.item.mimeType || "application/octet-stream",
        sizeBytes: share.item.sizeBytes,
        updatedAt: share.item.updatedAt,
        expiresAt: share.expiresAt,
      }
    : {
        type: "text",
        content: share.item.content || "",
        updatedAt: share.item.updatedAt,
        expiresAt: share.expiresAt,
      };
  await c.env.services.metadata.recordShareAccess(share.id, now, false);
  c.header("cache-control", "private, no-store");
  c.header("x-robots-tag", "noindex, nofollow, noarchive");
  return c.json(content);
});

api.post("/api/public/shares/:token/verify", async (c) => {
  const now = Date.now();
  const token = c.req.param("token");
  const share = await resolvePublicShare(c.env.services, token, now);
  if (!share || share.accessMode !== "code" || !share.codeHash) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
  }
  const parsed = verifyShareSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_SHARE_CODE", "访问口令无效", 400);
  }
  const clientAddress = c.env.services.sharing.resolveClientAddress(c.req.raw);
  const sourceHash = await keyedDigest(c.env.services.sharing.secret, "share-source", clientAddress);
  const previous = await c.env.services.metadata.getShareAttempt(share.id, sourceHash);
  if (previous && previous.lockedUntil > now) {
    return errorResponse(c.get("requestId"), "SHARE_CODE_LOCKED", "尝试次数过多，请稍后再试", 429);
  }
  const matches = await verifyKeyedDigest(
    c.env.services.sharing.secret,
    "share-code",
    `${share.id}:${parsed.data.code}`,
    share.codeHash,
  );
  if (!matches) {
    const attempt = await c.env.services.metadata.recordShareFailure(share.id, sourceHash, now);
    const locked = attempt.lockedUntil > now;
    return errorResponse(
      c.get("requestId"),
      locked ? "SHARE_CODE_LOCKED" : "INVALID_SHARE_CODE",
      locked ? "尝试次数过多，请稍后再试" : "访问口令无效",
      locked ? 429 : 401,
    );
  }
  await c.env.services.metadata.deleteShareAttempt(share.id, sourceHash);
  const cookie = await createShareCookie({
    shareId: share.id,
    token,
    secret: c.env.services.sharing.secret,
    expiresAt: share.expiresAt,
    now,
    secure: c.env.services.sharing.publicUrl.protocol === "https:",
  });
  c.header("set-cookie", cookie);
  c.header("cache-control", "private, no-store");
  return c.json({ verified: true, expiresAt: Math.min(share.expiresAt, now + 24 * 60 * 60 * 1000) });
});

api.on(["GET", "HEAD"], "/api/public/shares/:token/preview", async (c) => {
  const now = Date.now();
  const token = c.req.param("token");
  const share = await resolvePublicShare(c.env.services, token, now);
  if (!share || share.item.type !== "file" || !share.item.objectKey || !isPreviewableImage(share.item.mimeType)) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或不支持预览", 404);
  }
  if (
    share.accessMode === "code"
    && !(await hasShareCookie(c.req.raw, share.id, c.env.services.sharing.secret, now))
  ) {
    return errorResponse(c.get("requestId"), "SHARE_VERIFICATION_REQUIRED", "请确认访问口令", 401);
  }
  const response = await fileDownloadResponse({
    request: c.req.raw,
    blobs: c.env.services.blobs,
    objectKey: share.item.objectKey,
    fileName: share.item.displayName || share.item.originalName || "image",
    mimeType: share.item.mimeType,
    attachmentOnly: false,
  });
  if (!response) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
  response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return response;
});

api.on(["GET", "HEAD"], "/api/public/shares/:token/download", async (c) => {
  const now = Date.now();
  const token = c.req.param("token");
  const share = await resolvePublicShare(c.env.services, token, now);
  if (!share || share.item.type !== "file" || !share.item.objectKey) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
  }
  if (
    share.accessMode === "code"
    && !(await hasShareCookie(c.req.raw, share.id, c.env.services.sharing.secret, now))
  ) {
    return errorResponse(c.get("requestId"), "SHARE_VERIFICATION_REQUIRED", "请确认访问口令", 401);
  }
  const response = c.env.services.publicFilesUrl
    ? await publicFileRedirect(c.env.services, share.item.objectKey)
    : await fileDownloadResponse({
        request: c.req.raw,
        blobs: c.env.services.blobs,
        objectKey: share.item.objectKey,
        fileName: share.item.displayName || share.item.originalName || "download",
        mimeType: share.item.mimeType,
        attachmentOnly: true,
      });
  if (!response) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
  const startsDownload = !c.req.header("range");
  if (c.req.method === "GET" && startsDownload && (response.status === 200 || response.status === 206 || response.status === 307)) {
    await c.env.services.metadata.recordShareAccess(share.id, now, true);
  }
  response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
  return response;
});

installIdentityMiddleware(api);

api.get("/api/items", async (c) => {
  const parsed = listItemsQuerySchema.safeParse(c.req.query());
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_QUERY", "筛选条件无效", 400);
  }
  const value = parsed.data;
  const result = await c.env.services.metadata.listItems(c.get("identity").ownerId, {
    type: value.type,
    query: value.q,
    favorites: value.favorites === undefined ? undefined : value.favorites === "true",
    trash: value.trash === "true",
    sort: value.sort,
    cursor: value.cursor,
    limit: value.limit,
  });
  return c.json(result);
});

api.post("/api/items/text", async (c) => {
  const parsed = createTextSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_TEXT", "文本不能为空且不能超过 64 KB", 400);
  }
  const item = await c.env.services.metadata.createItem({
    ownerId: c.get("identity").ownerId,
    type: "text",
    content: parsed.data.content,
  });
  return c.json(item, 201);
});

api.post("/api/items/link", async (c) => {
  const parsed = createLinkSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_LINK", "请输入有效的网址", 400);
  }
  const url = new URL(parsed.data.url);
  const item = await c.env.services.metadata.createItem({
    ownerId: c.get("identity").ownerId,
    type: "link",
    content: url.toString(),
    title: parsed.data.title || url.hostname,
  });
  return c.json(item, 201);
});

api.patch("/api/items/:id", async (c) => {
  const parsed = updateItemSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_UPDATE", "修改内容无效", 400);
  }
  const item = await c.env.services.metadata.getItem(c.get("identity").ownerId, c.req.param("id"));
  if (!item) return errorResponse(c.get("requestId"), "NOT_FOUND", "条目不存在", 404);
  if (item.type === "file" && (parsed.data.content !== undefined || parsed.data.title !== undefined)) {
    return errorResponse(c.get("requestId"), "INVALID_UPDATE", "文件只能修改显示名称和收藏状态", 400);
  }
  const updated = await c.env.services.metadata.updateItem(
    c.get("identity").ownerId,
    item.id,
    parsed.data,
  );
  return c.json(updated);
});

api.post("/api/items/bulk", async (c) => {
  const parsed = bulkActionSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_BULK_ACTION", "批量操作无效", 400);
  }
  const ownerId = c.get("identity").ownerId;
  if (parsed.data.action === "trash") {
    const changed = await c.env.services.metadata.setDeleted(ownerId, parsed.data.ids, Date.now());
    return c.json({ changed });
  }
  if (parsed.data.action === "restore") {
    const changed = await c.env.services.metadata.setDeleted(ownerId, parsed.data.ids, null);
    return c.json({ changed });
  }
  // 永久删除分两步完成：先在数据库中标记“删除中”，再删除对象，最后删除元数据。
  // 这样对象存储失败时可以由清理任务重试，而不会丢失待处理记录。
  let changed = 0;
  for (const id of parsed.data.ids) {
    const item = await c.env.services.metadata.beginPurge(ownerId, id);
    if (!item) continue;
    if (item.objectKey) await c.env.services.blobs.delete(item.objectKey);
    if (await c.env.services.metadata.permanentlyDelete(ownerId, id)) changed += 1;
  }
  return c.json({ changed });
});

api.get("/api/storage", async (c) => {
  const result = await c.env.services.metadata.storageSummary(
    c.get("identity").ownerId,
    c.env.services.quotaBytes,
  );
  return c.json(result);
});

api.get("/api/shares", async (c) => {
  const now = Date.now();
  const shares = await c.env.services.metadata.listShares(
    c.get("identity").ownerId,
    now,
    now - 30 * 24 * 60 * 60 * 1000,
  );
  const summaries = await Promise.all(shares.map(async (share) => {
    const token = await tokenForShare(c.env.services.sharing.secret, share.id);
    const code = await decryptShareCode(c.env.services.sharing.secret, share.id, share.codeEncrypted);
    return shareSummary(share, now, c.env.services.sharing.publicUrl, token, code);
  }));
  return c.json({ shares: summaries });
});

api.post("/api/items/:id/share", async (c) => {
  if (!c.env.services.sharing.enabled) {
    return errorResponse(c.get("requestId"), "SHARING_DISABLED", "分享功能当前已关闭", 403);
  }
  const parsed = createShareSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_SHARE", "分享设置无效", 400);
  }
  const ownerId = c.get("identity").ownerId;
  const item = await c.env.services.metadata.getItem(ownerId, c.req.param("id"));
  if (!item || item.deletedAt !== null || (item.type !== "text" && item.type !== "file")) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "该内容不能分享", 404);
  }
  const id = crypto.randomUUID();
  const token = await tokenForShare(c.env.services.sharing.secret, id);
  const tokenHash = await keyedDigest(c.env.services.sharing.secret, "share-token-hash", token);
  const generatedCode = parsed.data.accessMode === "code" && !parsed.data.code
    ? randomShareCode()
    : null;
  const code = parsed.data.accessMode === "code" ? parsed.data.code || generatedCode : null;
  const codeHash = code
    ? await keyedDigest(c.env.services.sharing.secret, "share-code", `${id}:${code}`)
    : null;
  const codeEncrypted = code
    ? await encryptShareCode(c.env.services.sharing.secret, id, code)
    : null;
  const now = Date.now();
  const share = await c.env.services.metadata.createShare({
    id,
    ownerId,
    itemId: item.id,
    tokenHash,
    accessMode: parsed.data.accessMode,
    codeHash,
    codeEncrypted,
    now,
    expiresAt: now + parsed.data.expiresInSeconds * 1000,
  });
  if (!share) return errorResponse(c.get("requestId"), "NOT_FOUND", "该内容不能分享", 404);
  const url = new URL(`/s/${token}`, c.env.services.sharing.publicUrl);
  if (code) url.hash = `code=${code}`;
  return c.json({
    share: shareSummary(share, now, c.env.services.sharing.publicUrl, token, code),
    shareUrl: url.toString(),
    generatedCode,
  }, 201);
});

api.delete("/api/shares/:id", async (c) => {
  const share = await c.env.services.metadata.revokeShare(
    c.get("identity").ownerId,
    c.req.param("id"),
    Date.now(),
  );
  if (!share) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在", 404);
  return c.json({ revoked: true });
});

api.post("/api/uploads", async (c) => {
  const parsed = uploadCreateSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_UPLOAD", "文件信息无效或超过 500 MB", 400);
  }
  const ownerId = c.get("identity").ownerId;
  const objectKey = `objects/${crypto.randomUUID()}`;
  const contentDisposition = attachmentContentDisposition(parsed.data.fileName);
  // 先创建存储供应商的 multipart 会话，再在同一个请求中原子预留数据库配额。
  // 任一步失败都要主动 abort，避免留下无法被用户看到的孤儿 multipart 会话。
  const providerUploadId = c.env.services.directUploads
    ? await c.env.services.directUploads.createMultipart(objectKey, parsed.data.mimeType, contentDisposition)
    : await c.env.services.blobs.createMultipart(objectKey, parsed.data.mimeType, contentDisposition);
  const now = Date.now();
  let upload;
  try {
    upload = await c.env.services.metadata.createUpload({
      ownerId,
      objectKey,
      providerUploadId,
      ...parsed.data,
      now,
      expiresAt: now + 24 * 60 * 60 * 1000,
    }, c.env.services.quotaBytes);
  } catch (error) {
    const direct = c.env.services.directUploads?.isManagedUpload(providerUploadId)
      ? c.env.services.directUploads
      : null;
    await (direct
      ? direct.abortMultipart(objectKey, providerUploadId)
      : c.env.services.blobs.abortMultipart(objectKey, providerUploadId)).catch(() => undefined);
    throw error;
  }
  if (!upload) {
    const direct = c.env.services.directUploads?.isManagedUpload(providerUploadId)
      ? c.env.services.directUploads
      : null;
    await (direct
      ? direct.abortMultipart(objectKey, providerUploadId)
      : c.env.services.blobs.abortMultipart(objectKey, providerUploadId)).catch(() => undefined);
    return errorResponse(c.get("requestId"), "QUOTA_EXCEEDED", "存储配额不足，请先清理文件", 409);
  }
  return c.json(uploadSessionResponse(c.env.services, upload), 201);
});

api.get("/api/uploads/:id", async (c) => {
  const upload = await c.env.services.metadata.getUpload(c.get("identity").ownerId, c.req.param("id"));
  if (!upload || !["uploading", "completed"].includes(upload.status)) return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在", 404);
  return c.json(uploadSessionResponse(c.env.services, upload));
});

api.post("/api/uploads/:id/part-urls", async (c) => {
  const ownerId = c.get("identity").ownerId;
  const upload = await c.env.services.metadata.getUpload(ownerId, c.req.param("id"));
  if (!upload || upload.status !== "uploading") {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
  }
  if (upload.expiresAt <= Date.now()) {
    return errorResponse(c.get("requestId"), "UPLOAD_EXPIRED", "上传任务已过期", 409);
  }
  const direct = c.env.services.directUploads;
  if (!direct?.isManagedUpload(upload.providerUploadId)) {
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
    url: await direct.createPartUploadUrl(
      upload.objectKey,
      upload.providerUploadId,
      partNumber,
      expiresInSeconds,
    ),
  })));
  return c.json({ urls });
});

api.post("/api/uploads/:id/parts/confirm", async (c) => {
  const ownerId = c.get("identity").ownerId;
  const upload = await c.env.services.metadata.getUpload(ownerId, c.req.param("id"));
  if (!upload || upload.status !== "uploading") {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
  }
  if (upload.expiresAt <= Date.now()) {
    return errorResponse(c.get("requestId"), "UPLOAD_EXPIRED", "上传任务已过期", 409);
  }
  const direct = c.env.services.directUploads;
  if (!direct?.isManagedUpload(upload.providerUploadId)) {
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
  const next = await c.env.services.metadata.saveUploadParts(ownerId, upload.id, parts);
  if (!next) return errorResponse(c.get("requestId"), "UPLOAD_STATE_ERROR", "无法保存分片状态", 409);
  return c.json(uploadSessionResponse(c.env.services, next));
});

api.put("/api/uploads/:id/parts/:partNumber", async (c) => {
  const ownerId = c.get("identity").ownerId;
  const upload = await c.env.services.metadata.getUpload(ownerId, c.req.param("id"));
  if (!upload || upload.status !== "uploading") {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
  }
  if (upload.expiresAt <= Date.now()) {
    return errorResponse(c.get("requestId"), "UPLOAD_EXPIRED", "上传任务已过期", 409);
  }
  if (uploadMode(c.env.services, upload) === "direct") {
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
  const etag = await c.env.services.blobs.putPart(
    upload.objectKey,
    upload.providerUploadId,
    partNumber,
    bytes,
  );
  // 存储供应商确认分片后才写入 ETag 和大小；重复提交同一编号会覆盖元数据，支持断点续传重试。
  const next = await c.env.services.metadata.saveUploadParts(ownerId, upload.id, [{
    partNumber,
    etag,
    sizeBytes: bytes.byteLength,
  }]);
  if (!next) return errorResponse(c.get("requestId"), "UPLOAD_STATE_ERROR", "无法保存分片状态", 409);
  return c.json(uploadSessionResponse(c.env.services, next));
});

api.post("/api/uploads/:id/complete", async (c) => {
  const ownerId = c.get("identity").ownerId;
  const upload = await c.env.services.metadata.getUpload(ownerId, c.req.param("id"));
  if (!upload || !["uploading", "completed"].includes(upload.status)) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
  }
  if (upload.status === "completed") {
    // 完成请求可能因网络重试重复到达；已完成时直接返回已存在的条目，保持幂等。
    const item = await c.env.services.metadata.completeUpload(ownerId, upload.id);
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
  const item = await c.env.services.metadata.completeUpload(ownerId, upload.id);
  if (!item) return errorResponse(c.get("requestId"), "UPLOAD_STATE_ERROR", "无法完成上传", 409);
  return c.json(item, 201);
});

api.delete("/api/uploads/:id", async (c) => {
  const ownerId = c.get("identity").ownerId;
  const upload = await c.env.services.metadata.getUpload(ownerId, c.req.param("id"));
  if (!upload || !["uploading", "cancelling"].includes(upload.status)) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
  }
  const pending = await c.env.services.metadata.beginUploadCleanup(ownerId, upload.id, "cancelled");
  if (!pending) return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在或已结束", 404);
  await abortUpload(c.env.services, pending);
  // 只有对象存储 abort 成功后才把数据库状态改为 cancelled；失败时保留 cancelling 供定时清理重试。
  await c.env.services.metadata.finishUploadCleanup(ownerId, pending.id, "cancelled");
  return c.json({ cancelled: true });
});

api.on(["GET", "HEAD"], "/api/files/:id", async (c) => {
  const item = await c.env.services.metadata.getItem(c.get("identity").ownerId, c.req.param("id"));
  if (!item || item.type !== "file" || !item.objectKey) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "文件不存在", 404);
  }
  const fileName = item.displayName || item.originalName || "download";
  const attachmentOnly = c.req.query("download") === "1";
  if (c.env.services.publicFilesUrl && (attachmentOnly || !isPreviewableImage(item.mimeType))) {
    const redirect = await publicFileRedirect(c.env.services, item.objectKey);
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

api.get("/api/export", async (c) => {
  const ownerId = c.get("identity").ownerId;
  const now = Date.now();
  const [items, storedShares] = await Promise.all([
    c.env.services.metadata.listAllForExport(ownerId),
    c.env.services.metadata.listShares(ownerId, now, now - 30 * 24 * 60 * 60 * 1000),
  ]);
  const shares = storedShares.map((share) => {
    const summary = shareSummary(share, now, c.env.services.sharing.publicUrl);
    return {
      id: summary.id,
      itemId: summary.itemId,
      itemType: summary.itemType,
      itemLabel: summary.itemLabel,
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
  const bundle: ExportBundle = {
    format: "drop-worker-export",
    version: 2,
    exportedAt: new Date().toISOString(),
    items,
    shares,
  };
  return new Response(JSON.stringify(bundle, null, 2), {
    headers: {
      "content-type": "application/json; charset=utf-8",
      "content-disposition": `attachment; filename="drop-worker-${new Date().toISOString().slice(0, 10)}.json"`,
      "cache-control": "private, no-store",
    },
  });
});

api.notFound((c) => errorResponse(c.get("requestId") || crypto.randomUUID(), "NOT_FOUND", "接口不存在", 404));

api.onError((error, c) => {
  const requestId = c.get("requestId") || crypto.randomUUID();
  console.error(
    JSON.stringify({
      message: "request failed",
      requestId,
      path: new URL(c.req.url).pathname,
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  return errorResponse(requestId, "INTERNAL_ERROR", "服务暂时不可用", 500);
});

export function handleApiRequest(request: Request, services: RuntimeServices): Promise<Response> {
  return Promise.resolve(api.fetch(request, { services }));
}
