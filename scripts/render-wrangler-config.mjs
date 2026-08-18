import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_SMTP_PORTS = ["465", "587", "994"];

function readValue(name, fallback = "") {
  const value = process.env[name]?.trim();
  return value || fallback.trim();
}

function requireValue(name, fallback = "") {
  const value = readValue(name, fallback);
  if (!value) throw new Error(`缺少部署配置：${name}`);
  return value;
}

function requireOneOf(name, allowed, fallback) {
  const value = requireValue(name, fallback).toLowerCase();
  if (!allowed.includes(value)) {
    throw new Error(`${name} 必须是以下值之一：${allowed.join("、")}`);
  }
  return value;
}

const outputPath = path.resolve(process.argv[2] || "wrangler.jsonc");
const workerName = requireValue("WORKER_NAME", "drop-worker");
const databaseDriver = requireOneOf("DATABASE_DRIVER", ["sqlite", "mysql", "postgres"], "sqlite");
const blobDriver = requireOneOf("BLOB_DRIVER", ["r2", "s3"], "r2");
const databaseName = readValue("D1_DATABASE_NAME", workerName);
const databaseId = readValue("D1_DATABASE_ID");
const hyperdriveId = readValue("HYPERDRIVE_ID");
const r2BucketName = blobDriver === "r2" ? requireValue("R2_BUCKET_NAME", `${workerName}-files`) : "";
const r2AccountId = blobDriver === "r2" ? requireValue("R2_ACCOUNT_ID") : "";
const s3EndpointValue = blobDriver === "s3" ? readValue("S3_ENDPOINT") : "";
const s3Endpoint = s3EndpointValue ? new URL(s3EndpointValue) : null;
const s3Region = blobDriver === "s3" ? requireValue("S3_REGION", "us-east-1") : "";
const s3Bucket = blobDriver === "s3" ? requireValue("S3_BUCKET") : "";
const s3Prefix = blobDriver === "s3" ? requireValue("S3_PREFIX", "drop-worker/") : "";
const s3ForcePathStyle = blobDriver === "s3"
  ? requireOneOf("S3_FORCE_PATH_STYLE", ["true", "false"], "false")
  : "false";
const s3AllowInsecure = blobDriver === "s3"
  ? requireOneOf("S3_ALLOW_INSECURE", ["true", "false"], "false")
  : "false";
const s3ServerSideEncryption = blobDriver === "s3" ? readValue("S3_SERVER_SIDE_ENCRYPTION") : "";
const s3KmsKeyId = blobDriver === "s3" ? readValue("S3_KMS_KEY_ID") : "";
const ownerEmail = requireValue("OWNER_EMAIL");
const authFromName = requireValue("AUTH_FROM_NAME", workerName);
const maxStorageBytes = requireValue("MAX_STORAGE_BYTES", "10737418240");
const publicUrl = requireValue("PUBLIC_URL");
const r2PublicUrlValue = blobDriver === "r2" ? readValue("R2_PUBLIC_URL") : "";
const r2PublicUrl = r2PublicUrlValue ? new URL(r2PublicUrlValue) : null;
const sharingEnabled = requireOneOf("SHARING_ENABLED", ["true", "false"], "true");
const smtpHost = readValue("SMTP_HOST");
const smtpPort = requireValue("SMTP_PORT", "587");
const smtpSecure = requireOneOf("SMTP_SECURE", ["true", "false"], "false");
const smtpFrom = readValue("SMTP_FROM");
const smtpTimeoutMs = requireValue("SMTP_TIMEOUT_MS", "15000");

const uuidPattern = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
if (databaseDriver === "sqlite" && !uuidPattern.test(databaseId)) {
  throw new Error("sqlite 模式的 D1_DATABASE_ID 必须是有效的 UUID");
}
if (databaseDriver !== "sqlite" && !uuidPattern.test(hyperdriveId)) {
  throw new Error("mysql/postgres 模式的 HYPERDRIVE_ID 必须是有效的 UUID");
}
if (!/^\d+$/.test(maxStorageBytes) || BigInt(maxStorageBytes) <= 0n) {
  throw new Error("MAX_STORAGE_BYTES 必须是正整数");
}
if (s3Endpoint && !["https:", "http:"].includes(s3Endpoint.protocol)) {
  throw new Error("S3_ENDPOINT 必须使用 HTTP 或 HTTPS");
}
if (s3Endpoint?.protocol === "http:" && s3AllowInsecure !== "true") {
  throw new Error("HTTP S3_ENDPOINT 必须显式设置 S3_ALLOW_INSECURE=true");
}
const normalizedS3Prefix = s3Prefix.replace(/^\/+|\/+$/g, "");
if (blobDriver === "s3" && (
  !normalizedS3Prefix
  || normalizedS3Prefix.includes("..")
  || !/^[a-zA-Z0-9/_-]+$/.test(normalizedS3Prefix)
)) {
  throw new Error("S3_PREFIX 无效");
}
if (s3ServerSideEncryption && !["AES256", "aws:kms"].includes(s3ServerSideEncryption)) {
  throw new Error("S3_SERVER_SIDE_ENCRYPTION 只能是 AES256 或 aws:kms");
}
if (s3ServerSideEncryption === "aws:kms" && !s3KmsKeyId) {
  throw new Error("S3_SERVER_SIDE_ENCRYPTION=aws:kms 时必须配置 S3_KMS_KEY_ID");
}
if (r2PublicUrl && (
  r2PublicUrl.protocol !== "https:"
  || r2PublicUrl.username
  || r2PublicUrl.password
  || r2PublicUrl.pathname !== "/"
  || r2PublicUrl.search
  || r2PublicUrl.hash
)) {
  throw new Error("R2_PUBLIC_URL 必须是没有路径、查询参数或凭据的 HTTPS 站点根地址");
}
if (!/^\d+$/.test(smtpTimeoutMs) || Number(smtpTimeoutMs) < 3000 || Number(smtpTimeoutMs) > 30000) {
  throw new Error("SMTP_TIMEOUT_MS 必须是 3000 到 30000 之间的整数");
}
if (!smtpHost || !SUPPORTED_SMTP_PORTS.includes(smtpPort)) {
  throw new Error(`必须提供 SMTP_HOST，并使用 ${SUPPORTED_SMTP_PORTS.join("、")} 端口`);
}
if (!smtpFrom) throw new Error("必须提供 SMTP_FROM");

const config = {
  $schema: "./node_modules/wrangler/config-schema.json",
  name: workerName,
  main: "dist/server/index.js",
  compatibility_date: "2026-08-11",
  compatibility_flags: ["nodejs_compat"],
  assets: {
    directory: "./dist/client",
    binding: "ASSETS",
    not_found_handling: "single-page-application",
  },
  ...(databaseDriver === "sqlite"
    ? {
        d1_databases: [
          {
            binding: "DB",
            database_name: databaseName,
            database_id: databaseId,
            migrations_dir: "./drizzle/sqlite",
          },
        ],
      }
    : {
        hyperdrive: [
          {
            binding: "HYPERDRIVE",
            id: hyperdriveId,
          },
        ],
      }),
  ...(blobDriver === "r2"
    ? {
        r2_buckets: [
          {
            binding: "FILES",
            bucket_name: r2BucketName,
          },
        ],
      }
    : {}),
  vars: {
    DATABASE_DRIVER: databaseDriver,
    BLOB_DRIVER: blobDriver,
    AUTH_MODE: "smtp-otp",
    MAX_STORAGE_BYTES: maxStorageBytes,
    PUBLIC_URL: publicUrl,
    SHARING_ENABLED: sharingEnabled,
    ...(blobDriver === "r2"
      ? {
          R2_ACCOUNT_ID: r2AccountId,
          R2_BUCKET_NAME: r2BucketName,
          ...(r2PublicUrl ? { R2_PUBLIC_URL: r2PublicUrl.toString() } : {}),
        }
      : {
          ...(s3Endpoint ? { S3_ENDPOINT: s3Endpoint.toString() } : {}),
          S3_REGION: s3Region,
          S3_BUCKET: s3Bucket,
          S3_PREFIX: `${normalizedS3Prefix}/`,
          S3_FORCE_PATH_STYLE: s3ForcePathStyle,
          S3_ALLOW_INSECURE: s3AllowInsecure,
          ...(s3ServerSideEncryption ? { S3_SERVER_SIDE_ENCRYPTION: s3ServerSideEncryption } : {}),
          ...(s3KmsKeyId ? { S3_KMS_KEY_ID: s3KmsKeyId } : {}),
        }),
    OWNER_EMAIL: ownerEmail,
    AUTH_FROM_NAME: authFromName,
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort,
    SMTP_SECURE: smtpSecure,
    SMTP_FROM: smtpFrom,
    SMTP_TIMEOUT_MS: smtpTimeoutMs,
  },
  // required 只声明生产 Worker 应具备的 Secret 名称；真实值由部署步骤安全注入。
  secrets: {
    required: [
      "AUTH_SESSION_SECRET",
      "SMTP_USERNAME",
      "SMTP_PASSWORD",
      ...(blobDriver === "r2"
        ? ["R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY"]
        : ["S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY"]),
    ],
  },
  triggers: {
    crons: ["17 * * * *"],
  },
  observability: {
    enabled: true,
    logs: {
      head_sampling_rate: 1,
    },
    traces: {
      enabled: true,
      head_sampling_rate: 0.01,
    },
  },
};

await writeFile(outputPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
const corsPath = path.join(path.dirname(outputPath), "r2-cors.json");
if (blobDriver === "r2") {
  await writeFile(corsPath, `${JSON.stringify({
    rules: [
      {
        allowed: {
          origins: [new URL(publicUrl).origin],
          methods: ["GET", "HEAD", "PUT"],
          headers: ["content-type", "range"],
        },
        exposeHeaders: ["accept-ranges", "content-disposition", "content-length", "content-range", "etag"],
        maxAgeSeconds: 3_600,
      },
    ],
  }, null, 2)}\n`, "utf8");
}
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `database_driver=${databaseDriver}\n`, "utf8");
  await appendFile(process.env.GITHUB_OUTPUT, `blob_driver=${blobDriver}\n`, "utf8");
  if (blobDriver === "r2") {
    await appendFile(process.env.GITHUB_OUTPUT, `r2_bucket_name=${r2BucketName}\n`, "utf8");
    await appendFile(process.env.GITHUB_OUTPUT, `r2_cors_config=${corsPath}\n`, "utf8");
  }
}
console.log(`已生成 Wrangler 部署配置：${path.basename(outputPath)}`);
