import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createPasswordHash, LocalAuth } from "../server/local-auth";
import { CloudflareEmailAuth } from "../worker/email-auth";

test("本地密码登录创建 30 天会话并支持退出", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-auth-"));
  const auth = new LocalAuth(join(root, "auth.sqlite"), {
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
