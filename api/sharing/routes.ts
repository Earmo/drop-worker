import {
  createShareSchema,
  updateShareSchema,
  verifyShareSchema,
  type CreateShareInput,
  type CreateShareResponse,
  type PublicShareContent,
} from "../../packages/contracts";
import { fileDownloadResponse, isPreviewableImage, publicFileRedirect } from "../download";
import { errorResponse, parseJson, type ApiApp } from "../http";
import type { AppContext } from "../platform";
import {
  createShareCookie,
  activeShareMembers,
  decryptShareCode,
  encryptShareCode,
  hasShareCookie,
  keyedDigest,
  randomShareCode,
  shareStatus,
  shareDisplayName,
  shareSummary,
  publicShareMembers,
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
  return share;
}

function publicFileMember(share: Awaited<ReturnType<typeof resolvePublicShare>>, itemId?: string) {
  if (!share) return null;
  const files = activeShareMembers(share).filter((member) => member.item.type === "file");
  if (itemId) return files.find((member) => member.itemId === itemId) || null;
  return files.length === 1 && activeShareMembers(share).length === 1 ? files[0]! : null;
}

async function createShareCollection(
  services: AppContext,
  ownerId: string,
  input: CreateShareInput,
): Promise<CreateShareResponse | null> {
  const id = crypto.randomUUID();
  const token = await tokenForShare(services.sharing.secret, id);
  const tokenHash = await keyedDigest(services.sharing.secret, "share-token-hash", token);
  const generatedCode = input.accessMode === "code" && !input.code ? randomShareCode() : null;
  const code = input.accessMode === "code" ? input.code || generatedCode : null;
  const codeHash = code
    ? await keyedDigest(services.sharing.secret, "share-code", `${id}:${code}`)
    : null;
  const codeEncrypted = code ? await encryptShareCode(services.sharing.secret, id, code) : null;
  const now = Date.now();
  const share = await services.metadata.shares.createShare({
    id,
    ownerId,
    itemIds: input.itemIds,
    name: input.name ?? null,
    tokenHash,
    accessMode: input.accessMode,
    codeHash,
    codeEncrypted,
    now,
    expiresAt: now + input.expiresInSeconds * 1000,
  });
  if (!share) return null;
  const url = new URL(`/s/${token}`, services.sharing.publicUrl);
  if (code) url.hash = `code=${code}`;
  return {
    share: shareSummary(share, now, services.sharing.publicUrl, token, code),
    shareUrl: url.toString(),
    generatedCode,
  };
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
    const members = publicShareMembers(share);
    // 可见成员被协议校验剔空后，按分享已失效处理，避免返回空集合。
    if (members.length === 0) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
    }
    const content: PublicShareContent = {
      name: shareDisplayName(share),
      expiresAt: share.expiresAt,
      members,
    };
    await c.env.services.metadata.shares.recordShareAccess(share.id, now);
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

  api.on(["GET", "HEAD"], [
    "/api/public/shares/:token/preview",
    "/api/public/shares/:token/items/:itemId/preview",
  ], async (c) => {
    const now = Date.now();
    const token = c.req.param("token");
    const share = await resolvePublicShare(c.env.services, token, now);
    if (!share) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或不支持预览", 404);
    }
    if (
      share.accessMode === "code"
      && !(await hasShareCookie(c.req.raw, share.id, c.env.services.sharing.secret, now))
    ) {
      return errorResponse(c.get("requestId"), "SHARE_VERIFICATION_REQUIRED", "请确认访问口令", 401);
    }
    const member = publicFileMember(share, c.req.param("itemId"));
    if (!member || !member.item.objectKey || !isPreviewableImage(member.item.mimeType)) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或不支持预览", 404);
    }
    const response = await fileDownloadResponse({
      request: c.req.raw,
      blobs: c.env.services.blobs,
      objectKey: member.item.objectKey,
      fileName: member.item.displayName || member.item.originalName || "image",
      mimeType: member.item.mimeType,
      attachmentOnly: false,
    });
    if (!response) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
    response.headers.set("x-robots-tag", "noindex, nofollow, noarchive");
    return response;
  });

  api.on(["GET", "HEAD"], [
    "/api/public/shares/:token/download",
    "/api/public/shares/:token/items/:itemId/download",
  ], async (c) => {
    const now = Date.now();
    const token = c.req.param("token");
    const share = await resolvePublicShare(c.env.services, token, now);
    if (!share) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
    }
    if (
      share.accessMode === "code"
      && !(await hasShareCookie(c.req.raw, share.id, c.env.services.sharing.secret, now))
    ) {
      return errorResponse(c.get("requestId"), "SHARE_VERIFICATION_REQUIRED", "请确认访问口令", 401);
    }
    const member = publicFileMember(share, c.req.param("itemId"));
    if (!member || !member.item.objectKey) {
      return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
    }
    const response = c.env.services.publicFilesUrl
      ? await publicFileRedirect(c.env.services.blobs, c.env.services.publicFilesUrl, member.item.objectKey)
      : await fileDownloadResponse({
          request: c.req.raw,
          blobs: c.env.services.blobs,
          objectKey: member.item.objectKey,
          fileName: member.item.displayName || member.item.originalName || "download",
          mimeType: member.item.mimeType,
          attachmentOnly: true,
        });
    if (!response) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在或已失效", 404);
    const startsDownload = !c.req.header("range");
    if (c.req.method === "GET" && startsDownload && (response.status === 200 || response.status === 206 || response.status === 307)) {
      await c.env.services.metadata.shares.recordShareDownload(share.id, member.itemId, now);
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

  api.post("/api/shares", async (c) => {
    if (!c.env.services.sharing.enabled) {
      return errorResponse(c.get("requestId"), "SHARING_DISABLED", "分享功能当前已关闭", 403);
    }
    const parsed = createShareSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_SHARE", "分享设置无效", 400);
    }
    const result = await createShareCollection(c.env.services, c.get("identity").ownerId, parsed.data);
    if (!result) {
      return errorResponse(c.get("requestId"), "SHARE_ITEMS_INVALID", "所选内容已变化或不能分享", 409);
    }
    return c.json(result, 201);
  });

  // 保留旧单项创建入口，使既有客户端自然创建单成员集合而不更换调用路径。
  api.post("/api/items/:id/share", async (c) => {
    if (!c.env.services.sharing.enabled) {
      return errorResponse(c.get("requestId"), "SHARING_DISABLED", "分享功能当前已关闭", 403);
    }
    const payload = await parseJson(c.req.raw);
    const parsed = createShareSchema.safeParse({
      ...(payload && typeof payload === "object" ? payload : {}),
      itemIds: [c.req.param("id")],
    });
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_SHARE", "分享设置无效", 400);
    }
    const result = await createShareCollection(c.env.services, c.get("identity").ownerId, parsed.data);
    if (!result) return errorResponse(c.get("requestId"), "NOT_FOUND", "该内容不能分享", 404);
    return c.json(result, 201);
  });

  api.patch("/api/shares/:id", async (c) => {
    const parsed = updateShareSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_SHARE_UPDATE", "分享集合设置无效", 400);
    }
    const now = Date.now();
    const share = await c.env.services.metadata.shares.updateShare(
      c.get("identity").ownerId,
      c.req.param("id"),
      parsed.data,
      now,
    );
    if (!share) {
      return errorResponse(
        c.get("requestId"),
        "SHARE_UPDATE_CONFLICT",
        "分享集合不存在、已失效或成员已经变化",
        409,
      );
    }
    const token = await tokenForShare(c.env.services.sharing.secret, share.id);
    const code = await decryptShareCode(c.env.services.sharing.secret, share.id, share.codeEncrypted);
    return c.json({ share: shareSummary(share, now, c.env.services.sharing.publicUrl, token, code) });
  });

  api.delete("/api/shares/:id", async (c) => {
    const share = await c.env.services.metadata.shares.revokeShare(
      c.get("identity").ownerId,
      c.req.param("id"),
      Date.now(),
    );
    if (!share) return errorResponse(c.get("requestId"), "NOT_FOUND", "分享不存在", 404);
    return c.json({ revoked: true, terminated: true });
  });
}
