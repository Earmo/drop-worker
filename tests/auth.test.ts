import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openLocalMetadataStore } from "../api/stores/local";
import { validatePublicUrl } from "../api/sharing";
import { createPasswordHash, LocalAuth } from "../server/auth/local-auth";
import { CloudflareEmailAuth } from "../worker/auth/email-auth";
import { createCloudflareServices } from "../worker/runtime/services";

test("本地密码登录创建 30 天会话并支持退出", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-auth-"));
  const metadata = openLocalMetadataStore(join(root, "auth.sqlite"));
  await metadata.store.ensureSchema();
  const auth = new LocalAuth(metadata.store, {
    mode: "password",
    email: "owner@example.com",
    passwordHash: createPasswordHash("correct horse battery staple"),
    sessionSecret: "a-secure-session-secret-that-is-long-enough",
    publicUrl: new URL("http://localhost:3000"),
    insecureHttp: false,
  });
  try {
    const failed = await auth.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "owner@example.com", password: "wrong password" }),
      }),
    );
    assert.equal(failed?.status, 401);

    const response = await auth.handle(
      new Request("http://localhost/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "owner@example.com", password: "correct horse battery staple" }),
      }),
    );
    assert.equal(response?.status, 200);
    const cookie = response?.headers.get("set-cookie");
    assert.ok(cookie?.includes("Max-Age=2592000"));
    assert.ok(cookie?.includes("HttpOnly"));

    const identity = await auth.resolveIdentity(
      new Request("http://localhost/api/items", { headers: { cookie: cookie?.split(";")[0] || "" } }),
    );
    assert.equal(identity?.email, "owner@example.com");

    const logout = await auth.handle(
      new Request("http://localhost/api/auth/logout", {
        method: "POST",
        headers: { cookie: cookie?.split(";")[0] || "" },
      }),
    );
    assert.match(logout?.headers.get("set-cookie") || "", /Max-Age=0/);
  } finally {
    auth.close();
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare SMTP 接受 994 端口的隐式 TLS 配置", () => {
  const env = {
    AUTH_SESSION_SECRET: "a-secure-session-secret-that-is-long-enough",
    AUTH_EMAIL_PROVIDER: "smtp",
    OWNER_EMAIL: "owner@example.com",
    AUTH_FROM_EMAIL: "",
    AUTH_FROM_NAME: "Drop Worker",
    SMTP_HOST: "smtphz.qiye.163.com",
    SMTP_PORT: "994",
    SMTP_SECURE: "true",
    SMTP_FROM: "owner@example.com",
    SMTP_TIMEOUT_MS: "15000",
    SMTP_USERNAME: "owner@example.com",
    SMTP_PASSWORD: "smtp-app-password",
  } as unknown as Env;

  assert.doesNotThrow(() => new CloudflareEmailAuth(env));
});

test("公开地址只接受站点根地址且默认要求安全传输", () => {
  assert.equal(validatePublicUrl("http://localhost:3000").origin, "http://localhost:3000");
  assert.equal(validatePublicUrl("https://drop.example.com").origin, "https://drop.example.com");
  assert.equal(
    validatePublicUrl("http://drop.internal:3000", true).origin,
    "http://drop.internal:3000",
  );
  assert.throws(() => validatePublicUrl("http://drop.example.com"), /必须使用 HTTPS/);
  assert.throws(() => validatePublicUrl("ftp://drop.example.com"), /HTTP 或 HTTPS/);
  assert.throws(() => validatePublicUrl("https://drop.example.com/base"), /站点根地址/);
  assert.throws(() => validatePublicUrl("https://user:secret@drop.example.com"), /站点根地址/);
});

test("公开 Sites 仍只把配置邮箱识别为工作区所有者", async () => {
  const baseEnv = {
    AUTH_MODE: "platform",
    AUTH_SESSION_SECRET: "a-secure-session-secret-that-is-long-enough",
    PUBLIC_URL: "https://drop.example.com",
    SHARING_ENABLED: "true",
    DB: {},
    FILES: {},
  };
  assert.throws(
    () => createCloudflareServices(baseEnv as unknown as Env),
    /必须配置 OWNER_EMAIL/,
  );

  const services = createCloudflareServices({
    ...baseEnv,
    OWNER_EMAIL: "owner@example.com",
  } as unknown as Env);
  const owner = await services.auth.resolveIdentity(new Request("https://drop.example.com/api/items", {
    headers: {
      "oai-authenticated-user-id": "owner-id",
      "oai-authenticated-user-email": "Owner@Example.com",
    },
  }));
  assert.equal(owner?.ownerId, "sites:owner-id");
  const visitor = await services.auth.resolveIdentity(new Request("https://drop.example.com/api/items", {
    headers: {
      "oai-authenticated-user-id": "visitor-id",
      "oai-authenticated-user-email": "visitor@example.com",
    },
  }));
  assert.equal(visitor, null);
});
