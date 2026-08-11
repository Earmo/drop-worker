import type { ShareStatus, ShareSummary } from "../../packages/contracts";
import type { StoredShare } from "./platform";

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
  if (share.revokedAt !== null || share.item.deletedAt !== null) return "revoked";
  return share.expiresAt <= now ? "expired" : "active";
}

function itemLabel(share: StoredShare): string {
  if (share.item.type === "file") {
    return share.item.displayName || share.item.originalName || "未命名文件";
  }
  const content = share.item.content?.trim() || "未命名文本";
  return content.length > 80 ? `${content.slice(0, 80)}…` : content;
}

export function shareSummary(
  share: StoredShare,
  now: number,
  publicUrl: URL,
  token?: string,
): ShareSummary {
  const status = shareStatus(share, now);
  const shareUrl = status === "active" && token
    ? new URL(`/s/${token}`, publicUrl).toString()
    : null;
  return {
    id: share.id,
    itemId: share.itemId,
    itemType: share.item.type === "file" ? "file" : "text",
    itemLabel: itemLabel(share),
    accessMode: share.accessMode,
    status,
    createdAt: share.createdAt,
    expiresAt: share.expiresAt,
    revokedAt: share.revokedAt,
    accessCount: share.accessCount,
    downloadCount: share.downloadCount,
    lastAccessedAt: share.lastAccessedAt,
    shareUrl,
  };
}

function cookieValue(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
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
  const cookie = cookieValue(request, SHARE_COOKIE);
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
