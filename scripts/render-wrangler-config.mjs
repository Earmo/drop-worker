import { appendFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SUPPORTED_SMTP_PORTS = ["465", "587", "994"];

function readValue(name, fallback = "") {
  return (process.env[name] ?? fallback).trim();
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
const databaseName = requireValue("D1_DATABASE_NAME", workerName);
const databaseId = requireValue("D1_DATABASE_ID");
const bucketName = requireValue("R2_BUCKET_NAME", `${workerName}-files`);
const ownerEmail = requireValue("OWNER_EMAIL");
const emailProvider = requireOneOf("AUTH_EMAIL_PROVIDER", ["cloudflare", "smtp"], "cloudflare");
const authFromEmail = readValue("AUTH_FROM_EMAIL");
const authFromName = requireValue("AUTH_FROM_NAME", workerName);
const maxStorageBytes = requireValue("MAX_STORAGE_BYTES", "10737418240");
const publicUrl = requireValue("PUBLIC_URL");
const sharingEnabled = requireOneOf("SHARING_ENABLED", ["true", "false"], "true");
const smtpHost = readValue("SMTP_HOST");
const smtpPort = requireValue("SMTP_PORT", "587");
const smtpSecure = requireOneOf("SMTP_SECURE", ["true", "false"], "false");
const smtpFrom = readValue("SMTP_FROM");
const smtpTimeoutMs = requireValue("SMTP_TIMEOUT_MS", "15000");

if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(databaseId)) {
  throw new Error("D1_DATABASE_ID 必须是有效的 UUID");
}
if (!/^\d+$/.test(maxStorageBytes) || BigInt(maxStorageBytes) <= 0n) {
  throw new Error("MAX_STORAGE_BYTES 必须是正整数");
}
if (!/^\d+$/.test(smtpTimeoutMs) || Number(smtpTimeoutMs) < 3000 || Number(smtpTimeoutMs) > 30000) {
  throw new Error("SMTP_TIMEOUT_MS 必须是 3000 到 30000 之间的整数");
}
if (emailProvider === "cloudflare" && !authFromEmail) {
  throw new Error("Cloudflare Email Service 模式缺少 AUTH_FROM_EMAIL");
}
if (emailProvider === "smtp" && (!smtpHost || !SUPPORTED_SMTP_PORTS.includes(smtpPort))) {
  throw new Error(`SMTP 模式必须提供 SMTP_HOST，并使用 ${SUPPORTED_SMTP_PORTS.join("、")} 端口`);
}
if (emailProvider === "smtp" && !smtpFrom && !authFromEmail) {
  throw new Error("SMTP 模式必须提供 SMTP_FROM 或 AUTH_FROM_EMAIL");
}

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
  d1_databases: [
    {
      binding: "DB",
      database_name: databaseName,
      database_id: databaseId,
      migrations_dir: "./drizzle",
    },
  ],
  r2_buckets: [
    {
      binding: "FILES",
      bucket_name: bucketName,
    },
  ],
  ...(emailProvider === "cloudflare"
    ? {
        send_email: [
          {
            name: "EMAIL",
            destination_address: ownerEmail,
            remote: true,
          },
        ],
      }
    : {}),
  vars: {
    AUTH_MODE: "smtp-otp",
    AUTH_EMAIL_PROVIDER: emailProvider,
    MAX_STORAGE_BYTES: maxStorageBytes,
    PUBLIC_URL: publicUrl,
    SHARING_ENABLED: sharingEnabled,
    OWNER_EMAIL: ownerEmail,
    AUTH_FROM_EMAIL: authFromEmail,
    AUTH_FROM_NAME: authFromName,
    SMTP_HOST: smtpHost,
    SMTP_PORT: smtpPort,
    SMTP_SECURE: smtpSecure,
    SMTP_FROM: smtpFrom,
    SMTP_TIMEOUT_MS: smtpTimeoutMs,
    CF_ACCESS_TEAM_DOMAIN: readValue("CF_ACCESS_TEAM_DOMAIN"),
    CF_ACCESS_AUD: readValue("CF_ACCESS_AUD"),
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
if (process.env.GITHUB_OUTPUT) {
  await appendFile(process.env.GITHUB_OUTPUT, `email_provider=${emailProvider}\n`, "utf8");
}
console.log(`已生成 Wrangler 部署配置：${path.basename(outputPath)}`);
