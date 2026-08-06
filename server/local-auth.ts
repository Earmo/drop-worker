import {
  createHash,
  randomBytes,
  randomInt,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import nodemailer from "nodemailer";
import { schemaStatements } from "../db/sql";
import type { Identity, RuntimeServices } from "../apps/api/platform";

const SESSION_COOKIE = "drop_worker_session";
const SESSION_SECONDS = 30 * 24 * 60 * 60;

type LocalAuthConfig = {
  mode: "password" | "smtp-otp";
  email: string;
  passwordHash?: string;
  sessionSecret: string;
  publicUrl: URL;
  insecureHttp: boolean;
  smtp?: {
    host: string;
    port: number;
    secure: boolean;
    user?: string;
    password?: string;
    from: string;
  };
};

type SessionRow = { owner_id: string; email: string; expires_at: number };
type ChallengeRow = {
  id: string;
  email: string;
  code_hash: string;
  attempts: number;
  expires_at: number;
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
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

function sessionCookie(token: string, secure: boolean, maxAge = SESSION_SECONDS): string {
  const attributes = [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ];
  if (secure) attributes.push("Secure");
  return attributes.join("; ");
}

function authError(code: string, message: string, status: 400 | 401 | 429 = 400): Response {
  return Response.json({ error: { code, message, requestId: crypto.randomUUID() } }, { status });
}

export function createPasswordHash(password: string): string {
  // 密码只在管理命令中生成一次；盐值和 scrypt 参数写进格式，便于未来校验时复现算法。
  if (password.length < 12) throw new Error("密码至少需要 12 个字符");
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 32_768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  return `scrypt$32768$8$1$${salt.toString("base64url")}$${key.toString("base64url")}`;
}

function verifyPassword(password: string, stored: string): boolean {
  // 从存储值读取算法参数，而不是依赖当前默认值；最终比较使用 timingSafeEqual。
  const [algorithm, n, r, p, saltValue, keyValue] = stored.split("$");
  if (algorithm !== "scrypt" || !n || !r || !p || !saltValue || !keyValue) return false;
  const expected = Buffer.from(keyValue, "base64url");
  const actual = scryptSync(password, Buffer.from(saltValue, "base64url"), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: 64 * 1024 * 1024,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export class LocalAuth {
  private readonly database: DatabaseSync;
  private readonly ownerId: string;

  constructor(
    databasePath: string,
    private readonly config: LocalAuthConfig,
  ) {
    this.database = new DatabaseSync(databasePath);
    this.database.exec("PRAGMA journal_mode = WAL");
    // 本地模式启动时确保表存在；Cloudflare 模式则要求单独应用正式迁移。
    for (const statement of schemaStatements) this.database.prepare(statement).run();
    this.ownerId = `local:${sha256(normalizedEmail(config.email)).slice(0, 24)}`;
  }

  close(): void {
    this.database.close();
  }

  async resolveIdentity(request: Request): Promise<Identity | null> {
    // Cookie 只作为索引，数据库校验哈希和过期时间后才返回 owner 身份。
    const token = cookieValue(request, SESSION_COOKIE);
    if (!token) return null;
    const row = this.database
      .prepare(
        `SELECT owner_id, email, expires_at FROM local_sessions
         WHERE token_hash = ? AND expires_at > ?`,
      )
      .get(sha256(token), Date.now()) as SessionRow | undefined;
    if (!row) return null;
    return { ownerId: row.owner_id, email: row.email };
  }

  async handle(request: Request): Promise<Response | null> {
    // 本地同时支持密码和邮箱验证码，但每个实例仍只启用配置中的一种 mode。
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return this.loginWithPassword(request);
    }
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

  private async loginWithPassword(request: Request): Promise<Response> {
    // 先检查模式，再同时验证邮箱和密码；对外使用同一错误，避免暴露哪一项不匹配。
    if (this.config.mode !== "password" || !this.config.passwordHash) {
      return authError("AUTH_MODE_MISMATCH", "当前未启用密码登录");
    }
    const body = (await request.json()) as { email?: unknown; password?: unknown };
    if (typeof body.email !== "string" || typeof body.password !== "string") {
      return authError("INVALID_CREDENTIALS", "邮箱或密码错误", 401);
    }
    const emailMatches = normalizedEmail(body.email) === normalizedEmail(this.config.email);
    const passwordMatches = verifyPassword(body.password, this.config.passwordHash);
    if (!emailMatches || !passwordMatches) {
      return authError("INVALID_CREDENTIALS", "邮箱或密码错误", 401);
    }
    return this.createSession();
  }

  private async requestOtp(request: Request): Promise<Response> {
    // OTP 流程：校验唯一邮箱 -> 写入带过期时间的挑战 -> 通过本地 SMTP 发送验证码。
    if (this.config.mode !== "smtp-otp" || !this.config.smtp) {
      return authError("AUTH_MODE_MISMATCH", "当前未启用邮件验证码登录");
    }
    const body = (await request.json()) as { email?: unknown };
    if (typeof body.email !== "string" || normalizedEmail(body.email) !== normalizedEmail(this.config.email)) {
      return authError("INVALID_EMAIL", "该邮箱无权访问", 401);
    }
    const challengeId = crypto.randomUUID();
    const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
    const now = Date.now();
    const codeHash = sha256(`${challengeId}:${code}:${this.config.sessionSecret}`);
    this.database
      .prepare(
        `INSERT INTO auth_challenges (id, email, code_hash, attempts, created_at, expires_at)
         VALUES (?, ?, ?, 0, ?, ?)`,
      )
      .run(challengeId, normalizedEmail(body.email), codeHash, now, now + 10 * 60 * 1000);

    const transport = nodemailer.createTransport({
      host: this.config.smtp.host,
      port: this.config.smtp.port,
      secure: this.config.smtp.secure,
      auth:
        this.config.smtp.user && this.config.smtp.password
          ? { user: this.config.smtp.user, pass: this.config.smtp.password }
          : undefined,
    });
    await transport.sendMail({
      from: this.config.smtp.from,
      to: this.config.email,
      subject: "drop-worker 登录验证码",
      text: `你的验证码是 ${code}，10 分钟内有效。若非本人操作，请忽略本邮件。`,
    });
    return Response.json({ challengeId, expiresInSeconds: 600 });
  }

  private async verifyOtp(request: Request): Promise<Response> {
    // 验证码最多尝试 5 次且 10 分钟过期；每次比对前先递增次数，防止并发重试绕过限制。
    if (this.config.mode !== "smtp-otp") {
      return authError("AUTH_MODE_MISMATCH", "当前未启用邮件验证码登录");
    }
    const body = (await request.json()) as {
      email?: unknown;
      challengeId?: unknown;
      code?: unknown;
    };
    if (
      typeof body.email !== "string" ||
      typeof body.challengeId !== "string" ||
      typeof body.code !== "string" ||
      normalizedEmail(body.email) !== normalizedEmail(this.config.email)
    ) {
      return authError("INVALID_CODE", "验证码无效", 401);
    }
    const row = this.database
      .prepare(
        `SELECT id, email, code_hash, attempts, expires_at FROM auth_challenges
         WHERE id = ? AND email = ?`,
      )
      .get(body.challengeId, normalizedEmail(body.email)) as ChallengeRow | undefined;
    if (!row || row.expires_at <= Date.now() || row.attempts >= 5) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }
    this.database.prepare("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?").run(row.id);
    const provided = Buffer.from(sha256(`${row.id}:${body.code}:${this.config.sessionSecret}`), "hex");
    const expected = Buffer.from(row.code_hash, "hex");
    if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
      return authError("INVALID_CODE", "验证码无效或已过期", 401);
    }
    this.database.prepare("DELETE FROM auth_challenges WHERE id = ?").run(row.id);
    // 通过后删除挑战并签发 30 天会话，后续请求只需验证 Cookie，不必重复发信。
    return this.createSession();
  }

  private createSession(): Response {
    // 服务端保存 token 哈希，浏览器拿到的原始 token 只存在 HttpOnly Cookie 中。
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    this.database
      .prepare(
        `INSERT INTO local_sessions (id, token_hash, owner_id, email, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(
        crypto.randomUUID(),
        sha256(token),
        this.ownerId,
        normalizedEmail(this.config.email),
        now,
        now + SESSION_SECONDS * 1000,
      );
    return Response.json(
      { authenticated: true, email: this.config.email },
      {
        headers: {
          "set-cookie": sessionCookie(token, this.config.publicUrl.protocol === "https:"),
          "cache-control": "no-store",
        },
      },
    );
  }

  private async logout(request: Request): Promise<Response> {
    // 删除服务端会话与清空 Cookie 都是幂等操作，重复点击退出不会产生错误。
    const token = cookieValue(request, SESSION_COOKIE);
    if (token) {
      this.database.prepare("DELETE FROM local_sessions WHERE token_hash = ?").run(sha256(token));
    }
    return Response.json(
      { authenticated: false },
      {
        headers: {
          "set-cookie": sessionCookie("", this.config.publicUrl.protocol === "https:", 0),
          "cache-control": "no-store",
        },
      },
    );
  }
}

export function localAuthConfigFromEnv(): LocalAuthConfig {
  // 环境变量在进程启动时集中解析和校验，避免运行中才发现 HTTP、SMTP 或密钥配置错误。
  const mode = process.env.AUTH_MODE === "smtp-otp" ? "smtp-otp" : "password";
  const email = process.env.ADMIN_EMAIL?.trim();
  if (!email) throw new Error("缺少 ADMIN_EMAIL");
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!sessionSecret || sessionSecret.length < 32) throw new Error("SESSION_SECRET 至少需要 32 个字符");
  const publicUrl = new URL(process.env.PUBLIC_URL || "http://localhost:3000");
  const localHost = publicUrl.hostname === "localhost" || publicUrl.hostname === "127.0.0.1";
  const insecureHttp = publicUrl.protocol !== "https:" && !localHost;
  if (insecureHttp && process.env.ALLOW_INSECURE_HTTP !== "true") {
    throw new Error("非 localhost 的 HTTP 部署必须显式设置 ALLOW_INSECURE_HTTP=true");
  }
  if (mode === "password" && !process.env.ADMIN_PASSWORD_HASH) {
    throw new Error("密码模式缺少 ADMIN_PASSWORD_HASH，可运行 npm run admin -- hash-password 生成");
  }
  const smtp =
    mode === "smtp-otp"
      ? {
          host: process.env.SMTP_HOST || "",
          port: Number(process.env.SMTP_PORT || 587),
          secure: process.env.SMTP_SECURE === "true",
          user: process.env.SMTP_USER,
          password: process.env.SMTP_PASSWORD,
          from: process.env.SMTP_FROM || "drop-worker@localhost",
        }
      : undefined;
  if (mode === "smtp-otp" && !smtp?.host) throw new Error("邮件验证码模式缺少 SMTP_HOST");
  return {
    mode,
    email,
    passwordHash: process.env.ADMIN_PASSWORD_HASH,
    sessionSecret,
    publicUrl,
    insecureHttp,
    smtp,
  };
}

export function addLocalAuthToServices(
  services: Omit<RuntimeServices, "resolveIdentity" | "authMode" | "insecureHttp" | "handleAuthRequest">,
  auth: LocalAuth,
  config: LocalAuthConfig,
): RuntimeServices {
  return {
    ...services,
    resolveIdentity: (request) => auth.resolveIdentity(request),
    authMode: config.mode,
    insecureHttp: config.insecureHttp,
    handleAuthRequest: (request) => auth.handle(request),
  };
}
