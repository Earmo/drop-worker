import type { Identity } from "../apps/api/platform";
import { sendSmtpMessage } from "./smtp";

const SESSION_COOKIE = "drop_worker_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;
const CHALLENGE_SECONDS = 10 * 60;
const RESEND_SECONDS = 60;
const MAX_ATTEMPTS = 5;

type SessionRow = {
  owner_id: string;
  email: string;
};

type ChallengeRow = {
  id: string;
  email: string;
  code_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
};

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

// 验证码和会话只保存哈希值；即使数据库被读取，也不能直接还原可用凭据。
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

function base64Utf8(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function headerSafe(value: string): string {
  return value.replace(/[\r\n"]/g, "").trim() || "drop-worker";
}

function otpMime(from: string, fromName: string, to: string, code: string): string {
  // 同时提供 text/plain 和 HTML 两个 MIME part，兼容纯文本邮件客户端。
  const subject = "drop-worker 登录验证码";
  const text = `你的验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`;
  const html = `<p>你的 drop-worker 登录验证码是：</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p><p>验证码 10 分钟内有效。若非本人操作，请忽略本邮件。</p>`;
  const boundary = `drop-worker-${crypto.randomUUID()}`;
  const raw = [
    `From: ${headerSafe(fromName)} <${from}>`,
    `To: ${to}`,
    `Subject: =?UTF-8?B?${base64Utf8(subject)}?=`,
    `Date: ${new Date().toUTCString()}`,
    `Message-ID: <${crypto.randomUUID()}@${from.split("@")[1]}>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/alternative; boundary="${boundary}"`,
    "",
    `--${boundary}`,
    "Content-Type: text/plain; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Utf8(text),
    `--${boundary}`,
    "Content-Type: text/html; charset=UTF-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Utf8(html),
    `--${boundary}--`,
    "",
  ].join("\r\n");
  return raw;
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

function cookieValue(request: Request, name: string): string | null {
  const cookie = request.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...rest] = part.trim().split("=");
    if (key === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

function sessionCookie(token: string, maxAge = SESSION_SECONDS): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

function authError(
  code: string,
  message: string,
  status: 400 | 401 | 429 | 500,
): Response {
  return Response.json(
    { error: { code, message, requestId: crypto.randomUUID() } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

async function jsonBody(request: Request): Promise<Record<string, unknown> | null> {
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

export class CloudflareEmailAuth {
  private readonly email: string;
  private readonly fromEmail: string;
  private readonly fromName: string;
  private readonly provider: "cloudflare" | "smtp";
  private readonly smtp: {
    host: string;
    port: number;
    secure: boolean;
    username: string;
    password: string;
    timeoutMs: number;
  } | null;

  constructor(private readonly env: Env) {
    this.email = normalizedEmail(env.OWNER_EMAIL || "");
    this.fromEmail = normalizedEmail(env.SMTP_FROM || env.AUTH_FROM_EMAIL || "");
    this.fromName = headerSafe(env.AUTH_FROM_NAME || "drop-worker");
    this.provider = env.AUTH_EMAIL_PROVIDER === "smtp" ? "smtp" : "cloudflare";
    const smtpHost = (env.SMTP_HOST || "").trim();
    const smtpPort = Number(env.SMTP_PORT || 587);
    this.smtp = this.provider === "smtp"
      ? {
          host: smtpHost,
          port: smtpPort,
          secure: env.SMTP_SECURE === "true" || smtpPort === 465,
          username: env.SMTP_USERNAME || "",
          password: env.SMTP_PASSWORD || "",
          timeoutMs: Math.min(Math.max(Number(env.SMTP_TIMEOUT_MS || 15_000), 3_000), 30_000),
        }
      : null;
    // 配置在 Worker 初始化时一次性校验，避免请求处理中途才发现无法发信或无法签发会话。
    if (!this.email || !this.fromEmail || !env.AUTH_SESSION_SECRET || (this.provider === "smtp" && (!this.smtp?.host || ![465, 587].includes(this.smtp.port)))) {
      throw new Error("邮箱验证码认证配置不完整");
    }
  }

  async resolveIdentity(request: Request): Promise<Identity | null> {
    // Cookie 只携带随机令牌；服务端用哈希和未过期条件查询，避免把令牌明文存入 D1。
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) return null;
    const row = await this.env.DB.prepare(
      `SELECT owner_id, email FROM local_sessions
       WHERE token_hash = ? AND expires_at > ?`,
    ).bind(await sha256(token), Date.now()).first<SessionRow>();
    return row ? { ownerId: row.owner_id, email: row.email } : null;
  }

  async handle(request: Request): Promise<Response | null> {
    // 认证接口保持很小的显式路由表，其他 /api/auth/* 路径交给上层返回 404。
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
    // 第一步只允许配置的个人邮箱，并按最近一次挑战做 60 秒发送限流。
    const body = await jsonBody(request);
    if (typeof body?.email !== "string" || normalizedEmail(body.email) !== this.email) {
      return authError("INVALID_EMAIL", "该邮箱无权访问", 401);
    }

    const now = Date.now();
    const latest = await this.env.DB.prepare(
      `SELECT id, email, code_hash, attempts, created_at, expires_at
       FROM auth_challenges WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
    ).bind(this.email).first<ChallengeRow>();
    if (latest && now - latest.created_at < RESEND_SECONDS * 1000) {
      return authError("OTP_RATE_LIMITED", "验证码发送过于频繁，请稍后再试", 429);
    }

    const challengeId = crypto.randomUUID();
    const code = randomCode();
    const codeHash = await sha256(`${challengeId}:${code}:${this.env.AUTH_SESSION_SECRET}`);
    // 用 batch 删除旧挑战并写入新挑战，避免同一邮箱同时存在多个可用验证码。
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM auth_challenges WHERE email = ? OR expires_at <= ?")
        .bind(this.email, now),
      this.env.DB.prepare(
        `INSERT INTO auth_challenges (id, email, code_hash, attempts, created_at, expires_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      ).bind(challengeId, this.email, codeHash, now, now + CHALLENGE_SECONDS * 1000),
    ]);

    try {
      // 先组装一次原始邮件内容，再按配置选择 Cloudflare Email Service 或自定义 SMTP。
      const raw = otpMime(this.fromEmail, this.fromName, this.email, code);
      if (this.provider === "smtp" && this.smtp) {
        await sendSmtpMessage(this.smtp, { from: this.fromEmail, to: this.email, raw });
      } else {
        const { EmailMessage: CloudflareEmailMessage } = await import("cloudflare:email");
        await this.env.EMAIL.send(new CloudflareEmailMessage(this.fromEmail, this.email, raw));
      }
    } catch (error) {
      // 发信失败时撤销刚写入的挑战，否则用户会收到“发送失败”但仍可猜测/使用旧状态的窗口。
      await this.env.DB.prepare("DELETE FROM auth_challenges WHERE id = ?").bind(challengeId).run();
      console.error(JSON.stringify({
        message: "otp email delivery failed",
        code: error && typeof error === "object" && "code" in error ? String(error.code) : undefined,
        error: error instanceof Error ? error.message : "unknown",
      }));
      return authError("OTP_DELIVERY_FAILED", "验证码邮件发送失败，请稍后重试", 500);
    }

    return Response.json(
      { challengeId, expiresInSeconds: CHALLENGE_SECONDS },
      { headers: { "cache-control": "no-store" } },
    );
  }

  private async verifyOtp(request: Request): Promise<Response> {
    // 校验顺序：格式/邮箱 -> 挑战存在且未过期 -> 增加尝试次数 -> 常量时间比对摘要。
    const body = await jsonBody(request);
    if (
      typeof body?.email !== "string" ||
      typeof body.challengeId !== "string" ||
      typeof body.code !== "string" ||
      normalizedEmail(body.email) !== this.email ||
      !/^\d{6}$/.test(body.code)
    ) {
      return authError("INVALID_CODE", "验证码无效", 401);
    }

    const row = await this.env.DB.prepare(
      `SELECT id, email, code_hash, attempts, created_at, expires_at
       FROM auth_challenges WHERE id = ? AND email = ?`,
    ).bind(body.challengeId, this.email).first<ChallengeRow>();
    if (!row || row.expires_at <= Date.now() || row.attempts >= MAX_ATTEMPTS) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }

    await this.env.DB.prepare(
      "UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?",
    ).bind(row.id).run();
    const providedHash = await sha256(`${row.id}:${body.code}:${this.env.AUTH_SESSION_SECRET}`);
    if (!constantTimeEqual(providedHash, row.code_hash)) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }

    const token = randomToken();
    const now = Date.now();
    const ownerId = `email:${(await sha256(this.email)).slice(0, 24)}`;
    // 验证成功后一次性清除验证码、清理旧会话并创建 30 天会话，减少重放和脏数据。
    await this.env.DB.batch([
      this.env.DB.prepare("DELETE FROM auth_challenges WHERE email = ?").bind(this.email),
      this.env.DB.prepare("DELETE FROM local_sessions WHERE expires_at <= ?").bind(now),
      this.env.DB.prepare(
        `INSERT INTO local_sessions (id, token_hash, owner_id, email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        crypto.randomUUID(),
        await sha256(token),
        ownerId,
        this.email,
        now,
        now + SESSION_SECONDS * 1000,
      ),
    ]);
    return Response.json(
      { authenticated: true, email: this.email },
      {
        headers: {
          "set-cookie": sessionCookie(token),
          "cache-control": "no-store",
        },
      },
    );
  }

  private async logout(request: Request): Promise<Response> {
    // 删除服务端会话并让浏览器立即过期 Cookie；即使没有 Cookie 也返回幂等成功。
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) {
      await this.env.DB.prepare("DELETE FROM local_sessions WHERE token_hash = ?")
        .bind(await sha256(token))
        .run();
    }
    return Response.json(
      { authenticated: false },
      {
        headers: {
          "set-cookie": sessionCookie("", 0),
          "cache-control": "no-store",
        },
      },
    );
  }
}
