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
        R2_ACCOUNT_ID: "1234567890abcdef",
        R2_PUBLIC_URL: "https://drop-files.example.com",
        PUBLIC_URL: "https://drop.example.com",
        SHARING_ENABLED: "true",
        OWNER_EMAIL: "owner@example.com",
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
    assert.equal(config.vars.R2_ACCOUNT_ID, "1234567890abcdef");
    assert.equal(config.vars.R2_BUCKET_NAME, "drop-worker-files");
    assert.equal(config.vars.R2_PUBLIC_URL, "https://drop-files.example.com/");
    assert.equal(config.d1_databases[0].migrations_dir, "./drizzle/sqlite");
    assert.equal(config.send_email, undefined);
    const cors = JSON.parse(await readFile(join(root, "r2-cors.json"), "utf8"));
    assert.deepEqual(cors.rules[0], {
      allowed: {
        origins: ["https://drop.example.com"],
        methods: ["GET", "HEAD", "PUT"],
        headers: ["content-type", "range"],
      },
      exposeHeaders: ["accept-ranges", "content-disposition", "content-length", "content-range", "etag"],
      maxAgeSeconds: 3600,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Actions 空变量使用部署默认值", async () => {
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
        R2_ACCOUNT_ID: "1234567890abcdef",
        PUBLIC_URL: "https://drop.example.com",
        SHARING_ENABLED: "",
        OWNER_EMAIL: "owner@example.com",
        AUTH_FROM_NAME: "Drop Worker",
        SMTP_HOST: "smtp.example.com",
        SMTP_PORT: "994",
        SMTP_SECURE: "false",
        SMTP_FROM: "owner@example.com",
        SMTP_TIMEOUT_MS: "15000",
      },
    });

    const config = JSON.parse(await readFile(output, "utf8"));
    assert.equal(config.vars.SHARING_ENABLED, "true");
    assert.equal(config.vars.R2_PUBLIC_URL, undefined);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("生产配置拒绝非 HTTPS 的公开 R2 地址", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-render-"));
  try {
    const output = join(root, "wrangler.jsonc");
    await assert.rejects(
      execFileAsync(process.execPath, [renderScript, output], {
        cwd: repoRoot,
        env: {
          ...process.env,
          WORKER_NAME: "drop-worker",
          D1_DATABASE_ID: "12345678-1234-1234-1234-123456789abc",
          R2_ACCOUNT_ID: "1234567890abcdef",
          R2_PUBLIC_URL: "http://drop-files.example.com",
          PUBLIC_URL: "https://drop.example.com",
          OWNER_EMAIL: "owner@example.com",
          SMTP_HOST: "smtp.example.com",
          SMTP_PORT: "587",
          SMTP_FROM: "owner@example.com",
        },
      }),
      /R2_PUBLIC_URL 必须是没有路径、查询参数或凭据的 HTTPS 站点根地址/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("GitHub Actions 在部署 Worker 前应用远程 D1 迁移", async () => {
  const workflow = await readFile(join(repoRoot, ".github", "workflows", "deploy.yml"), "utf8");
  const migration = workflow.indexOf("d1 migrations apply DB --remote --config wrangler.jsonc");
  const smtpDeploy = workflow.indexOf("部署 Worker（自定义 SMTP）");

  assert.ok(migration >= 0, "部署流程必须应用远程 D1 迁移");
  assert.ok(migration < smtpDeploy, "D1 迁移必须早于 SMTP 部署");
});

test("GitHub Actions 使用 Node 24 兼容的 Wrangler Action 并固定 CLI 版本", async () => {
  const workflow = await readFile(join(repoRoot, ".github", "workflows", "deploy.yml"), "utf8");
  const actionCount = (workflow.match(/uses: cloudflare\/wrangler-action@v4/g) || []).length;

  assert.equal(actionCount, 1, "Worker 部署必须使用 Wrangler Action v4");
  assert.doesNotMatch(workflow, /cloudflare\/wrangler-action@v3/);
  assert.match(workflow, /npx wrangler@4\.118\.0 d1 migrations apply DB --remote --config wrangler\.jsonc/);
  assert.match(workflow, /r2 bucket cors set "\$R2_BUCKET_NAME" --file/);
  assert.match(workflow, /R2_PUBLIC_URL: \$\{\{ vars\.R2_PUBLIC_URL \}\}/);
  assert.equal((workflow.match(/command: deploy --config wrangler\.jsonc --keep-vars/g) || []).length, 1);
  assert.match(workflow, /R2_ACCESS_KEY_ID/);
  assert.match(workflow, /R2_SECRET_ACCESS_KEY/);
  assert.match(workflow, /CLOUDFLARE_API_TOKEN 具备目标账号和 D1 数据库的 Edit 权限/);
  assert.equal((workflow.match(/wranglerVersion: "4\.118\.0"/g) || []).length, 1);
});
