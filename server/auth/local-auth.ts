import {
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import type { AuthProvider, AuthSessionStore, Identity, MailSender } from "../../api/platform";
import {
  AUTH_SESSION_COOKIE,
  AUTH_SESSION_SECONDS,
  EmailOtpAuth,
  authError,
  createSessionCookie,
  normalizeEmail,
  parseAuthJson,
  readCookie,
  type EmailOtpAuthConfig,
} from "../../api/auth";
import { isLoopbackPublicUrl, validatePublicUrl } from "../../api/sharing";

export type LocalAuthConfig = {
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
    fromName?: string;
  };
};

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
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

export class LocalAuth implements AuthProvider {
  private readonly ownerId: string;
  private readonly emailOtp?: EmailOtpAuth;
  readonly mode: "password" | "smtp-otp";

  constructor(
    private readonly metadata: AuthSessionStore,
    private readonly config: LocalAuthConfig,
    mailer?: MailSender,
  ) {
    this.ownerId = `local:${sha256(normalizeEmail(config.email)).slice(0, 24)}`;
    this.mode = config.mode;
    if (config.mode === "smtp-otp" && !mailer) {
      throw new Error("SMTP OTP 认证缺少邮件发送适配器");
    }
    if (config.mode === "smtp-otp" && config.smtp && mailer) {
      const emailOtpConfig: EmailOtpAuthConfig = {
        email: config.email,
        from: { address: config.smtp.from, name: config.smtp.fromName || "Drop Worker" },
        sessionSecret: config.sessionSecret,
        secureCookie: config.publicUrl.protocol === "https:",
        ownerIdPrefix: "local",
      };
      this.emailOtp = new EmailOtpAuth(metadata, emailOtpConfig, mailer);
    }
  }

  close(): void {
    if (this.emailOtp) this.emailOtp.close();
  }

  async resolveIdentity(request: Request): Promise<Identity | null> {
    if (this.emailOtp) return this.emailOtp.resolveIdentity(request);
    // Cookie 只作为索引，数据库校验哈希和过期时间后才返回 owner 身份。
    const token = readCookie(request, AUTH_SESSION_COOKIE);
    if (!token) return null;
    const row = await this.metadata.getAuthSession(sha256(token), Date.now());
    if (!row) return null;
    return { ownerId: row.ownerId, email: row.email };
  }

  async handle(request: Request): Promise<Response | null> {
    if (this.emailOtp) {
      const url = new URL(request.url);
      if (url.pathname === "/api/auth/login" && request.method === "POST") {
        return authError("AUTH_MODE_MISMATCH", "当前未启用密码登录");
      }
      return this.emailOtp.handle(request);
    }
    // 本地同时支持密码和邮箱验证码，但每个实例仍只启用配置中的一种 mode。
    const url = new URL(request.url);
    if (url.pathname === "/api/auth/login" && request.method === "POST") {
      return this.loginWithPassword(request);
    }
    if (url.pathname === "/api/auth/request-otp" && request.method === "POST") {
      return authError("AUTH_MODE_MISMATCH", "当前未启用邮件验证码登录");
    }
    if (url.pathname === "/api/auth/verify-otp" && request.method === "POST") {
      return authError("AUTH_MODE_MISMATCH", "当前未启用邮件验证码登录");
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
    const body = await parseAuthJson(request);
    if (typeof body?.email !== "string" || typeof body?.password !== "string") {
      return authError("INVALID_CREDENTIALS", "邮箱或密码错误", 401);
    }
    const emailMatches = normalizeEmail(body.email) === normalizeEmail(this.config.email);
    const passwordMatches = verifyPassword(body.password, this.config.passwordHash);
    if (!emailMatches || !passwordMatches) {
      return authError("INVALID_CREDENTIALS", "邮箱或密码错误", 401);
    }
    return this.createSession();
  }

  private async createSession(): Promise<Response> {
    // 服务端保存 token 哈希，浏览器拿到的原始 token 只存在 HttpOnly Cookie 中。
    const token = randomBytes(32).toString("base64url");
    const now = Date.now();
    await this.metadata.createAuthSession({
      id: crypto.randomUUID(),
      tokenHash: sha256(token),
      ownerId: this.ownerId,
      email: normalizeEmail(this.config.email),
      createdAt: now,
      expiresAt: now + AUTH_SESSION_SECONDS * 1000,
    });
    return Response.json(
      { authenticated: true, email: this.config.email },
      {
        headers: {
          "set-cookie": createSessionCookie(token, this.config.publicUrl.protocol === "https:"),
          "cache-control": "no-store",
        },
      },
    );
  }

  private async logout(request: Request): Promise<Response> {
    // 删除服务端会话与清空 Cookie 都是幂等操作，重复点击退出不会产生错误。
    const token = readCookie(request, AUTH_SESSION_COOKIE);
    if (token) {
      await this.metadata.deleteAuthSession(sha256(token));
    }
    return Response.json(
      { authenticated: false },
      {
        headers: {
          "set-cookie": createSessionCookie("", this.config.publicUrl.protocol === "https:", 0),
          "cache-control": "no-store",
        },
      },
    );
  }
}

export function localAuthConfigFromEnv(): LocalAuthConfig {
  // 环境变量在进程启动时集中解析和校验，避免运行中才发现 HTTP、SMTP 或密钥配置错误。
  const configuredMode = (process.env.AUTH_MODE || "password").trim().toLocaleLowerCase();
  if (configuredMode !== "password" && configuredMode !== "smtp-otp") {
    throw new Error("本地 AUTH_MODE 必须是 password 或 smtp-otp");
  }
  const mode = configuredMode;
  const email = process.env.ADMIN_EMAIL?.trim();
  if (!email) throw new Error("缺少 ADMIN_EMAIL");
  const sessionSecret = process.env.SESSION_SECRET?.trim();
  if (!sessionSecret || sessionSecret.length < 32) throw new Error("SESSION_SECRET 至少需要 32 个字符");
  const publicUrl = validatePublicUrl(
    process.env.PUBLIC_URL || "http://localhost:3000",
    process.env.ALLOW_INSECURE_HTTP === "true",
  );
  const insecureHttp = publicUrl.protocol === "http:" && !isLoopbackPublicUrl(publicUrl);
  if (mode === "password" && !process.env.ADMIN_PASSWORD_HASH) {
    throw new Error("密码模式缺少 ADMIN_PASSWORD_HASH，可运行 npm run admin -- hash-password 生成");
  }
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtp =
    mode === "smtp-otp"
      ? {
          host: process.env.SMTP_HOST || "",
          port: smtpPort,
          secure: process.env.SMTP_SECURE === "true" || smtpPort === 465 || smtpPort === 994,
          user: process.env.SMTP_USERNAME || process.env.SMTP_USER,
          password: process.env.SMTP_PASSWORD,
          from: process.env.SMTP_FROM || "drop-worker@localhost",
          fromName: process.env.AUTH_FROM_NAME || "Drop Worker",
        }
      : undefined;
  if (mode === "smtp-otp" && (!smtp?.host || !smtp.from)) throw new Error("邮件验证码模式缺少 SMTP_HOST 或 SMTP_FROM");
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
