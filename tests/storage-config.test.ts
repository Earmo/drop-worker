import assert from "node:assert/strict";
import test from "node:test";
import {
  relationalDatabaseUrl,
  relationalPoolSize,
  relationalTlsOptions,
} from "../apps/api/stores/relational";
import { createS3BlobStoreFromEnv } from "../apps/api/stores/s3";

const ENV_KEYS = [
  "DATABASE_URL",
  "DATABASE_POOL_SIZE",
  "DATABASE_ALLOW_INSECURE",
  "DATABASE_CA_FILE",
  "S3_ENDPOINT",
  "S3_REGION",
  "S3_BUCKET",
  "S3_PREFIX",
  "S3_FORCE_PATH_STYLE",
  "S3_ALLOW_INSECURE",
  "S3_ACCESS_KEY_ID",
  "S3_SECRET_ACCESS_KEY",
  "S3_SESSION_TOKEN",
  "S3_SERVER_SIDE_ENCRYPTION",
  "S3_KMS_KEY_ID",
] as const;

function preserveEnvironment(): () => void {
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function resetS3Environment(): void {
  for (const key of ENV_KEYS.filter((value) => value.startsWith("S3_"))) delete process.env[key];
  process.env.S3_ENDPOINT = "https://s3.example.com";
  process.env.S3_REGION = "us-east-1";
  process.env.S3_BUCKET = "drop-worker";
}

test("S3 配置支持默认凭据链、静态临时凭据与加密选项", () => {
  const restore = preserveEnvironment();
  try {
    resetS3Environment();
    const defaultCredentials = createS3BlobStoreFromEnv();
    defaultCredentials.close();

    process.env.S3_ACCESS_KEY_ID = "temporary-access-key";
    process.env.S3_SECRET_ACCESS_KEY = "temporary-secret-key";
    process.env.S3_SESSION_TOKEN = "temporary-session-token";
    process.env.S3_SERVER_SIDE_ENCRYPTION = "AES256";
    const staticCredentials = createS3BlobStoreFromEnv();
    staticCredentials.close();

    process.env.S3_SERVER_SIDE_ENCRYPTION = "aws:kms";
    delete process.env.S3_KMS_KEY_ID;
    assert.throws(() => createS3BlobStoreFromEnv(), /S3_KMS_KEY_ID/);
    process.env.S3_KMS_KEY_ID = "alias/drop-worker";
    const kms = createS3BlobStoreFromEnv();
    kms.close();
  } finally {
    restore();
  }
});

test("S3 配置拒绝越界前缀、半套凭据和未确认的明文 endpoint", () => {
  const restore = preserveEnvironment();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    resetS3Environment();
    process.env.S3_PREFIX = "../outside";
    assert.throws(() => createS3BlobStoreFromEnv(), /S3_PREFIX/);

    resetS3Environment();
    process.env.S3_ACCESS_KEY_ID = "only-one-half";
    assert.throws(() => createS3BlobStoreFromEnv(), /必须同时配置/);

    resetS3Environment();
    process.env.S3_ENDPOINT = "http://minio.internal:9000";
    assert.throws(() => createS3BlobStoreFromEnv(), /S3_ALLOW_INSECURE/);
    process.env.S3_ALLOW_INSECURE = "true";
    const insecure = createS3BlobStoreFromEnv();
    insecure.close();
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    restore();
  }
});

test("关系型配置校验驱动、连接池和 TLS 默认值", async () => {
  const restore = preserveEnvironment();
  const originalWarn = console.warn;
  const warnings: string[] = [];
  console.warn = (message?: unknown) => warnings.push(String(message));
  try {
    process.env.DATABASE_URL = "postgresql://db.example.com/dropworker";
    assert.throws(() => relationalDatabaseUrl("mysql"), /不匹配/);
    assert.equal(relationalDatabaseUrl("postgres").hostname, "db.example.com");

    process.env.DATABASE_POOL_SIZE = "0";
    assert.throws(() => relationalPoolSize(), /1 到 50/);
    process.env.DATABASE_POOL_SIZE = "12";
    assert.equal(relationalPoolSize(), 12);

    delete process.env.DATABASE_ALLOW_INSECURE;
    assert.deepEqual(await relationalTlsOptions(new URL("postgresql://db.example.com/dropworker")), {
      rejectUnauthorized: true,
    });
    assert.equal(await relationalTlsOptions(new URL("postgresql://127.0.0.1/dropworker")), false);
    process.env.DATABASE_ALLOW_INSECURE = "true";
    assert.equal(await relationalTlsOptions(new URL("postgresql://db.internal/dropworker")), false);
    assert.equal(warnings.length, 1);
  } finally {
    console.warn = originalWarn;
    restore();
  }
});
