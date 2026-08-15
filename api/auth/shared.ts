/**
 * Node.js 与 Cloudflare 认证适配器共用的协议常量和 HTTP 辅助函数。
 *
 * 这里不依赖任何平台 API，平台专属的哈希、随机数和持久化仍由各自适配器负责。
 */
export const AUTH_SESSION_COOKIE = "drop_worker_session";
export const AUTH_SESSION_SECONDS = 30 * 24 * 60 * 60;
export const AUTH_CHALLENGE_SECONDS = 10 * 60;
export const AUTH_RESEND_SECONDS = 60;
export const AUTH_MAX_ATTEMPTS = 5;
export const AUTH_OTP_SUBJECT = "Drop Worker 登录验证码";

export function normalizeEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

export function authOtpText(code: string): string {
  return `你的验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`;
}

/** HTML 正文只包含固定文案和六位数字验证码，供各运行时的 SMTP 适配器复用。 */
export function authOtpHtml(code: string): string {
  return `<p>你的 Drop Worker 登录验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>验证码 10 分钟内有效。若非本人操作，请忽略本邮件。</p>`;
}

export function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key !== name) continue;
    try {
      return decodeURIComponent(rest.join("="));
    } catch {
      return null;
    }
  }
  return null;
}

export function createSessionCookie(
  token: string,
  secure: boolean,
  maxAge = AUTH_SESSION_SECONDS,
): string {
  const attributes = [
    `${AUTH_SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

export function authError(
  code: string,
  message: string,
  status: 400 | 401 | 429 | 500 = 400,
): Response {
  return Response.json(
    { error: { code, message, requestId: crypto.randomUUID() } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

export async function parseAuthJson(request: Request): Promise<Record<string, unknown> | null> {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 16 * 1024) return null;
  try {
    const value: unknown = await request.json();
    return value !== null && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}
