import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalBlobStore, openLocalMetadataStore } from "../api/stores/local";
import { createPortableBackup, migratePortableStorage, restorePortableBackup } from "../server/storage/portable-storage";

const ENV_KEYS = [
  "SOURCE_DATA_DIR", "SOURCE_DATABASE_DRIVER", "SOURCE_BLOB_DRIVER", "SOURCE_SESSION_SECRET",
  "TARGET_DATA_DIR", "TARGET_DATABASE_DRIVER", "TARGET_BLOB_DRIVER", "TARGET_SESSION_SECRET",
] as const;

test("可移植存储备份保留条目与分享但丢弃登录会话", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-storage-migration-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const revokedTargetRoot = join(root, "target-revoked");
  const nonemptyTargetRoot = join(root, "target-nonempty");
  const missingObjectTargetRoot = join(root, "target-missing-object");
  const backupRoot = join(root, "backup");
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  await mkdir(sourceRoot);
  const sourceMetadata = openLocalMetadataStore(join(sourceRoot, "drop-worker.sqlite"));
  const sourceBlobs = new LocalBlobStore(sourceRoot);
  await sourceMetadata.store.ensureSchema();
  await sourceBlobs.prepare();
  try {
    const objectKey = "objects/portable-test";
    const bytes = new TextEncoder().encode("portable-object");
    const uploadId = await sourceBlobs.createMultipart(objectKey, "text/plain");
    const etag = await sourceBlobs.putPart(objectKey, uploadId, 1, bytes);
    await sourceBlobs.completeMultipart(objectKey, uploadId, [{ partNumber: 1, etag, sizeBytes: bytes.length }], "text/plain");
    const item = await sourceMetadata.store.createItem({
      ownerId: "portable-owner",
      type: "file",
      objectKey,
      originalName: "portable.txt",
      displayName: "portable.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
    });
    await sourceMetadata.store.createShare({
      id: "d65bfe8a-3c27-4bd4-a1b7-6a5bfb42120f",
      ownerId: "portable-owner",
      itemIds: [item.id],
      name: null,
      tokenHash: "a".repeat(43),
      accessMode: "code",
      codeHash: "b".repeat(43),
      codeEncrypted: "v1.portable.encrypted",
      now: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    await sourceMetadata.store.createAuthSession({
      id: crypto.randomUUID(),
      tokenHash: "session-token-hash",
      ownerId: "portable-owner",
      email: "owner@example.com",
      createdAt: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });

    process.env.SOURCE_DATA_DIR = sourceRoot;
    process.env.SOURCE_DATABASE_DRIVER = "sqlite";
    process.env.SOURCE_BLOB_DRIVER = "local";
    process.env.SOURCE_SESSION_SECRET = "portable-secret-that-is-long-enough";
    process.env.TARGET_DATA_DIR = targetRoot;
    process.env.TARGET_DATABASE_DRIVER = "sqlite";
    process.env.TARGET_BLOB_DRIVER = "local";
    process.env.TARGET_SESSION_SECRET = "portable-secret-that-is-long-enough";
    const firstBackup = await createPortableBackup(backupRoot, "SOURCE");
    const inventoryText = await readFile(join(backupRoot, "inventory.json"), "utf8");
    const inventory = JSON.parse(inventoryText) as {
      format: string;
      items: Array<Record<string, unknown>>;
      shares: Array<Record<string, unknown>>;
    };
    assert.equal(inventory.format, "drop-worker-export");
    assert.equal(inventory.items.length, 1);
    assert.equal(inventory.shares.length, 1);
    assert.equal("ownerId" in inventory.items[0]!, false);
    assert.equal("objectKey" in inventory.items[0]!, false);
    assert.equal("tokenHash" in inventory.shares[0]!, false);
    assert.equal("codeHash" in inventory.shares[0]!, false);
    assert.doesNotMatch(inventoryText, /v1\.portable\.encrypted/);
    let reusedObjects = 0;
    await createPortableBackup(backupRoot, "SOURCE", {
      onProgress: (progress) => {
        reusedObjects = Math.max(reusedObjects, progress.reusedObjects);
      },
    });
    assert.equal(reusedObjects, 1);

    const object = firstBackup.manifest.objects[0]!;
    const backupObjectPath = join(backupRoot, ...object.path.split("/"));
    const completeBytes = await readFile(backupObjectPath);
    await writeFile(`${backupObjectPath}.partial`, completeBytes.subarray(0, 5));
    await rm(backupObjectPath);
    await writeFile(
      join(backupRoot, "manifest.partial.json"),
      JSON.stringify(firstBackup.manifest, null, 2),
      "utf8",
    );
    await rm(join(backupRoot, "manifest.json"));
    const resumedBytes: number[] = [];
    await createPortableBackup(backupRoot, "SOURCE", {
      onProgress: (progress) => {
        if (progress.phase === "transferring") resumedBytes.push(progress.completedBytes);
      },
    });
    assert.ok(resumedBytes.some((value) => value === 5));
    assert.deepEqual(await readFile(backupObjectPath), completeBytes);
    await restorePortableBackup(backupRoot, "TARGET");

    const targetMetadata = openLocalMetadataStore(join(targetRoot, "drop-worker.sqlite"));
    const targetBlobs = new LocalBlobStore(targetRoot);
    await targetMetadata.store.ensureSchema();
    try {
      const items = await targetMetadata.store.listPortableItems();
      const shares = await targetMetadata.store.listPortableShares();
      assert.equal(items.length, 1);
      assert.equal(shares.length, 1);
      assert.equal(shares[0]?.codeHash, "b".repeat(43));
      assert.equal(shares[0]?.codeEncrypted, "v1.portable.encrypted");
      assert.equal(await targetMetadata.store.getAuthSession("session-token-hash", Date.now()), null);
      const restoredObject = await targetBlobs.get(objectKey);
      assert.equal(await new Response(restoredObject?.body).text(), "portable-object");
    } finally {
      targetMetadata.close();
    }

    process.env.TARGET_DATA_DIR = revokedTargetRoot;
    process.env.TARGET_SESSION_SECRET = "different-portable-secret-that-is-long-enough";
    await assert.rejects(restorePortableBackup(backupRoot, "TARGET"), /SESSION_SECRET 指纹不匹配/);
    await restorePortableBackup(backupRoot, "TARGET", true);
    const revokedMetadata = openLocalMetadataStore(join(revokedTargetRoot, "drop-worker.sqlite"));
    await revokedMetadata.store.ensureSchema();
    try {
      assert.ok((await revokedMetadata.store.listPortableShares())[0]?.revokedAt);
    } finally {
      revokedMetadata.close();
    }

    await mkdir(nonemptyTargetRoot);
    const nonemptyMetadata = openLocalMetadataStore(join(nonemptyTargetRoot, "drop-worker.sqlite"));
    await nonemptyMetadata.store.ensureSchema();
    await nonemptyMetadata.store.createItem({ ownerId: "other-owner", type: "text", content: "existing" });
    nonemptyMetadata.close();
    process.env.TARGET_DATA_DIR = nonemptyTargetRoot;
    process.env.TARGET_SESSION_SECRET = "portable-secret-that-is-long-enough";
    await assert.rejects(restorePortableBackup(backupRoot, "TARGET"), /目标包含其他数据/);

    await rm(join(backupRoot, "objects", objectKey));
    process.env.TARGET_DATA_DIR = missingObjectTargetRoot;
    await assert.rejects(restorePortableBackup(backupRoot, "TARGET"), /ENOENT/);
  } finally {
    sourceMetadata.close();
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("存储迁移丢弃未完成上传并写入可重试报告", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-storage-report-"));
  const sourceRoot = join(root, "source");
  const targetRoot = join(root, "target");
  const workRoot = join(root, "work");
  const previous = new Map(ENV_KEYS.map((key) => [key, process.env[key]]));
  await mkdir(sourceRoot);
  const metadata = openLocalMetadataStore(join(sourceRoot, "drop-worker.sqlite"));
  const blobs = new LocalBlobStore(sourceRoot);
  await metadata.store.ensureSchema();
  await blobs.prepare();
  try {
    const objectKey = "objects/pending-portable-test";
    const providerUploadId = await blobs.createMultipart(objectKey, "text/plain");
    const upload = await metadata.store.createUpload({
      ownerId: "portable-owner",
      objectKey,
      providerUploadId,
      fileName: "pending.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      fingerprint: "pending.txt:12:1",
      now: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    }, 1024 * 1024);
    assert.ok(upload);
    metadata.close();

    process.env.SOURCE_DATA_DIR = sourceRoot;
    process.env.SOURCE_DATABASE_DRIVER = "sqlite";
    process.env.SOURCE_BLOB_DRIVER = "local";
    process.env.SOURCE_SESSION_SECRET = "portable-secret-that-is-long-enough";
    process.env.TARGET_DATA_DIR = targetRoot;
    process.env.TARGET_DATABASE_DRIVER = "sqlite";
    process.env.TARGET_BLOB_DRIVER = "local";
    process.env.TARGET_SESSION_SECRET = "portable-secret-that-is-long-enough";
    assert.equal(await migratePortableStorage(workRoot), workRoot);
    const report = JSON.parse(await readFile(join(workRoot, "migration-report.json"), "utf8")) as {
      status: string;
      discardedUploads: Array<{ id: string; abortStatus: string }>;
    };
    assert.equal(report.status, "completed");
    assert.deepEqual(report.discardedUploads, [{
      id: upload.id,
      objectKey,
      abortStatus: "aborted",
    }]);
  } finally {
    try {
      metadata.close();
    } catch {
      // 测试主路径会在迁移前关闭连接；失败路径仍需要清理。
    }
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  }
});

test("未完成迁移目标不能启动应用但仍可由同一迁移继续恢复", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-incomplete-target-"));
  const metadata = openLocalMetadataStore(join(root, "drop-worker.sqlite"));
  await metadata.store.ensureSchema();
  const migrationId = crypto.randomUUID();
  try {
    assert.equal(
      await metadata.store.preparePortableImport(migrationId, Date.now(), true),
      "new",
    );
    await assert.rejects(metadata.store.ensureApplicationReady(), /存储迁移尚未完成/);
    assert.equal(
      await metadata.store.preparePortableImport(migrationId, Date.now(), true),
      "resume",
    );
    await metadata.store.finishPortableImport(migrationId, Date.now());
    await assert.doesNotReject(metadata.store.ensureApplicationReady());
  } finally {
    metadata.close();
    await rm(root, { recursive: true, force: true });
  }
});
