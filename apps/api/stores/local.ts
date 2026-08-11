import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  unlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { DatabaseSync } from "node:sqlite";
import type { UploadedPart } from "../../../packages/contracts";
import type { BlobObject, BlobRange, BlobStore } from "../platform";
import { SqlMetadataStore, type SqlExecutor, type SqlValue } from "./sql-metadata";

class NodeSqliteExecutor implements SqlExecutor {
  constructor(private readonly database: DatabaseSync) {}

  async tableExists(name: string): Promise<boolean> {
    const row = this.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(name);
    return Boolean(row);
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return this.database.prepare(sql).all(...params) as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    const row = this.database.prepare(sql).get(...params) as T | undefined;
    return row ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const result = this.database.prepare(sql).run(...params);
    return { changes: Number(result.changes) };
  }

  async batch(statements: Array<{ sql: string; params?: SqlValue[] }>): Promise<Array<{ changes: number }>> {
    // SQLite 适配器显式使用 IMMEDIATE 事务，保证配额预留和上传完成等写操作不会互相穿插。
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const results = statements.map(({ sql, params = [] }) => {
        const result = this.database.prepare(sql).run(...params);
        return { changes: Number(result.changes) };
      });
      this.database.exec("COMMIT");
      return results;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}

export function openLocalMetadataStore(databasePath: string): {
  store: SqlMetadataStore;
  close(): void;
} {
  const database = new DatabaseSync(databasePath);
  database.exec("PRAGMA journal_mode = WAL");
  database.exec("PRAGMA foreign_keys = ON");
  database.exec("PRAGMA busy_timeout = 5000");
  return {
    store: new SqlMetadataStore(new NodeSqliteExecutor(database)),
    close: () => database.close(),
  };
}

function safeStoragePath(root: string, key: string): string {
  // 对象键只允许简单路径字符，并拒绝 ..；这是本地文件系统替代 R2 时的路径穿越边界。
  if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes("..")) {
    throw new Error("无效的对象键");
  }
  return join(root, ...key.split("/"));
}

export class LocalBlobStore implements BlobStore {
  private readonly objectsRoot: string;
  private readonly uploadsRoot: string;

  constructor(private readonly dataRoot: string) {
    this.objectsRoot = join(dataRoot, "objects");
    this.uploadsRoot = join(dataRoot, "uploads");
  }

  async prepare(): Promise<void> {
    await Promise.all([
      mkdir(this.objectsRoot, { recursive: true }),
      mkdir(this.uploadsRoot, { recursive: true }),
    ]);
  }

  async healthCheck(): Promise<void> {
    await this.prepare();
  }

  async isEmpty(): Promise<boolean> {
    await this.prepare();
    return (await readdir(this.objectsRoot)).length === 0;
  }

  async createMultipart(objectKey: string, contentType: string): Promise<string> {
    void objectKey;
    void contentType;
    const uploadId = crypto.randomUUID();
    await mkdir(safeStoragePath(this.uploadsRoot, uploadId), { recursive: true });
    return uploadId;
  }

  async putPart(
    _objectKey: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const uploadDirectory = safeStoragePath(this.uploadsRoot, uploadId);
    await mkdir(uploadDirectory, { recursive: true });
    const partPath = join(uploadDirectory, `part-${partNumber}`);
    await writeFile(partPath, bytes);
    return createHash("sha256").update(bytes).digest("hex");
  }

  async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: UploadedPart[],
    contentType: string,
  ): Promise<void> {
    const destination = safeStoragePath(this.objectsRoot, objectKey);
    const temporary = `${destination}.partial`;
    // 先写 .partial 临时文件，再 rename 成最终对象；进程中断时不会暴露半个文件。
    await mkdir(dirname(destination), { recursive: true });
    const file = await open(temporary, "w");
    try {
      for (const part of [...parts].sort((a, b) => a.partNumber - b.partNumber)) {
        const partPath = join(safeStoragePath(this.uploadsRoot, uploadId), `part-${part.partNumber}`);
        const bytes = await readFile(partPath);
        await file.write(bytes);
      }
    } finally {
      await file.close();
    }
    await rename(temporary, destination);
    // 内容类型和对象一起保存，读取时即使元数据损坏也能回退到安全的二进制类型。
    await writeFile(`${destination}.meta.json`, JSON.stringify({ contentType }), "utf8");
    await rm(safeStoragePath(this.uploadsRoot, uploadId), { recursive: true, force: true });
  }

  async abortMultipart(_objectKey: string, uploadId: string): Promise<void> {
    await rm(safeStoragePath(this.uploadsRoot, uploadId), { recursive: true, force: true });
  }

  async get(objectKey: string, range?: BlobRange): Promise<BlobObject | null> {
    const path = safeStoragePath(this.objectsRoot, objectKey);
    let info;
    try {
      info = await stat(path);
    } catch {
      return null;
    }
    let contentType = "application/octet-stream";
    try {
      const metadata: unknown = JSON.parse(await readFile(`${path}.meta.json`, "utf8"));
      if (
        metadata &&
        typeof metadata === "object" &&
        "contentType" in metadata &&
        typeof metadata.contentType === "string"
      ) {
        contentType = metadata.contentType;
      }
    } catch {
      contentType = "application/octet-stream";
    }
    const offset = range?.offset ?? 0;
    const length = range?.length ?? info.size;
    if (offset < 0 || length <= 0 || offset + length > info.size) return null;
    const body = Readable.toWeb(createReadStream(path, {
      start: offset,
      end: offset + length - 1,
    })) as ReadableStream<Uint8Array>;
    return {
      body,
      size: length,
      totalSize: info.size,
      rangeOffset: offset,
      contentType,
    };
  }

  async size(objectKey: string): Promise<number | null> {
    try {
      return (await stat(safeStoragePath(this.objectsRoot, objectKey))).size;
    } catch {
      return null;
    }
  }

  async delete(objectKey: string): Promise<void> {
    const path = safeStoragePath(this.objectsRoot, objectKey);
    await Promise.all([
      unlink(path).catch(() => undefined),
      unlink(`${path}.meta.json`).catch(() => undefined),
    ]);
  }
}
