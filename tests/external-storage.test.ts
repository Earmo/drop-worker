import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCleanup } from "../apps/api/cleanup";
import { handleApiRequest } from "../apps/api/create-api";
import { keyedDigest, tokenForShare } from "../apps/api/sharing";
import { LocalBlobStore, openLocalMetadataStore } from "../apps/api/stores/local";
import { openRelationalMetadataStore } from "../apps/api/stores/relational";
import { createS3BlobStoreFromEnv } from "../apps/api/stores/s3";
import type { RuntimeServices } from "../apps/api/platform";
import type { CreateShareResponse, DropItem, PublicShareContent, UploadSession } from "../packages/contracts";
import { migrateConfiguredDatabase } from "../server/migrate-database";
import { migratePortableStorage } from "../server/portable-storage";

const enabled = process.env.RUN_EXTERNAL_STORAGE_TESTS === "true";
const MIGRATION_CONFIG_KEYS = [
  "DATABASE_DRIVER", "DATABASE_URL", "DATABASE_POOL_SIZE", "DATABASE_CA_FILE", "DATABASE_ALLOW_INSECURE",
  "BLOB_DRIVER", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_PREFIX", "S3_FORCE_PATH_STYLE",
  "S3_ALLOW_INSECURE", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
  "S3_SERVER_SIDE_ENCRYPTION", "S3_KMS_KEY_ID",
] as const;
const PORTABLE_SECRET = "external-portable-secret-that-is-long-enough";

function copyCurrentConfiguration(prefix: "SOURCE" | "TARGET"): void {
  for (const key of MIGRATION_CONFIG_KEYS) {
    const value = process.env[key];
    if (value === undefined) delete process.env[`${prefix}_${key}`];
    else process.env[`${prefix}_${key}`] = value;
  }
}

function preservePrefixedConfiguration(): () => void {
  const keys = [
    ...MIGRATION_CONFIG_KEYS.flatMap((key) => [`SOURCE_${key}`, `TARGET_${key}`]),
    "SOURCE_DATA_DIR", "TARGET_DATA_DIR", "SOURCE_SESSION_SECRET", "TARGET_SESSION_SECRET",
  ];
  const previous = new Map(keys.map((key) => [key, process.env[key]]));
  return () => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };
}

function call(services: RuntimeServices, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return handleApiRequest(new Request(`http://localhost${path}`, { ...init, headers }), services);
}

test("SQLite 与本地对象可以离线迁移到真实外部存储", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-external-target-"));
  const sourceRoot = join(root, "source");
  const restore = preservePrefixedConfiguration();
  await mkdir(sourceRoot);
  const sourceMetadata = openLocalMetadataStore(join(sourceRoot, "drop-worker.sqlite"));
  const sourceBlobs = new LocalBlobStore(sourceRoot);
  await sourceMetadata.store.ensureSchema();
  await sourceBlobs.prepare();
  try {
    const objectKey = "objects/migration-fixture";
    const bytes = new TextEncoder().encode("local-to-external");
    const providerUploadId = await sourceBlobs.createMultipart(objectKey, "text/plain");
    const etag = await sourceBlobs.putPart(objectKey, providerUploadId, 1, bytes);
    await sourceBlobs.completeMultipart(
      objectKey,
      providerUploadId,
      [{ partNumber: 1, etag, sizeBytes: bytes.length }],
      "text/plain",
    );
    const item = await sourceMetadata.store.createItem({
      ownerId: "migration-owner",
      type: "file",
      objectKey,
      originalName: "migration.txt",
      displayName: "migration.txt",
      mimeType: "text/plain",
      sizeBytes: bytes.length,
    });
    const shareId = crypto.randomUUID();
    const shareToken = await tokenForShare(PORTABLE_SECRET, shareId);
    await sourceMetadata.store.createShare({
      id: shareId,
      ownerId: "migration-owner",
      itemId: item.id,
      tokenHash: await keyedDigest(PORTABLE_SECRET, "share-token-hash", shareToken),
      accessMode: "public",
      codeHash: null,
      now: Date.now(),
      expiresAt: Date.now() + 86_400_000,
    });
    sourceMetadata.close();

    process.env.SOURCE_DATA_DIR = sourceRoot;
    process.env.SOURCE_DATABASE_DRIVER = "sqlite";
    process.env.SOURCE_BLOB_DRIVER = "local";
    process.env.SOURCE_SESSION_SECRET = PORTABLE_SECRET;
    copyCurrentConfiguration("TARGET");
    process.env.TARGET_DATA_DIR = join(root, "target-state");
    process.env.TARGET_SESSION_SECRET = PORTABLE_SECRET;
    await migratePortableStorage(join(root, "migration-work"));

    const targetMetadata = await openRelationalMetadataStore("unused.sqlite");
    const targetBlobs = createS3BlobStoreFromEnv();
    await targetMetadata.store.ensureSchema();
    try {
      const restored = (await targetMetadata.store.listPortableItems())
        .find((candidate) => candidate.ownerId === "migration-owner");
      assert.equal(restored?.displayName, "migration.txt");
      const object = await targetBlobs.get(objectKey);
      assert.equal(await new Response(object?.body).text(), "local-to-external");
      assert.equal(
        (await targetMetadata.store.listPortableShares()).filter((share) => share.ownerId === "migration-owner").length,
        1,
      );
    } finally {
      targetBlobs.close();
      await targetMetadata.close();
    }
  } finally {
    try {
      sourceMetadata.close();
    } catch {
      // 主路径会在迁移前关闭 SQLite；失败路径仍需要清理。
    }
    restore();
    await rm(root, { recursive: true, force: true });
  }
});

test("真实关系型数据库与 S3 完成上传、分享和 Range 下载", { skip: !enabled }, async () => {
  await migrateConfiguredDatabase();
  const metadata = await openRelationalMetadataStore("unused.sqlite");
  const blobs = createS3BlobStoreFromEnv();
  await metadata.store.ensureSchema();
  await blobs.healthCheck();
  const services: RuntimeServices = {
    metadata: metadata.store,
    blobs,
    quotaBytes: 1024 * 1024,
    authMode: "development",
    insecureHttp: false,
    sharing: {
      enabled: true,
      publicUrl: new URL("http://localhost"),
      secret: PORTABLE_SECRET,
      resolveClientAddress: () => "127.0.0.1",
    },
    resolveIdentity: async () => ({ ownerId: "external-owner", email: "owner@example.com" }),
  };
  try {
    services.quotaBytes = 20;
    const concurrentUploads = await Promise.all([
      call(services, "/api/uploads", {
        method: "POST",
        body: JSON.stringify({
          fileName: "quota-a.bin", mimeType: "application/octet-stream", sizeBytes: 16,
          fingerprint: "quota-a:16:1",
        }),
      }),
      call(services, "/api/uploads", {
        method: "POST",
        body: JSON.stringify({
          fileName: "quota-b.bin", mimeType: "application/octet-stream", sizeBytes: 16,
          fingerprint: "quota-b:16:1",
        }),
      }),
    ]);
    assert.deepEqual(concurrentUploads.map((response) => response.status).sort(), [201, 409]);
    const acceptedUpload = (await concurrentUploads.find((response) => response.status === 201)!.json()) as UploadSession;
    assert.equal((await call(services, `/api/uploads/${acceptedUpload.id}`, { method: "DELETE" })).status, 200);
    services.quotaBytes = 1024 * 1024;

    const bytes = new TextEncoder().encode("external-storage");
    const upload = (await (await call(services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "external.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.length,
        fingerprint: "external.txt:16:1",
      }),
    })).json()) as UploadSession;
    await call(services, `/api/uploads/${upload.id}/parts/1`, {
      method: "PUT",
      body: bytes,
      headers: { "content-length": String(bytes.length), "content-type": "application/octet-stream" },
    });
    const item = (await (await call(services, `/api/uploads/${upload.id}/complete`, {
      method: "POST",
      body: "{}",
    })).json()) as DropItem;
    const share = (await (await call(services, `/api/items/${item.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "public", expiresInSeconds: 3_600 }),
    })).json()) as CreateShareResponse;
    const token = new URL(share.shareUrl).pathname.split("/").at(-1)!;
    const info = (await (await call(services, `/api/public/shares/${token}`)).json()) as PublicShareContent;
    assert.equal(info.type, "file");
    const range = await call(services, `/api/public/shares/${token}/download`, {
      headers: { range: "bytes=9-15" },
    });
    assert.equal(range.status, 206);
    assert.equal(await range.text(), "storage");
    const rotated = await Promise.all([
      call(services, `/api/items/${item.id}/share`, {
        method: "POST",
        body: JSON.stringify({ accessMode: "public", expiresInSeconds: 86_400 }),
      }),
      call(services, `/api/items/${item.id}/share`, {
        method: "POST",
        body: JSON.stringify({ accessMode: "code", code: "0042", expiresInSeconds: 604_800 }),
      }),
    ]);
    const rotatedShares = await Promise.all(rotated.map((response) => response.json() as Promise<CreateShareResponse>));
    const rotatedStatuses = await Promise.all(rotatedShares.map(({ shareUrl }) => {
      const rotatedToken = new URL(shareUrl).pathname.split("/").at(-1)!;
      return call(services, `/api/public/shares/${rotatedToken}`).then((response) => response.status);
    }));
    assert.equal(rotatedStatuses.filter((status) => status === 200 || status === 401).length, 1);
    assert.equal(rotatedStatuses.filter((status) => status === 404).length, 1);
    const protectedShare = (await (await call(services, `/api/items/${item.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "code", code: "0042", expiresInSeconds: 604_800 }),
    })).json()) as CreateShareResponse;
    const protectedToken = new URL(protectedShare.shareUrl).pathname.split("/").at(-1)!;
    assert.equal((await call(services, `/api/public/shares/${protectedToken}`)).status, 401);
    const failedCodes = await Promise.all(Array.from({ length: 5 }, () =>
      call(services, `/api/public/shares/${protectedToken}/verify`, {
        method: "POST",
        body: JSON.stringify({ code: "9999" }),
      }),
    ));
    assert.deepEqual(failedCodes.map((response) => response.status).sort(), [401, 401, 401, 401, 429]);
    assert.equal((await call(services, `/api/public/shares/${protectedToken}/verify`, {
      method: "POST",
      body: JSON.stringify({ code: "0042" }),
    })).status, 429);

    await metadata.store.createAuthSession({
      id: crypto.randomUUID(), tokenHash: "external-session", ownerId: "external-owner",
      email: "owner@example.com", createdAt: Date.now(), expiresAt: Date.now() + 60_000,
    });
    assert.equal((await metadata.store.getAuthSession("external-session", Date.now()))?.ownerId, "external-owner");
    const challengeId = crypto.randomUUID();
    await metadata.store.createAuthChallenge({
      id: challengeId,
      email: "owner@example.com",
      codeHash: "challenge-hash",
      attempts: 0,
      createdAt: Date.now(),
      expiresAt: Date.now() + 60_000,
    });
    await metadata.store.incrementAuthChallengeAttempts(challengeId);
    assert.equal((await metadata.store.getAuthChallenge(challengeId, "owner@example.com"))?.attempts, 1);
    await metadata.store.deleteAuthChallenge(challengeId);

    const activeShare = (await metadata.store.listShares("external-owner", Date.now(), 0))
      .find((candidate) => candidate.revokedAt === null)!;
    await metadata.store.saveShareAttempt({
      shareId: activeShare.id,
      sourceHash: "source-digest",
      failures: 2,
      lockedUntil: 0,
      updatedAt: Date.now() - 16 * 60 * 1000,
    });
    await runCleanup(services);
    assert.equal(await metadata.store.getShareAttempt(activeShare.id, "source-digest"), null);
  } finally {
    blobs.close();
    await metadata.close();
  }
});

test("真实外部存储可以离线迁移回 SQLite 与本地对象", { skip: !enabled }, async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-external-source-"));
  const targetRoot = join(root, "target");
  const restore = preservePrefixedConfiguration();
  try {
    copyCurrentConfiguration("SOURCE");
    process.env.SOURCE_DATA_DIR = join(root, "source-state");
    process.env.SOURCE_SESSION_SECRET = PORTABLE_SECRET;
    process.env.TARGET_DATA_DIR = targetRoot;
    process.env.TARGET_DATABASE_DRIVER = "sqlite";
    process.env.TARGET_BLOB_DRIVER = "local";
    process.env.TARGET_SESSION_SECRET = PORTABLE_SECRET;
    await migratePortableStorage(join(root, "migration-work"));

    const metadata = openLocalMetadataStore(join(targetRoot, "drop-worker.sqlite"));
    const blobs = new LocalBlobStore(targetRoot);
    await metadata.store.ensureSchema();
    try {
      const items = await metadata.store.listPortableItems();
      const files = items.filter((item) => item.type === "file" && item.objectKey);
      assert.ok(files.length >= 2);
      for (const file of files) {
        const object = await blobs.get(file.objectKey!);
        assert.equal(object?.totalSize, file.sizeBytes);
      }
      assert.ok((await metadata.store.listPortableShares()).length >= 2);
      await assert.doesNotReject(metadata.store.ensureApplicationReady());
    } finally {
      metadata.close();
    }
  } finally {
    restore();
    await rm(root, { recursive: true, force: true });
  }
});
