import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { LocalBlobStore, openLocalMetadataStore } from "../api/stores/local";
import { parseAdminArguments } from "../server/admin";

const execFileAsync = promisify(execFile);

test("管理命令不会把 revoke-shares 选项当作工作目录", () => {
  assert.deepEqual(parseAdminArguments(["migrate-storage", "--revoke-shares"]), {
    command: "migrate-storage",
    argument: undefined,
    revokeShares: true,
  });
  assert.deepEqual(parseAdminArguments(["migrate-storage", "./work", "--revoke-shares"]), {
    command: "migrate-storage",
    argument: "./work",
    revokeShares: true,
  });
  assert.deepEqual(parseAdminArguments(["migrate-storage", "--revoke-shares", "./work"]), {
    command: "migrate-storage",
    argument: "./work",
    revokeShares: true,
  });
});

test("本地原样备份同时生成不含内部字段的数据清单", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-admin-backup-"));
  const dataRoot = join(root, "data");
  const backupRoot = join(root, "backup");
  await mkdir(dataRoot);
  const metadata = openLocalMetadataStore(join(dataRoot, "drop-worker.sqlite"));
  const blobs = new LocalBlobStore(dataRoot);
  await metadata.store.ensureSchema();
  await blobs.prepare();
  try {
    await metadata.store.createItem({ ownerId: "local-owner", type: "text", content: "inventory text" });
    metadata.close();
    await execFileAsync(
      process.execPath,
      ["--import", "tsx", resolve("server/admin.ts"), "backup", backupRoot],
      { cwd: process.cwd(), env: { ...process.env, DATA_DIR: dataRoot } },
    );
    const inventory = JSON.parse(await readFile(join(backupRoot, "inventory.json"), "utf8")) as {
      format: string;
      items: Array<Record<string, unknown>>;
    };
    assert.equal(inventory.format, "drop-worker-export");
    assert.equal(inventory.items[0]?.content, "inventory text");
    assert.equal("ownerId" in inventory.items[0]!, false);
    assert.equal("objectKey" in inventory.items[0]!, false);
  } finally {
    try {
      metadata.close();
    } catch {
      // 主路径在执行子进程前关闭数据库；失败路径仍需要释放句柄。
    }
    await rm(root, { recursive: true, force: true });
  }
});
