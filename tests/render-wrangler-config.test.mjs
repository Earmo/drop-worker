import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const renderScript = fileURLToPath(new URL("../scripts/render-wrangler-config.mjs", import.meta.url));

test("生产配置允许 994 端口的隐式 TLS SMTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-render-"));
  try {
    const output = join(root, "wrangler.jsonc");
    await execFileAsync(process.execPath, [renderScript, output], {
      cwd: repoRoot,
      env: {
        ...process.env,
        WORKER_NAME: "drop-worker",
        D1_DATABASE_NAME: "drop-worker",
        D1_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
        R2_BUCKET_NAME: "drop-worker-files",
        PUBLIC_URL: "https://drop.example.com",
        SHARING_ENABLED: "true",
        OWNER_EMAIL: "owner@example.com",
        AUTH_EMAIL_PROVIDER: "smtp",
        AUTH_FROM_EMAIL: "",
        AUTH_FROM_NAME: "Drop Worker",
        SMTP_HOST: "smtphz.qiye.163.com",
        SMTP_PORT: "994",
        SMTP_SECURE: "true",
        SMTP_FROM: "owner@example.com",
        SMTP_TIMEOUT_MS: "15000",
      },
    });

    const config = JSON.parse(await readFile(output, "utf8"));
    assert.equal(config.vars.SMTP_HOST, "smtphz.qiye.163.com");
    assert.equal(config.vars.SMTP_PORT, "994");
    assert.equal(config.vars.SMTP_SECURE, "true");
    assert.equal(config.vars.PUBLIC_URL, "https://drop.example.com");
    assert.equal(config.send_email, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
