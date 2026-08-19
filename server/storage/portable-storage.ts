import { createHash } from "node:crypto";
import { mkdir, open, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { z } from "zod";
import { createExportBundle } from "../../api/items/export";
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

/**
 * 可移植备份与恢复的进度快照。
 *
 * 字节进度按清单中的对象大小计算；`reusedObjects` 表示备份复用了已校验的本地副本，
 * 或恢复时目标存储已经存在相同对象，因此调用方可以区分真实传输量与扫描量。
 */
export type PortableStorageProgress = {
  operation: "backup" | "restore";
  phase: "preparing" | "verifying" | "transferring" | "finalizing";
  completedObjects: number;
  totalObjects: number;
  completedBytes: number;
  totalBytes: number;
  reusedObjects: number;
  currentObjectKey: string | null;
};

/** 可选的长任务进度接收器；回调必须保持轻量且不能抛出异常。 */
export type PortableStorageOptions = {
  onProgress?(progress: PortableStorageProgress): void;
};

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

async function hashFile(
  path: string,
  onBytes?: (completedBytes: number) => void,
): Promise<{ sizeBytes: number; sha256: string }> {
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
      onBytes?.(sizeBytes);
    }
  } finally {
    await file.close();
  }
  return { sizeBytes, sha256: hash.digest("hex") };
}

function emitProgress(options: PortableStorageOptions, progress: PortableStorageProgress): void {
  options.onProgress?.(progress);
}

function isMissingFile(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

async function readOptionalManifest(path: string, tolerateInvalid = false): Promise<PortableManifest | null> {
  try {
    return portableManifestSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch (error) {
    if (isMissingFile(error) || tolerateInvalid) return null;
    throw error;
  }
}

async function writePartialManifest(destination: string, manifest: PortableManifest): Promise<void> {
  // 部分清单也使用两阶段替换，确保进程在写清单时退出仍至少保留一个可解析版本。
  const currentPath = resolve(destination, "manifest.partial.json");
  const nextPath = resolve(destination, "manifest.partial.next.json");
  const previousPath = resolve(destination, "manifest.partial.previous.json");
  await writeFile(nextPath, JSON.stringify(manifest, null, 2), "utf8");
  await rm(previousPath, { force: true });
  let movedCurrent = false;
  try {
    await rename(currentPath, previousPath);
    movedCurrent = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    await rename(nextPath, currentPath);
  } catch (error) {
    if (movedCurrent) await rename(previousPath, currentPath).catch(() => undefined);
    throw error;
  }
  await rm(previousPath, { force: true });
}

async function commitManifest(destination: string, manifest: PortableManifest): Promise<void> {
  const currentPath = resolve(destination, "manifest.json");
  const nextPath = resolve(destination, "manifest.next.json");
  const previousPath = resolve(destination, "manifest.previous.json");
  await writeFile(nextPath, JSON.stringify(manifest, null, 2), "utf8");
  await rm(previousPath, { force: true });
  let movedCurrent = false;
  try {
    await rename(currentPath, previousPath);
    movedCurrent = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    await rename(nextPath, currentPath);
  } catch (error) {
    if (movedCurrent) await rename(previousPath, currentPath).catch(() => undefined);
    throw error;
  }
  await rm(previousPath, { force: true });
  await Promise.all([
    "manifest.partial.json",
    "manifest.partial.next.json",
    "manifest.partial.previous.json",
  ].map((name) => rm(resolve(destination, name), { force: true })));
}

async function commitInventory(destination: string, inventory: ReturnType<typeof createExportBundle>): Promise<void> {
  const currentPath = resolve(destination, "inventory.json");
  const nextPath = resolve(destination, "inventory.next.json");
  const previousPath = resolve(destination, "inventory.previous.json");
  await writeFile(nextPath, JSON.stringify(inventory, null, 2), "utf8");
  await rm(previousPath, { force: true });
  let movedCurrent = false;
  try {
    await rename(currentPath, previousPath);
    movedCurrent = true;
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  try {
    await rename(nextPath, currentPath);
  } catch (error) {
    if (movedCurrent) await rename(previousPath, currentPath).catch(() => undefined);
    throw error;
  }
  await rm(previousPath, { force: true });
}

async function reusableObject(
  destination: string,
  candidate: PortableManifest["objects"][number] | undefined,
  expectedSize: number,
  onBytes?: (completedBytes: number) => void,
): Promise<PortableManifest["objects"][number] | null> {
  if (!candidate || candidate.sizeBytes !== expectedSize) return null;
  try {
    const result = await hashFile(safePath(destination, candidate.path), onBytes);
    return result.sizeBytes === candidate.sizeBytes && result.sha256 === candidate.sha256
      ? candidate
      : null;
  } catch (error) {
    if (isMissingFile(error)) return null;
    throw error;
  }
}

async function saveBlob(
  blobs: BlobStore,
  objectKey: string,
  path: string,
  onBytes?: (completedBytes: number) => void,
): Promise<{ sizeBytes: number; sha256: string }> {
  const totalSize = await blobs.size(objectKey);
  if (totalSize === null) throw new Error(`已完成文件缺失：${objectKey}`);
  await mkdir(dirname(path), { recursive: true });
  const temporary = `${path}.partial`;
  let resumedSize = 0;
  try {
    resumedSize = (await stat(temporary)).size;
    if (resumedSize > totalSize) {
      await rm(temporary, { force: true });
      resumedSize = 0;
    }
  } catch (error) {
    if (!isMissingFile(error)) throw error;
  }
  const hash = createHash("sha256");
  if (resumedSize > 0) {
    const partial = await open(temporary, "r");
    let hashedBytes = 0;
    try {
      const buffer = Buffer.allocUnsafe(8 * 1024 * 1024);
      for (;;) {
        const { bytesRead } = await partial.read(buffer, 0, buffer.length, null);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(0, bytesRead));
        hashedBytes += bytesRead;
        onBytes?.(hashedBytes);
      }
    } finally {
      await partial.close();
    }
  }
  onBytes?.(resumedSize);
  const object = resumedSize < totalSize
    ? await blobs.get(objectKey, { offset: resumedSize, length: totalSize - resumedSize })
    : null;
  if (resumedSize < totalSize && !object) throw new Error(`无法续传对象：${objectKey}`);
  const file = await open(temporary, resumedSize > 0 ? "a" : "w");
  let sizeBytes = resumedSize;
  const reader = object?.body.getReader();
  try {
    if (reader) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        await file.write(value);
        hash.update(value);
        sizeBytes += value.byteLength;
        onBytes?.(sizeBytes);
      }
    }
  } finally {
    reader?.releaseLock();
    await file.close();
  }
  if (sizeBytes !== totalSize) {
    throw new Error(`对象长度不一致：${objectKey}`);
  }
  // 新副本完整落盘并算出摘要后才替换旧副本，续跑时不会误用半个文件。
  await rm(path, { force: true });
  await rename(temporary, path);
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
  options: PortableStorageOptions = {},
): Promise<{ destination: string; manifest: PortableManifest }> {
  const destination = resolve(destinationArgument || `./backups/storage-${Date.now()}`);
  await mkdir(destination, { recursive: true });
  const previousManifest = await readOptionalManifest(resolve(destination, "manifest.json"));
  const partialManifest = await readOptionalManifest(resolve(destination, "manifest.partial.json"), true)
    || await readOptionalManifest(resolve(destination, "manifest.partial.next.json"), true)
    || await readOptionalManifest(resolve(destination, "manifest.partial.previous.json"), true);
  if (!previousManifest && !partialManifest && (await readdir(destination)).length > 0) {
    throw new Error("备份目录非空且不包含有效清单，已拒绝写入");
  }
  const storage = await openStorage(prefix);
  try {
    const [items, shares] = await Promise.all([
      storage.metadata.listPortableItems(),
      storage.metadata.listPortableShares(),
    ]);
    const currentSecretFingerprint = secretFingerprint(secretValue(prefix));
    if (partialManifest && partialManifest.secretFingerprint !== currentSecretFingerprint) {
      throw new Error("未完成备份来自不同的 SESSION_SECRET，不能在同一目录续跑");
    }
    if (previousManifest && previousManifest.secretFingerprint !== currentSecretFingerprint) {
      throw new Error("现有备份来自不同的 SESSION_SECRET，不能在同一目录增量更新");
    }
    const fileItems = items.filter(
      (item): item is StoredItem & { objectKey: string } => item.type === "file" && Boolean(item.objectKey),
    );
    const uniqueFileItems = [...new Map(fileItems.map((item) => [item.objectKey, item])).values()];
    const totalBytes = uniqueFileItems.reduce((sum, item) => sum + item.sizeBytes, 0);
    const baseProgress: PortableStorageProgress = {
      operation: "backup",
      phase: "preparing",
      completedObjects: 0,
      totalObjects: uniqueFileItems.length,
      completedBytes: 0,
      totalBytes,
      reusedObjects: 0,
      currentObjectKey: null,
    };
    emitProgress(options, baseProgress);
    const objects: PortableManifest["objects"] = [];
    const partialByKey = new Map(partialManifest?.objects.map((object) => [object.objectKey, object]));
    const previousByKey = new Map(previousManifest?.objects.map((object) => [object.objectKey, object]));
    let completedBytes = 0;
    let reusedObjects = 0;
    const manifestBase: Omit<PortableManifest, "objects"> = {
      format: "drop-worker-portable-storage",
      version: 3,
      migrationId: partialManifest?.migrationId || crypto.randomUUID(),
      createdAt: partialManifest?.createdAt || new Date().toISOString(),
      schemaVersion: 5,
      secretFingerprint: currentSecretFingerprint,
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
    };
    // 在传输第一个对象前落下快照身份；即使首个大文件中途失败，也能安全识别续跑目录。
    await writePartialManifest(destination, { ...manifestBase, objects });
    for (const item of uniqueFileItems) {
      emitProgress(options, {
        ...baseProgress,
        phase: "verifying",
        completedObjects: objects.length,
        completedBytes,
        reusedObjects,
        currentObjectKey: item.objectKey,
      });
      const relativePath = `objects/${item.objectKey}`;
      const resumed = await reusableObject(
        destination,
        partialByKey.get(item.objectKey) || previousByKey.get(item.objectKey),
        item.sizeBytes,
        (objectBytes) => emitProgress(options, {
          ...baseProgress,
          phase: "verifying",
          completedObjects: objects.length,
          completedBytes: completedBytes + objectBytes,
          reusedObjects,
          currentObjectKey: item.objectKey,
        }),
      );
      let object: PortableManifest["objects"][number];
      if (resumed) {
        object = resumed;
        reusedObjects += 1;
        await rm(`${safePath(destination, resumed.path)}.partial`, { force: true });
      } else {
        emitProgress(options, {
          ...baseProgress,
          phase: "transferring",
          completedObjects: objects.length,
          completedBytes,
          reusedObjects,
          currentObjectKey: item.objectKey,
        });
        const result = await saveBlob(
          storage.blobs,
          item.objectKey,
          safePath(destination, relativePath),
          (objectBytes) => emitProgress(options, {
            ...baseProgress,
            phase: "transferring",
            completedObjects: objects.length,
            completedBytes: completedBytes + objectBytes,
            reusedObjects,
            currentObjectKey: item.objectKey,
          }),
        );
        if (result.sizeBytes !== item.sizeBytes) throw new Error(`条目与对象长度不一致：${item.objectKey}`);
        object = { objectKey: item.objectKey, path: relativePath, ...result };
      }
      objects.push(object);
      completedBytes += object.sizeBytes;
      // 每个完整对象都立即进入部分清单；任务被终止后，同一目录可以从下一个对象继续。
      await writePartialManifest(destination, { ...manifestBase, objects });
      emitProgress(options, {
        ...baseProgress,
        phase: "transferring",
        completedObjects: objects.length,
        completedBytes,
        reusedObjects,
        currentObjectKey: item.objectKey,
      });
    }
    const manifest: PortableManifest = { ...manifestBase, objects };
    emitProgress(options, {
      ...baseProgress,
      phase: "finalizing",
      completedObjects: objects.length,
      completedBytes,
      reusedObjects,
      currentObjectKey: null,
    });
    await commitManifest(destination, manifest);
    // inventory 是仅供审阅的公开字段视图；恢复始终以包含内部字段的 manifest 为准。
    await commitInventory(destination, createExportBundle(items, shares, Date.now()));
    const currentPaths = new Set(objects.map((object) => object.path));
    const staleObjects = previousManifest?.objects.filter((object) => !currentPaths.has(object.path)) || [];
    for (const stale of staleObjects) await rm(safePath(destination, stale.path), { force: true });
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
  options: PortableStorageOptions = {},
): Promise<void> {
  const source = resolve(sourceArgument);
  const manifest = await readManifest(source);
  const totalBytes = manifest.objects.reduce((sum, object) => sum + object.sizeBytes, 0);
  const baseProgress: PortableStorageProgress = {
    operation: "restore",
    phase: "preparing",
    completedObjects: 0,
    totalObjects: manifest.objects.length,
    completedBytes: 0,
    totalBytes,
    reusedObjects: 0,
    currentObjectKey: null,
  };
  emitProgress(options, baseProgress);
  let verifiedBytes = 0;
  for (const [index, object] of manifest.objects.entries()) {
    emitProgress(options, {
      ...baseProgress,
      phase: "verifying",
      completedObjects: index,
      completedBytes: verifiedBytes,
      currentObjectKey: object.objectKey,
    });
    const result = await hashFile(
      safePath(source, object.path),
      (objectBytes) => emitProgress(options, {
        ...baseProgress,
        phase: "verifying",
        completedObjects: index,
        completedBytes: verifiedBytes + objectBytes,
        currentObjectKey: object.objectKey,
      }),
    );
    if (result.sizeBytes !== object.sizeBytes || result.sha256 !== object.sha256) {
      throw new Error(`备份对象完整性校验失败：${object.objectKey}`);
    }
    verifiedBytes += object.sizeBytes;
    emitProgress(options, {
      ...baseProgress,
      phase: "verifying",
      completedObjects: index + 1,
      completedBytes: verifiedBytes,
      currentObjectKey: object.objectKey,
    });
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
    let completedBytes = 0;
    let reusedObjects = 0;
    for (const [index, object] of manifest.objects.entries()) {
      emitProgress(options, {
        ...baseProgress,
        phase: "transferring",
        completedObjects: index,
        completedBytes,
        reusedObjects,
        currentObjectKey: object.objectKey,
      });
      const existing = await hashBlob(storage.blobs, object.objectKey);
      if (existing?.sizeBytes === object.sizeBytes && existing.sha256 === object.sha256) {
        reusedObjects += 1;
      } else {
        if (existing) await storage.blobs.delete(object.objectKey);
        const item = manifest.items.find((candidate) => candidate.objectKey === object.objectKey);
        await uploadFile(storage.blobs, object.objectKey, safePath(source, object.path), item?.mimeType || null);
        const restored = await hashBlob(storage.blobs, object.objectKey);
        if (restored?.sizeBytes !== object.sizeBytes || restored.sha256 !== object.sha256) {
          throw new Error(`目标对象完整性校验失败：${object.objectKey}`);
        }
      }
      completedBytes += object.sizeBytes;
      emitProgress(options, {
        ...baseProgress,
        phase: "transferring",
        completedObjects: index + 1,
        completedBytes,
        reusedObjects,
        currentObjectKey: object.objectKey,
      });
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
    emitProgress(options, {
      ...baseProgress,
      phase: "finalizing",
      completedObjects: manifest.objects.length,
      completedBytes: totalBytes,
      reusedObjects,
      currentObjectKey: null,
    });
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
