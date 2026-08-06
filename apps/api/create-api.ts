import { Hono } from "hono";
import { z } from "zod";
import {
  createLinkSchema,
  createTextSchema,
  listItemsQuerySchema,
  updateItemSchema,
  uploadCreateSchema,
  type ApiError,
  type ExportBundle,
} from "../../packages/contracts";
import type { Identity, RuntimeServices } from "./platform";

type Bindings = { services: RuntimeServices };
type Variables = { identity: Identity; requestId: string };

const api = new Hono<{ Bindings: Bindings; Variables: Variables }>();
// 批量操作故意限制为 200 个 ID，避免一次请求把数据库、对象存储和响应都推入不可控的规模。
const bulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["trash", "restore", "purge"]),
});

function errorResponse(
  requestId: string,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500,
) {
  return Response.json(
    { error: { code, message, requestId } } satisfies ApiError,
    { status },
  );
}

async function parseJson(request: Request): Promise<unknown> {
  // API 只接受小型元数据 JSON；文件正文走分片上传接口，避免把大请求读入内存。
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 128 * 1024) throw new Error("JSON 请求过大");
  return request.json();
}

api.use("/api/*", async (c, next) => {
  // 所有 API 共享一个请求 ID：返回给客户端用于排障，同时写入错误日志便于串联请求。
  const requestId = crypto.randomUUID();
  c.set("requestId", requestId);
  c.header("x-request-id", requestId);

  const method = c.req.method.toUpperCase();
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    // 浏览器修改数据时必须带同源 Origin；读取请求不依赖 Origin，方便下载和健康检查。
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      return errorResponse(requestId, "INVALID_ORIGIN", "请求来源不受信任", 403);
    }
  }
  await next();
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

api.use("/api/*", async (c, next) => {
  // 认证中间件位于所有业务路由之前，确保 ownerId 来自服务端会话而不是客户端参数。
  const identity = await c.env.services.resolveIdentity(c.req.raw);
  if (!identity) {
    return errorResponse(c.get("requestId"), "UNAUTHENTICATED", "请先登录", 401);
  }
  c.set("identity", identity);
  await c.env.services.metadata.ensureSchema();
  c.set("identity", identity);
  await next();
});

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

api.post("/api/uploads", async (c) => {
  const parsed = uploadCreateSchema.safeParse(await parseJson(c.req.raw));
  if (!parsed.success) {
    return errorResponse(c.get("requestId"), "INVALID_UPLOAD", "文件信息无效或超过 500 MB", 400);
  }
  const ownerId = c.get("identity").ownerId;
  const objectKey = `objects/${crypto.randomUUID()}`;
  // 先创建存储供应商的 multipart 会话，再在同一个请求中原子预留数据库配额。
  // 任一步失败都要主动 abort，避免留下无法被用户看到的孤儿 multipart 会话。
  const providerUploadId = await c.env.services.blobs.createMultipart(objectKey, parsed.data.mimeType);
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
    await c.env.services.blobs.abortMultipart(objectKey, providerUploadId).catch(() => undefined);
    throw error;
  }
  if (!upload) {
    await c.env.services.blobs.abortMultipart(objectKey, providerUploadId).catch(() => undefined);
    return errorResponse(c.get("requestId"), "QUOTA_EXCEEDED", "存储配额不足，请先清理文件", 409);
  }
  return c.json(upload, 201);
});

api.get("/api/uploads/:id", async (c) => {
  const upload = await c.env.services.metadata.getUpload(c.get("identity").ownerId, c.req.param("id"));
  if (!upload || !["uploading", "completed"].includes(upload.status)) return errorResponse(c.get("requestId"), "NOT_FOUND", "上传任务不存在", 404);
  return c.json(upload);
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
  const next = await c.env.services.metadata.saveUploadPart(ownerId, upload.id, {
    partNumber,
    etag,
    sizeBytes: bytes.byteLength,
  });
  return c.json(next);
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
    await c.env.services.blobs.completeMultipart(
      upload.objectKey,
      upload.providerUploadId,
      upload.parts,
      upload.mimeType,
    );
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
  await c.env.services.blobs.abortMultipart(pending.objectKey, pending.providerUploadId);
  // 只有对象存储 abort 成功后才把数据库状态改为 cancelled；失败时保留 cancelling 供定时清理重试。
  await c.env.services.metadata.finishUploadCleanup(ownerId, pending.id, "cancelled");
  return c.json({ cancelled: true });
});

api.get("/api/files/:id", async (c) => {
  const item = await c.env.services.metadata.getItem(c.get("identity").ownerId, c.req.param("id"));
  if (!item || item.type !== "file" || !item.objectKey) {
    return errorResponse(c.get("requestId"), "NOT_FOUND", "文件不存在", 404);
  }
  const object = await c.env.services.blobs.get(item.objectKey);
  if (!object) return errorResponse(c.get("requestId"), "FILE_MISSING", "文件数据不可用", 404);
  const inline = Boolean(item.mimeType?.startsWith("image/") && item.mimeType !== "image/svg+xml");
  // 图片可内联预览，但 SVG 和其他文件始终下载，降低主动执行/嗅探内容的风险。
  const fileName = item.displayName || item.originalName || "download";
  const headers = new Headers({
    "content-type": inline ? object.contentType : "application/octet-stream",
    "content-length": String(object.size),
    "content-disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(fileName)}`,
    "x-content-type-options": "nosniff",
    "cache-control": "private, no-store",
  });
  if (object.etag) headers.set("etag", object.etag);
  return new Response(object.body, { headers });
});

api.get("/api/export", async (c) => {
  const items = await c.env.services.metadata.listAllForExport(c.get("identity").ownerId);
  const bundle: ExportBundle = {
    format: "drop-worker-export",
    version: 1,
    exportedAt: new Date().toISOString(),
    items,
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
