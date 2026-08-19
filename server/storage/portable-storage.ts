import { createHash } from "node:crypto";
import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { LocalBlobStore } from "../../api/stores/local";
import { openRelationalMetadataStore } from "../../api/stores/relational";
import { createS3BlobStoreFromEnv, S3BlobStore } from "../../api/stores/s3";
import type { BlobStore, MetadataStore, StoredItem } from "../../api/platform";
import { parseBlobDriver } from "../../api/runtime-config";
import { migrateConfiguredDatabase } from "./migrate-database";

const CONFIG_KEYS = [
  "DATABASE_DRIVER", "DATABASE_URL", "DATABASE_POOL_SIZE", "DATABASE_CA_FILE", "DATABASE_ALLOW_INSECURE",
  "BLOB_DRIVER", "S3_ENDPOINT", "S3_REGION", "S3_BUCKET", "S3_PREFIX", "S3_FORCE_PATH_STYLE",
  "S3_ALLOW_INSECURE", "S3_ACCESS_KEY_ID", "S3_SECRET_ACCESS_KEY", "S3_SESSION_TOKEN",
  "S3_SERVER_SIDE_ENCRYPTION", "S3_KMS_KEY_ID",
] as const;

const portableItemSchema = z.object({
  id: z.string().uuid(), ownerId: z.string().min(1), type: z.enum(["text", "link", "file"]),
  content: z.string().nullable(), title: z.string().nullable(), objectKey: z.string().nullable(),
  originalName: z.string().nullable(), displayName: z.string().nullable(), mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(), favorite: z.boolean(), createdAt: z.number().int(),
  updatedAt: z.number().int(), deletedAt: z.number().int().nullable(),
});

const portableShareMemberSchema = z.object({
  itemId: z.string().uuid(), position: z.number().int().nonnegative(), addedAt: z.number().int(),
  removedAt: z.number().int().nullable(), removalReason: z.enum(["manual", "trash"]).nullable(),
  downloadCount: z.number().int().nonnegative(),
});

const portableShareSchema = z.object({
  id: z.string().uuid(), ownerId: z.string().min(1), itemId: z.string().uuid().optional(),
  name: z.string().nullable().default(null), members: z.array(portableShareMemberSchema).optional(),
  tokenHash: z.string().min(32), accessMode: z.enum(["public", "code"]), codeHash: z.string().nullable(),
  codeEncrypted: z.string().nullable().default(null),
  createdAt: z.number().int(), expiresAt: z.number().int(), revokedAt: z.number().int().nullable(),
  accessCount: z.number().int().nonnegative(), downloadCount: z.number().int().nonnegative(),
  lastAccessedAt: z.number().int().nullable(),
});

const portableManifestSchema = z.object({
  format: z.literal("drop-worker-portable-storage"),
  version: z.union([z.literal(2), z.literal(3)]),
  migrationId: z.string().uuid(),
  createdAt: z.string(),
  schemaVersion: z.union([z.literal(3), z.literal(4), z.literal(5)]),
  secretFingerprint: z.string().length(64),
  items: z.array(portableItemSchema),
  shares: z.array(portableShareSchema),
  objects: z.array(z.object({
    objectKey: z.string().min(1),
    path: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    sha256: z.string().length(64),
  })),
});

const migrationReportSchema = z.object({
  format: z.literal("drop-worker-storage-migration-report"),
  version: z.literal(1),
  migrationId: z.string().uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  status: z.enum(["prepared", "completed", "failed"]),
  discardedUploads: z.array(z.object({
    id: z.string().uuid(),
    objectKey: z.string().min(1),
    abortStatus: z.enum(["aborted", "failed"]),
  })),
  failure: z.string().nullable(),
});

type PortableManifest = z.infer<typeof portableManifestSchema>;
type MigrationReport = z.infer<typeof migrationReportSchema>;

type OpenStorage = {
  dataRoot: string;
  metadata: MetadataStore;
  blobs: BlobStore;
  close(): Promise<void>;
};

function secretValue(prefix?: "SOURCE" | "TARGET"): string {
  const value = (prefix ? process.env[`${prefix}_SESSION_SECRET`] : process.env.SESSION_SECRET)?.trim();
  if (!value || value.length < 32) throw new Error(`${prefix ? `${prefix}_` : ""}SESSION_SECRET 至少需要 32 个字符`);
  return value;
}

function secretFingerprint(secret: string): string {
  return createHash("sha256").update(`drop-worker-secret:${secret}`).digest("hex");
}

async function withPrefixedConfiguration<T>(
  prefix: "SOURCE" | "TARGET" | undefined,
  operation: () => Promise<T>,
): Promise<T> {
  if (!prefix) return operation();
  const previous = new Map<string, string | undefined>();
  for (const key of CONFIG_KEYS) {
    previous.set(key, process.env[key]);
    const value = process.env[`${prefix}_${key}`];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function openStorage(prefix?: "SOURCE" | "TARGET", migrate = false): Promise<OpenStorage> {
  const configuredDataRoot = prefix ? process.env[`${prefix}_DATA_DIR`] : process.env.DATA_DIR;
  const dataRoot = resolve(process.cwd(), configuredDataRoot || "./data");
  await mkdir(dataRoot, { recursive: true });
  return withPrefixedConfiguration(prefix, async () => {
    if (migrate && (process.env.DATABASE_DRIVER === "mysql" || process.env.DATABASE_DRIVER === "postgres")) {
      await migrateConfiguredDatabase();
    }
    const blobDriver = parseBlobDriver(process.env.BLOB_DRIVER);
    const relational = await openRelationalMetadataStore(resolve(dataRoot, "drop-worker.sqlite"));
    await relational.store.ensureSchema();
    if (prefix !== "TARGET") await relational.store.ensureApplicationReady();
    const blobs = blobDriver === "local"
      ? new LocalBlobStore(dataRoot)
      : createS3BlobStoreFromEnv();
    await blobs.healthCheck();
    return {
      dataRoot,
      metadata: relational.store,
      blobs,
      close: async () => {
        if (blobs instanceof S3BlobStore) blobs.close();
        await relational.close();
      },
    };
  });
}

function safePath(root: string, relativePath: string): string {
  const candidate = resolve(root, relativePath);
  if (candidate !== root && !candidate.startsWith(`${root}${sep}`)) {
    throw new Error(`备份清单包含越界路径：${relativePath}`);
  }
  return candidate;
}

async function hashFile(path: string): Promise<{ sizeBytes: number; sha256: string }> {
  const file = await open(path, "r");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      hash.update(buffer.subarray(0, bytesRead));
      sizeBytes += bytesRead;
    }
  } finally {
    await file.close();
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function saveBlob(blobs: BlobStore, objectKey: string, path: string): Promise<{ sizeBytes: number; sha256: string }> {
  const object = await blobs.get(objectKey);
  if (!object) throw new Error(`已完成文件缺失：${objectKey}`);
  await mkdir(dirname(path), { recursive: true });
  const file = await open(path, "wx");
  const hash = createHash("sha256");
  let sizeBytes = 0;
  const reader = object.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await file.write(value);
      hash.update(value);
      sizeBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
    await file.close();
  }
  if (sizeBytes !== object.totalSize) throw new Error(`对象长度不一致：${objectKey}`);
  return { sizeBytes, sha256: hash.digest("hex") };
}

async function uploadFile(blobs: BlobStore, objectKey: string, path: string, mimeType: string | null): Promise<void> {
  const uploadId = await blobs.createMultipart(objectKey, mimeType || "application/octet-stream");
  const file = await open(path, "r");
  const parts: Array<{ partNumber: number; etag: string; sizeBytes: number }> = [];
  try {
    const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
    for (let partNumber = 1;; partNumber += 1) {
      const { bytesRead } = await file.read(buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      const bytes = new Uint8Array(buffer.buffer, buffer.byteOffset, bytesRead);
      const etag = await blobs.putPart(objectKey, uploadId, partNumber, bytes);
      parts.push({ partNumber, etag, sizeBytes: bytesRead });
    }
    if (parts.length === 0) throw new Error(`不能恢复空对象：${objectKey}`);
    await blobs.completeMultipart(objectKey, uploadId, parts, mimeType || "application/octet-stream");
  } catch (error) {
    await blobs.abortMultipart(objectKey, uploadId).catch(() => undefined);
    throw error;
  } finally {
    await file.close();
  }
}

async function hashBlob(blobs: BlobStore, objectKey: string): Promise<{ sizeBytes: number; sha256: string } | null> {
  const object = await blobs.get(objectKey);
  if (!object) return null;
  const reader = object.body.getReader();
  const hash = createHash("sha256");
  let sizeBytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      hash.update(value);
      sizeBytes += value.byteLength;
    }
  } finally {
    reader.releaseLock();
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

export async function createPortableBackup(
  destinationArgument: string | undefined,
  prefix?: "SOURCE",
): Promise<{ destination: string; manifest: PortableManifest }> {
  const destination = resolve(destinationArgument || `./backups/storage-${Date.now()}`);
  await mkdir(destination, { recursive: false });
  const storage = await openStorage(prefix);
  try {
    const [items, shares] = await Promise.all([
      storage.metadata.listPortableItems(),
      storage.metadata.listPortableShares(),
    ]);
    const objects: PortableManifest["objects"] = [];
    const seen = new Set<string>();
    for (const item of items) {
      if (item.type !== "file" || !item.objectKey || seen.has(item.objectKey)) continue;
      seen.add(item.objectKey);
      const relativePath = `objects/${item.objectKey}`;
      const result = await saveBlob(storage.blobs, item.objectKey, safePath(destination, relativePath));
      objects.push({ objectKey: item.objectKey, path: relativePath, ...result });
    }
    const manifest: PortableManifest = {
      format: "drop-worker-portable-storage",
      version: 3,
      migrationId: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      schemaVersion: 5,
      secretFingerprint: secretFingerprint(secretValue(prefix)),
      items,
      shares: shares.map((share) => ({
        id: share.id,
        ownerId: share.ownerId,
        name: share.name,
        members: share.members.map((member) => ({
          itemId: member.itemId,
          position: member.position,
          addedAt: member.addedAt,
          removedAt: member.removedAt,
          removalReason: member.removalReason,
          downloadCount: member.downloadCount,
        })),
        tokenHash: share.tokenHash,
        accessMode: share.accessMode,
        codeHash: share.codeHash,
        codeEncrypted: share.codeEncrypted,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        revokedAt: share.revokedAt,
        accessCount: share.accessCount,
        downloadCount: share.downloadCount,
        lastAccessedAt: share.lastAccessedAt,
      })),
      objects,
    };
    await writeFile(resolve(destination, "manifest.json"), JSON.stringify(manifest, null, 2), {
      encoding: "utf8",
      flag: "wx",
    });
    return { destination, manifest };
  } finally {
    await storage.close();
  }
}

async function readManifest(source: string): Promise<PortableManifest> {
  return portableManifestSchema.parse(JSON.parse(await readFile(resolve(source, "manifest.json"), "utf8")));
}

async function readMigrationReport(source: string): Promise<MigrationReport | null> {
  try {
    return migrationReportSchema.parse(
      JSON.parse(await readFile(resolve(source, "migration-report.json"), "utf8")),
    );
  } catch {
    return null;
  }
}

async function writeMigrationReport(destination: string, report: MigrationReport): Promise<void> {
  await writeFile(
    resolve(destination, "migration-report.json"),
    JSON.stringify(report, null, 2),
    "utf8",
  );
}

export async function restorePortableBackup(
  sourceArgument: string,
  prefix?: "TARGET",
  revokeShares = false,
): Promise<void> {
  const source = resolve(sourceArgument);
  const manifest = await readManifest(source);
  for (const object of manifest.objects) {
    const result = await hashFile(safePath(source, object.path));
    if (result.sizeBytes !== object.sizeBytes || result.sha256 !== object.sha256) {
      throw new Error(`备份对象完整性校验失败：${object.objectKey}`);
    }
  }
  const targetSecret = secretValue(prefix);
  if (manifest.secretFingerprint !== secretFingerprint(targetSecret) && !revokeShares) {
    throw new Error("SESSION_SECRET 指纹不匹配；请提供原密钥或显式撤销全部分享");
  }
  const storage = await openStorage(prefix, true);
  try {
    const state = await storage.metadata.preparePortableImport(
      manifest.migrationId,
      Date.now(),
      await storage.blobs.isEmpty(),
    );
    if (state === "rejected") throw new Error("目标包含其他数据或不同迁移状态，恢复已拒绝");
    for (const item of manifest.items) await storage.metadata.importPortableItem(item as StoredItem);
    for (const object of manifest.objects) {
      const existing = await hashBlob(storage.blobs, object.objectKey);
      if (existing?.sizeBytes === object.sizeBytes && existing.sha256 === object.sha256) continue;
      if (existing) await storage.blobs.delete(object.objectKey);
      const item = manifest.items.find((candidate) => candidate.objectKey === object.objectKey);
      await uploadFile(storage.blobs, object.objectKey, safePath(source, object.path), item?.mimeType || null);
      const restored = await hashBlob(storage.blobs, object.objectKey);
      if (restored?.sizeBytes !== object.sizeBytes || restored.sha256 !== object.sha256) {
        throw new Error(`目标对象完整性校验失败：${object.objectKey}`);
      }
    }
    const now = Date.now();
    for (const share of manifest.shares) {
      // v2 备份中的单项分享在恢复时原地升级为单成员集合。
      const members = share.members || (share.itemId ? [{
        itemId: share.itemId,
        position: 0,
        addedAt: share.createdAt,
        removedAt: null,
        removalReason: null,
        downloadCount: share.downloadCount,
      }] : []);
      await storage.metadata.importPortableShare({
        id: share.id,
        ownerId: share.ownerId,
        name: share.name,
        tokenHash: share.tokenHash,
        accessMode: share.accessMode,
        codeHash: share.codeHash,
        codeEncrypted: share.codeEncrypted,
        createdAt: share.createdAt,
        expiresAt: share.expiresAt,
        revokedAt: revokeShares ? now : share.revokedAt,
        accessCount: share.accessCount,
        downloadCount: share.downloadCount,
        lastAccessedAt: share.lastAccessedAt,
        members: members.map((member) => ({ ...member, item: null })),
      });
    }
    const [restoredItems, restoredShares] = await Promise.all([
      storage.metadata.listPortableItems(),
      storage.metadata.listPortableShares(),
    ]);
    if (restoredItems.length !== manifest.items.length || restoredShares.length !== manifest.shares.length) {
      throw new Error("目标元数据计数与备份清单不一致");
    }
    await storage.metadata.finishPortableImport(manifest.migrationId, now);
  } finally {
    await storage.close();
  }
}

export async function migratePortableStorage(workDirectory?: string, revokeShares = false): Promise<string> {
  const destination = resolve(workDirectory || `./backups/migration-${Date.now()}`);
  let manifest: PortableManifest;
  let report: MigrationReport | null = null;
  try {
    manifest = await readManifest(destination);
    report = await readMigrationReport(destination);
  } catch {
    const source = await openStorage("SOURCE");
    const discardedUploads: MigrationReport["discardedUploads"] = [];
    try {
      const pending = await source.metadata.listPortablePendingUploads();
      for (const upload of pending) {
        let abortStatus: "aborted" | "failed" = "aborted";
        try {
          await source.blobs.abortMultipart(upload.objectKey, upload.providerUploadId);
        } catch {
          abortStatus = "failed";
        }
        await source.metadata.discardPortableUpload(upload.ownerId, upload.id);
        discardedUploads.push({ id: upload.id, objectKey: upload.objectKey, abortStatus });
      }
    } finally {
      await source.close();
    }
    ({ manifest } = await createPortableBackup(destination, "SOURCE"));
    const now = new Date().toISOString();
    report = {
      format: "drop-worker-storage-migration-report",
      version: 1,
      migrationId: manifest.migrationId,
      createdAt: now,
      updatedAt: now,
      status: "prepared",
      discardedUploads,
      failure: null,
    };
    await writeMigrationReport(destination, report);
  }
  const now = new Date().toISOString();
  report = report?.migrationId === manifest.migrationId
    ? report
    : {
        format: "drop-worker-storage-migration-report",
        version: 1,
        migrationId: manifest.migrationId,
        createdAt: now,
        updatedAt: now,
        status: "prepared",
        discardedUploads: [],
        failure: null,
      };
  try {
    if (manifest.secretFingerprint !== secretFingerprint(secretValue("SOURCE"))) {
      throw new Error("迁移工作目录与当前源 SESSION_SECRET 不匹配");
    }
    await restorePortableBackup(destination, "TARGET", revokeShares);
    report = { ...report, status: "completed", updatedAt: new Date().toISOString(), failure: null };
    await writeMigrationReport(destination, report);
  } catch (error) {
    report = {
      ...report,
      status: "failed",
      updatedAt: new Date().toISOString(),
      failure: error instanceof Error ? error.name : "UnknownError",
    };
    await writeMigrationReport(destination, report);
    throw error;
  }
  return destination;
}
