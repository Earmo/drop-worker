import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EmailOtpAuth } from "../api/auth";
import { openLocalMetadataStore } from "../api/stores/local";
import { validatePublicUrl } from "../api/sharing";
import type { MailMessage, MailSender } from "../api/platform";
import { createPasswordHash, LocalAuth } from "../server/auth/local-auth";
import { loadCloudflareRuntimeConfig } from "../worker/runtime/config";
import { createCloudflareRuntime } from "../worker/runtime/services";

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

test("本地 SMTP OTP 复用共享认证流程并执行发送限流", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-auth-"));
  const metadata = openLocalMetadataStore(join(root, "auth.sqlite"));
  await metadata.store.ensureSchema();
  const messages: MailMessage[] = [];
  const mailer: MailSender = {
    send: async (message) => { messages.push(message); },
    close: () => undefined,
  };
  const auth = new LocalAuth(metadata.store, {
    mode: "smtp-otp",
    email: "owner@example.com",
    sessionSecret: "a-secure-session-secret-that-is-long-enough",
    publicUrl: new URL("http://localhost:3000"),
    insecureHttp: false,
    smtp: {
      host: "smtp.example.com",
      port: 587,
      secure: false,
      user: "owner@example.com",
      password: "smtp-password",
      from: "owner@example.com",
    },
  }, mailer);
  try {
    const request = () => auth.handle(new Request("http://localhost/api/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com" }),
    }));
    const sent = await request();
    assert.equal(sent?.status, 200);
    assert.equal(messages.length, 1);
    const challengeId = (await sent?.json() as { challengeId: string }).challengeId;
    const code = /\b(\d{6})\b/.exec(messages[0].text)?.[1];
    assert.ok(code);

    const rateLimited = await request();
    assert.equal(rateLimited?.status, 429);
    assert.equal(messages.length, 1);

    const verified = await auth.handle(new Request("http://localhost/api/auth/verify-otp", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com", challengeId, code }),
    }));
    assert.equal(verified?.status, 200);
    assert.match(verified?.headers.get("set-cookie") || "", /HttpOnly/);
  } finally {
    auth.close();
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("共享 OTP 流程在 SMTP 发信失败时撤销挑战", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-auth-"));
  const metadata = openLocalMetadataStore(join(root, "auth.sqlite"));
  await metadata.store.ensureSchema();
  const auth = new EmailOtpAuth(
    metadata.store,
    {
      email: "owner@example.com",
      from: { address: "owner@example.com", name: "Drop Worker" },
      sessionSecret: "a-secure-session-secret-that-is-long-enough",
      secureCookie: false,
      ownerIdPrefix: "test",
    },
    { send: async () => { throw new Error("SMTP unavailable"); } },
  );
  try {
    const response = await auth.handle(new Request("http://localhost/api/auth/request-otp", {
      method: "POST",
      body: JSON.stringify({ email: "owner@example.com" }),
    }));
    assert.equal(response?.status, 500);
    assert.equal(await metadata.store.getLatestAuthChallenge("owner@example.com"), null);
  } finally {
    auth.close();
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Cloudflare SMTP 接受 994 端口的隐式 TLS 配置", () => {
  const env = {
    AUTH_MODE: "smtp-otp",
    AUTH_SESSION_SECRET: "a-secure-session-secret-that-is-long-enough",
    OWNER_EMAIL: "owner@example.com",
    AUTH_FROM_NAME: "Drop Worker",
    PUBLIC_URL: "https://drop.example.com",
    SHARING_ENABLED: "true",
    SMTP_HOST: "smtphz.qiye.163.com",
    SMTP_PORT: "994",
    SMTP_SECURE: "true",
    SMTP_FROM: "owner@example.com",
    SMTP_TIMEOUT_MS: "15000",
    SMTP_USERNAME: "owner@example.com",
    SMTP_PASSWORD: "smtp-app-password",
  } as unknown as Env;

  assert.equal(loadCloudflareRuntimeConfig(env).smtp?.secure, true);
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

test("Cloudflare 开发身份只在本机回环地址生效", async () => {
  const baseEnv = {
    AUTH_MODE: "development",
    AUTH_SESSION_SECRET: "a-secure-session-secret-that-is-long-enough",
    PUBLIC_URL: "https://drop.example.com",
    SHARING_ENABLED: "true",
    DB: {},
    FILES: {},
  };
  const runtime = await createCloudflareRuntime({
    ...baseEnv,
    DATABASE_DRIVER: "sqlite",
    OWNER_EMAIL: "owner@example.com",
  } as unknown as Env);
  try {
    const owner = await runtime.services.auth.resolveIdentity(new Request("http://localhost/api/items"));
    assert.equal(owner?.ownerId, "development:owner");
    const remote = await runtime.services.auth.resolveIdentity(new Request("https://drop.example.com/api/items"));
    assert.equal(remote, null);
  } finally {
    await runtime.close();
  }
});
