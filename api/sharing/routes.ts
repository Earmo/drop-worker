import {
  createShareSchema,
  verifyShareSchema,
  type PublicShareContent,
} from "../../packages/contracts";
import { fileDownloadResponse, isPreviewableImage, publicFileRedirect } from "../download";
import { errorResponse, parseJson, type ApiApp } from "../http";
import type { AppContext } from "../platform";
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
} from "./helpers";

/**
 * 用公开 token 解析仍有效的分享。token 过短或过长直接拒绝，避免对存储做无意义哈希查询。
 */
async function resolvePublicShare(services: AppContext, token: string, now: number) {
  if (!services.sharing.enabled || token.length < 32 || token.length > 128) return null;
  const tokenHash = await keyedDigest(services.sharing.secret, "share-token-hash", token);
  const share = await services.metadata.shares.getShareByTokenHash(tokenHash);
  if (!share || shareStatus(share, now) !== "active") return null;
  if (share.item.type !== "text" && share.item.type !== "file") return null;
  return share;
}

/**
 * 公开分享路由必须在登录中间件之前注册：访客没有属主会话，只靠 token 和可选口令 Cookie。
 */
export function registerPublicShareRoutes(api: ApiApp): void {
  api.use("/api/public/shares/*", async (c, next) => {
    await next();
    c.header("cache-control", "private, no-store");
    c.header("x-robots-tag", "noindex, nofollow, noarchive");
  });

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
    await c.env.services.metadata.shares.recordShareAccess(share.id, now, false);
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
    const previous = await c.env.services.metadata.shares.getShareAttempt(share.id, sourceHash);
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
      const attempt = await c.env.services.metadata.shares.recordShareFailure(share.id, sourceHash, now);
      const locked = attempt.lockedUntil > now;
      return errorResponse(
        c.get("requestId"),
        locked ? "SHARE_CODE_LOCKED" : "INVALID_SHARE_CODE",
        locked ? "尝试次数过多，请稍后再试" : "访问口令无效",
        locked ? 429 : 401,
      );
    }
    await c.env.services.metadata.shares.deleteShareAttempt(share.id, sourceHash);
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
      ? await publicFileRedirect(c.env.services.blobs, c.env.services.publicFilesUrl, share.item.objectKey)
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
      await c.env.services.metadata.shares.recordShareAccess(share.id, now, true);
    }
    response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return response;
  });
}

/**
 * 属主分享管理：创建、列表和撤销都要求登录，并且只能操作自己的条目。
 */
export function registerShareRoutes(api: ApiApp): void {
  api.get("/api/shares", async (c) => {
    const now = Date.now();
    const shares = await c.env.services.metadata.shares.listShares(
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
    const item = await c.env.services.metadata.items.getItem(ownerId, c.req.param("id"));
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
    const share = await c.env.services.metadata.shares.createShare({
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
    const share = await c.env.services.metadata.shares.revokeShare(
      c.get("identity").ownerId,
      c.req.param("id"),
      Date.now(),
    );
    if (!share) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在", 404);
    return c.json({ revoked: true });
  });
}
