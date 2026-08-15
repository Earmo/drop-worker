import type { AuthProvider, AuthSessionStore, Identity, MailAddress, MailSender } from "../platform";
import {
  AUTH_CHALLENGE_SECONDS,
  AUTH_MAX_ATTEMPTS,
  AUTH_OTP_SUBJECT,
  AUTH_RESEND_SECONDS,
  AUTH_SESSION_COOKIE,
  AUTH_SESSION_SECONDS,
  authError,
  authOtpHtml,
  authOtpText,
  createSessionCookie,
  normalizeEmail,
  parseAuthJson,
  readCookie,
} from "./shared";

/** OTP 认证只依赖这些平台无关的配置，SMTP 连接由运行时注入的 MailSender 负责。 */
export type EmailOtpAuthConfig = {
  email: string;
  from: MailAddress;
  sessionSecret: string;
  secureCookie: boolean;
  ownerIdPrefix: string;
};

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function randomCode(): string {
  const values = new Uint32Array(1);
  const limit = Math.floor(0x1_0000_0000 / 1_000_000) * 1_000_000;
  // 拒绝会产生偏差的尾部随机数，再映射到六位数字，保证每个验证码概率一致。
  do {
    crypto.getRandomValues(values);
  } while (values[0] >= limit);
  return String(values[0] % 1_000_000).padStart(6, "0");
}

function randomToken(): string {
  // 会话令牌只在响应 Cookie 中出现，数据库仅保存 SHA-256(token)。
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function constantTimeEqual(left: string, right: string): boolean {
  // 验证摘要时不在第一个不同字节处提前返回，减少时序侧信道。
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

/**
 * 跨 Node.js 与 Cloudflare Worker 共用的邮箱验证码认证流程。
 * 存储端口负责挑战和会话持久化，邮件端口负责具体 SMTP 连接。
 */
export class EmailOtpAuth implements AuthProvider {
  readonly mode = "smtp-otp" as const;
  private readonly email: string;
  private readonly from: MailAddress;

  constructor(
    private readonly metadata: AuthSessionStore,
    private readonly config: EmailOtpAuthConfig,
    private readonly mailer: MailSender,
  ) {
    this.email = normalizeEmail(config.email);
    this.from = {
      address: normalizeEmail(config.from.address),
      name: config.from.name?.replace(/[\r\n"]/g, "").trim() || "Drop Worker",
    };
    if (!this.email || !this.from.address || !config.sessionSecret || !config.ownerIdPrefix) {
      throw new Error("邮箱验证码认证配置不完整");
    }
  }

  close(): void {
    void this.mailer.close?.();
  }

  async resolveIdentity(request: Request): Promise<Identity | null> {
    // Cookie 只作为索引，数据库校验哈希和过期时间后才返回 owner 身份。
    const token = readCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return null;
    const row = await this.metadata.getAuthSession(await sha256(token), Date.now());
    return row ? { ownerId: row.ownerId, email: row.email } : null;
  }

  async handle(request: Request): Promise<Response | null> {
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/request-otp" && request.method === "POST") {
      return this.requestOtp(request);
    }
    if (url.pathname === "/api/auth/verify-otp" && request.method === "POST") {
      return this.verifyOtp(request);
    }
    if (url.pathname === "/api/auth/logout" && request.method === "POST") {
      return this.logout(request);
    }
    return null;
  }

  private async requestOtp(request: Request): Promise<Response> {
    // 只允许配置的个人邮箱，并按最近一次挑战做 60 秒发送限流。
    const body = await parseAuthJson(request);
    if (typeof body?.email !== "string" || normalizeEmail(body.email) !== this.email) {
      return authError("INVALID_EMAIL", "该邮箱无权访问", 401);
    }

    const now = Date.now();
    const latest = await this.metadata.getLatestAuthChallenge(this.email);
    if (latest && now - latest.createdAt < AUTH_RESEND_SECONDS * 1000) {
      return authError("OTP_RATE_LIMITED", "验证码发送过于频繁，请稍后再试", 429);
    }

    const challengeId = crypto.randomUUID();
    const code = randomCode();
    const codeHash = await sha256(`${challengeId}:${code}:${this.config.sessionSecret}`);
    await this.metadata.replaceAuthChallenge({
      id: challengeId,
      email: this.email,
      codeHash,
      attempts: 0,
      createdAt: now,
      expiresAt: now + AUTH_CHALLENGE_SECONDS * 1000,
    });

    try {
      await this.mailer.send({
        from: this.from,
        to: this.email,
        subject: AUTH_OTP_SUBJECT,
        text: authOtpText(code),
        html: authOtpHtml(code),
      });
    } catch (error) {
      // 发信失败时撤销刚写入的挑战，避免用户无法收到邮件却仍保留可猜测凭据。
      await this.metadata.deleteAuthChallenge(challengeId);
      console.error(JSON.stringify({
        message: "otp email delivery failed",
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
        error: error instanceof Error ? error.message : "unknown",
      }));
      return authError("OTP_DELIVERY_FAILED", "验证码邮件发送失败，请稍后重试", 500);
    }

    return Response.json(
      { challengeId, expiresInSeconds: AUTH_CHALLENGE_SECONDS },
      { headers: { "cache-control": "no-store" } },
    );
  }

  private async verifyOtp(request: Request): Promise<Response> {
    // 先原子增加尝试次数，再比较摘要，避免并发请求绕过最大尝试次数。
    const body = await parseAuthJson(request);
    if (
      typeof body?.email !== "string" ||
      typeof body?.challengeId !== "string" ||
      typeof body?.code !== "string" ||
      normalizeEmail(body.email) !== this.email ||
      !/^\d{6}$/.test(body.code)
    ) {
      return authError("INVALID_CODE", "验证码无效", 401);
    }

    const row = await this.metadata.getAuthChallenge(body.challengeId, this.email);
    if (!row || row.expiresAt <= Date.now()) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }
    if (!(await this.metadata.incrementAuthChallengeAttempts(row.id, AUTH_MAX_ATTEMPTS))) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }

    const providedHash = await sha256(`${row.id}:${body.code}:${this.config.sessionSecret}`);
    if (!constantTimeEqual(providedHash, row.codeHash)) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }
    // 只有第一个并发成功请求能删除挑战，防止同一验证码重复签发会话。
    if (!(await this.metadata.deleteAuthChallenge(row.id))) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }
    return this.createSession();
  }

  private async createSession(): Promise<Response> {
    const token = randomToken();
    const now = Date.now();
    await this.metadata.deleteExpiredSessions(now);
    await this.metadata.createAuthSession({
      id: crypto.randomUUID(),
      tokenHash: await sha256(token),
      ownerId: `${this.config.ownerIdPrefix}:${(await sha256(this.email)).slice(0, 24)}`,
      email: this.email,
      createdAt: now,
      expiresAt: now + AUTH_SESSION_SECONDS * 1000,
    });
    return Response.json(
      { authenticated: true, email: this.email },
      {
        headers: {
          "set-cookie": createSessionCookie(token, this.config.secureCookie),
          "cache-control": "no-store",
        },
      },
    );
  }

  private async logout(request: Request): Promise<Response> {
    // 删除服务端会话与清空 Cookie 都是幂等操作，重复点击退出不会产生错误。
    const token = readCookie(request, AUTH_SESSION_COOKIE);
    if (token) await this.metadata.deleteAuthSession(await sha256(token));
    return Response.json(
      { authenticated: false },
      {
        headers: {
          "set-cookie": createSessionCookie("", this.config.secureCookie, 0),
          "cache-control": "no-store",
        },
      },
    );
  }
}
