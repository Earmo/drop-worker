import assert from "node:assert/strict";
import test from "node:test";
import { loadNodeRuntimeConfig } from "../server/runtime/config";
import { loadCloudflareRuntimeConfig } from "../worker/runtime/config";

const NODE_ENV_KEYS = [
  "AUTH_MODE",
  "ADMIN_EMAIL",
  "ADMIN_PASSWORD_HASH",
  "SESSION_SECRET",
  "PUBLIC_URL",
  "ALLOW_INSECURE_HTTP",
  "DATA_DIR",
  "DATABASE_DRIVER",
  "BLOB_DRIVER",
  "MAX_STORAGE_BYTES",
  "SHARING_ENABLED",
  "TRUST_PROXY",
  "HOST",
  "PORT",
] as const;

function preserveEnvironment(keys: readonly string[]): () => void {
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

test("Node 运行时配置在启动阶段选择并校验驱动", () => {
  const restore = preserveEnvironment(NODE_ENV_KEYS);
  try {
    process.env.AUTH_MODE = "password";
    process.env.ADMIN_EMAIL = "owner@example.com";
    process.env.ADMIN_PASSWORD_HASH = "scrypt$test";
    process.env.SESSION_SECRET = "a-secure-session-secret-that-is-long-enough";
    process.env.PUBLIC_URL = "http://localhost:3000";
    process.env.DATA_DIR = "./.scratch/config-test";
    process.env.DATABASE_DRIVER = "postgres";
    process.env.BLOB_DRIVER = "s3";
    process.env.MAX_STORAGE_BYTES = "12345";
    process.env.PORT = "3456";
    process.env.HOST = "127.0.0.1";

    const config = loadNodeRuntimeConfig();
    assert.equal(config.databaseDriver, "postgres");
    assert.equal(config.blobDriver, "s3");
    assert.equal(config.quotaBytes, 12345);
    assert.equal(config.port, 3456);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.auth.mode, "password");

    process.env.DATABASE_DRIVER = "unsupported";
    assert.throws(() => loadNodeRuntimeConfig(), /DATABASE_DRIVER/);
    process.env.DATABASE_DRIVER = "sqlite";
    process.env.AUTH_MODE = "legacy";
    assert.throws(() => loadNodeRuntimeConfig(), /AUTH_MODE/);
  } finally {
    restore();
  }
});

test("Cloudflare 运行时配置集中校验公开地址、Secret 和直传凭据", () => {
  const baseEnv = {
    DATABASE_DRIVER: "sqlite",
    AUTH_MODE: "smtp-otp",
    OWNER_EMAIL: "Owner@Example.com",
    AUTH_SESSION_SECRET: "a-secure-session-secret-that-is-long-enough",
    PUBLIC_URL: "https://drop.example.com",
    MAX_STORAGE_BYTES: "2048",
    SHARING_ENABLED: "true",
    SMTP_HOST: "smtp.example.com",
    SMTP_PORT: "587",
    SMTP_SECURE: "false",
    SMTP_FROM: "owner@example.com",
    AUTH_FROM_NAME: "Drop Worker",
    DB: {},
    FILES: {},
  } as unknown as Env;

  const config = loadCloudflareRuntimeConfig({
    ...baseEnv,
    R2_ACCOUNT_ID: "account",
    R2_BUCKET_NAME: "bucket",
    R2_ACCESS_KEY_ID: "access",
    R2_SECRET_ACCESS_KEY: "secret",
  } as unknown as Env);
  assert.equal(config.ownerEmail, "owner@example.com");
  assert.equal(config.databaseDriver, "sqlite");
  assert.equal(config.quotaBytes, 2048);
  assert.equal(config.directUpload?.bucketName, "bucket");

  assert.throws(
    () => loadCloudflareRuntimeConfig({ ...baseEnv, AUTH_MODE: "legacy" } as unknown as Env),
    /AUTH_MODE/,
  );
  assert.throws(
    () => loadCloudflareRuntimeConfig({ ...baseEnv, R2_ACCESS_KEY_ID: "only-half" } as unknown as Env),
    /必须同时配置/,
  );
  assert.equal(
    loadCloudflareRuntimeConfig({ ...baseEnv, DATABASE_DRIVER: "postgres" } as unknown as Env).databaseDriver,
    "postgres",
  );
  assert.throws(
    () => loadCloudflareRuntimeConfig({ ...baseEnv, DATABASE_DRIVER: "unsupported" } as unknown as Env),
    /DATABASE_DRIVER/,
  );
});
