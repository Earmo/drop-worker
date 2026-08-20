/**
 * 分享口令、签名和 Cookie 辅助函数。
 *
 * 路由层只处理 HTTP；token 哈希、四位口令加密和访客 Cookie 都集中在这里，
 * 避免公开接口与属主管理接口各自实现一套校验。
 */
import { isHttpOrHttpsUrl, type PublicShareMember, type ShareStatus, type ShareSummary } from "../../packages/contracts";
import type { StoredItem, StoredShare, StoredShareMember } from "../platform";
import { readCookie } from "../auth/shared";

const encoder = new TextEncoder();
const SHARE_COOKIE = "drop_share_access";
const VERIFIED_SECONDS = 24 * 60 * 60;

export function isLoopbackPublicUrl(url: URL): boolean {
  return url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
}

export function validatePublicUrl(value: string, allowInsecureHttp = false): URL {
  const url = new URL(value);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("PUBLIC_URL 必须使用 HTTP 或 HTTPS");
  }
  if (url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new Error("PUBLIC_URL 必须是没有路径、查询参数或凭据的站点根地址");
  }
  if (url.protocol === "http:" && !isLoopbackPublicUrl(url) && !allowInsecureHttp) {
    throw new Error("非本地 PUBLIC_URL 必须使用 HTTPS");
  }
  return url;
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> | null {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
    const binary = atob(padded);
    const bytes = new Uint8Array(binary.length);
    for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
    return bytes;
  } catch {
    return null;
  }
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

async function encryptionKey(secret: string): Promise<CryptoKey> {
  const material = await crypto.subtle.digest("SHA-256", encoder.encode(`share-code-encryption:${secret}`));
  return crypto.subtle.importKey("raw", material, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}

export async function encryptShareCode(secret: string, shareId: string, code: string): Promise<string> {
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(shareId) },
    await encryptionKey(secret),
    encoder.encode(code),
  );
  return `v1.${bytesToBase64Url(nonce)}.${bytesToBase64Url(new Uint8Array(ciphertext))}`;
}

export async function decryptShareCode(secret: string, shareId: string, encrypted: string | null): Promise<string | null> {
  if (!encrypted) return null;
  const [version, nonceValue, ciphertextValue] = encrypted.split(".");
  const nonce = nonceValue ? base64UrlToBytes(nonceValue) : null;
  const ciphertext = ciphertextValue ? base64UrlToBytes(ciphertextValue) : null;
  if (version !== "v1" || !nonce || nonce.length !== 12 || !ciphertext) return null;
  try {
    const plaintext = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonce, additionalData: encoder.encode(shareId) },
      await encryptionKey(secret),
      ciphertext,
    );
    const code = new TextDecoder().decode(plaintext);
    return /^\d{4}$/.test(code) ? code : null;
  } catch {
    return null;
  }
}

export async function keyedDigest(secret: string, purpose: string, value: string): Promise<string> {
  const signature = await crypto.subtle.sign(
    "HMAC",
    await hmacKey(secret),
    encoder.encode(`${purpose}:${value}`),
  );
  return bytesToBase64Url(new Uint8Array(signature));
}

export async function verifyKeyedDigest(
  secret: string,
  purpose: string,
  value: string,
  expected: string,
): Promise<boolean> {
  const signature = base64UrlToBytes(expected);
  if (!signature) return false;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`${purpose}:${value}`),
  );
}

export async function tokenForShare(secret: string, shareId: string): Promise<string> {
  return keyedDigest(secret, "share-token", shareId);
}

export function randomShareToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export function randomShareCode(): string {
  const sample = new Uint16Array(1);
  do crypto.getRandomValues(sample); while (sample[0]! >= 60_000);
  return String(sample[0]! % 10_000).padStart(4, "0");
}

export function shareStatus(share: StoredShare, now: number): ShareStatus {
  if (share.revokedAt !== null || activeShareMembers(share).length === 0) return "revoked";
  return share.expiresAt <= now ? "expired" : "active";
}

function itemLabel(item: StoredItem): string {
  if (item.type === "file") {
    return item.displayName || item.originalName || "未命名文件";
  }
  if (item.type === "link") {
    // 自动集合名用标题或主机名，避免把完整 URL 写进管理列表。
    const title = item.title?.trim();
    if (title) return title;
    try {
      return new URL(item.content || "").hostname || "未命名链接";
    } catch {
      return "未命名链接";
    }
  }
  const content = item.content?.trim() || "未命名文本";
  return content.length > 80 ? `${content.slice(0, 80)}…` : content;
}

/** 公开访问和管理摘要只消费仍有效且未进回收站的成员。 */
export function activeShareMembers(share: StoredShare): Array<StoredShareMember & { item: StoredItem }> {
  return share.members.filter(
    (member): member is StoredShareMember & { item: StoredItem } =>
      member.removedAt === null && member.item !== null && member.item.deletedAt === null
        && (member.item.type === "text" || member.item.type === "file" || member.item.type === "link"),
  );
}

/**
 * 组装访客可见成员。非法协议的链接按已失效剔除，不进入公开响应，也不做静默修复。
 */
export function publicShareMembers(share: StoredShare): PublicShareMember[] {
  const members: PublicShareMember[] = [];
  for (const member of activeShareMembers(share)) {
    if (member.item.type === "file") {
      members.push({
        id: member.itemId,
        type: "file",
        fileName: member.item.displayName || member.item.originalName || "download",
        mimeType: member.item.mimeType || "application/octet-stream",
        sizeBytes: member.item.sizeBytes,
        updatedAt: member.item.updatedAt,
      });
      continue;
    }
    if (member.item.type === "link") {
      const url = member.item.content || "";
      if (!isHttpOrHttpsUrl(url)) continue;
      members.push({
        id: member.itemId,
        type: "link",
        url,
        title: member.item.title || "",
        updatedAt: member.item.updatedAt,
      });
      continue;
    }
    members.push({
      id: member.itemId,
      type: "text",
      content: member.item.content || "",
      updatedAt: member.item.updatedAt,
    });
  }
  return members;
}

/** 自定义名称保持稳定；自动名称始终跟随当前首个成员和成员数量。 */
export function shareDisplayName(share: StoredShare): string {
  if (share.name?.trim()) return share.name.trim();
  const members = activeShareMembers(share);
  const first = members[0]?.item;
  if (!first) return "已终止的分享集合";
  const label = itemLabel(first);
  return members.length === 1 ? label : `${label} 等 ${members.length} 项`;
}

export function shareSummary(
  share: StoredShare,
  now: number,
  publicUrl: URL,
  token?: string,
  code?: string | null,
): ShareSummary {
  const status = shareStatus(share, now);
  const members = activeShareMembers(share);
  const shareUrl = status === "active" && token
    ? new URL(`/s/${token}`, publicUrl).toString()
    : null;
  return {
    id: share.id,
    name: shareDisplayName(share),
    customName: share.name,
    members: members.map((member) => ({
      itemId: member.itemId,
      itemType: member.item.type,
      itemLabel: itemLabel(member.item),
      position: member.position,
      addedAt: member.addedAt,
      downloadCount: member.downloadCount,
    })),
    itemCount: members.length,
    accessMode: share.accessMode,
    status,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    accessCount: share.accessCount,
    downloadCount: share.downloadCount,
    lastAccessedAt: share.lastAccessedAt,
    shareUrl,
    code: share.accessMode === "code" && status === "active" ? code ?? null : null,
  };
}

export async function createShareCookie(input: {
  shareId: string;
  token: string;
  secret: string;
  expiresAt: number;
  now: number;
  secure: boolean;
}): Promise<string> {
  const cookieExpiresAt = Math.min(input.expiresAt, input.now + VERIFIED_SECONDS * 1000);
  const payload = `${input.shareId}.${cookieExpiresAt}`;
  const signature = await keyedDigest(input.secret, "share-cookie", payload);
  const maxAge = Math.max(0, Math.floor((cookieExpiresAt - input.now) / 1000));
  const attributes = [
    `${SHARE_COOKIE}=${encodeURIComponent(`${payload}.${signature}`)}`,
    `Path=/api/public/shares/${input.token}`,
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (input.secure) attributes.push("Secure");
  return attributes.join("; ");
}

export async function hasShareCookie(
  request: Request,
  shareId: string,
  secret: string,
  now: number,
): Promise<boolean> {
  const cookie = readCookie(request, SHARE_COOKIE);
  if (!cookie) return false;
  const parts = cookie.split(".");
  if (parts.length !== 3 || parts[0] !== shareId) return false;
  const expiresAt = Number(parts[1]);
  const signature = base64UrlToBytes(parts[2]!);
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || !signature) return false;
  const payload = `${shareId}.${expiresAt}`;
  return crypto.subtle.verify(
    "HMAC",
    await hmacKey(secret),
    signature,
    encoder.encode(`share-cookie:${payload}`),
  );
}
