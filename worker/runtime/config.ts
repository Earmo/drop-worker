import { normalizeEmail } from "../../api/auth";
import { DEFAULT_QUOTA_BYTES, positiveInteger } from "../../api/runtime-config";
import { validatePublicUrl } from "../../api/sharing";

export type CloudflareAuthMode = "smtp-otp" | "development";

/** Worker Socket SMTP 适配器所需的完整连接与发件配置。 */
export type CloudflareSmtpConfig = {
  host: string;
  port: number;
  secure: boolean;
  username: string;
  password: string;
  from: string;
  fromName: string;
  timeoutMs: number;
};

export type CloudflareDirectUploadConfig = {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export type CloudflareRuntimeConfig = {
  authMode: CloudflareAuthMode;
  ownerEmail?: string;
  quotaBytes: number;
  authSessionSecret: string;
  publicUrl: URL;
  publicFilesUrl?: URL;
  sharingEnabled: boolean;
  directUpload?: CloudflareDirectUploadConfig;
  smtp?: CloudflareSmtpConfig;
};

function authMode(value: string | undefined): CloudflareAuthMode {
  const mode = (value || "smtp-otp").trim().toLocaleLowerCase();
  if (mode === "smtp-otp" || mode === "development") return mode;
  throw new Error("AUTH_MODE 必须是 smtp-otp 或 development");
}

/**
 * Cloudflare 运行时的配置入口。绑定对象仍由 Worker 平台注入，普通变量在此集中校验。
 */
export function loadCloudflareRuntimeConfig(env: Env): CloudflareRuntimeConfig {
  const mode = authMode(env.AUTH_MODE);
  const ownerEmail = env.OWNER_EMAIL?.trim() ? normalizeEmail(env.OWNER_EMAIL) : undefined;
  if (mode !== "development" && !ownerEmail) throw new Error("生产环境必须配置 OWNER_EMAIL");

  const smtpPort = Number(env.SMTP_PORT || 587);
  const smtp = mode === "smtp-otp"
    ? {
        host: (env.SMTP_HOST || "").trim(),
        port: smtpPort,
        secure: env.SMTP_SECURE === "true" || smtpPort === 465 || smtpPort === 994,
        username: env.SMTP_USERNAME || "",
        password: env.SMTP_PASSWORD || "",
        from: normalizeEmail(env.SMTP_FROM || ""),
        fromName: (env.AUTH_FROM_NAME || "Drop Worker").replace(/[\r\n"]/g, "").trim() || "Drop Worker",
        timeoutMs: Math.min(Math.max(Number(env.SMTP_TIMEOUT_MS || 15_000), 3_000), 30_000),
      }
    : undefined;
  if (mode === "smtp-otp") {
    if (!smtp?.host || ![465, 587, 994].includes(smtp.port) || !smtp.from) {
      throw new Error("邮箱验证码认证配置不完整：SMTP_HOST、SMTP_FROM 和 SMTP_PORT 必须有效");
    }
    if (Boolean(smtp.username) !== Boolean(smtp.password)) {
      throw new Error("SMTP_USERNAME 与 SMTP_PASSWORD 必须同时配置");
    }
    if (!Number.isInteger(smtp.timeoutMs) || smtp.timeoutMs < 3_000 || smtp.timeoutMs > 30_000) {
      throw new Error("SMTP_TIMEOUT_MS 必须是 3000 到 30000 之间的整数");
    }
  }

  const authSessionSecret = (env.AUTH_SESSION_SECRET || "").trim()
    || (mode === "development" ? "drop-worker-development-share-secret" : "");
  if (authSessionSecret.length < 32) throw new Error("AUTH_SESSION_SECRET 至少需要 32 个字符才能启用分享");

  const publicUrl = validatePublicUrl(
    env.PUBLIC_URL || (mode === "development" ? "http://localhost:3000" : ""),
  );
  const publicFilesUrl = env.R2_PUBLIC_URL?.trim()
    ? validatePublicUrl(env.R2_PUBLIC_URL.trim())
    : undefined;

  const accessKeyId = env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = env.R2_SECRET_ACCESS_KEY?.trim();
  if (Boolean(accessKeyId) !== Boolean(secretAccessKey)) {
    throw new Error("R2_ACCESS_KEY_ID 与 R2_SECRET_ACCESS_KEY 必须同时配置");
  }
  const accountId = env.R2_ACCOUNT_ID?.trim();
  const bucketName = env.R2_BUCKET_NAME?.trim();
  if ((accessKeyId || secretAccessKey) && (!accountId || !bucketName)) {
    throw new Error("启用 R2 直传时必须配置 R2_ACCOUNT_ID 与 R2_BUCKET_NAME");
  }

  return {
    authMode: mode,
    ownerEmail,
    quotaBytes: positiveInteger("MAX_STORAGE_BYTES", env.MAX_STORAGE_BYTES, DEFAULT_QUOTA_BYTES),
    authSessionSecret,
    publicUrl,
    publicFilesUrl,
    sharingEnabled: env.SHARING_ENABLED !== "false",
    directUpload: accessKeyId && secretAccessKey && accountId && bucketName
      ? { accountId, bucketName, accessKeyId, secretAccessKey }
      : undefined,
    smtp,
  };
}
