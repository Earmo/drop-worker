import { createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import {
  mkdir,
  open,
  readFile,
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
import type { BlobObject, BlobStore } from "../platform";
import { SqlMetadataStore, type SqlExecutor, type SqlValue } from "./sql-metadata";

class NodeSqliteExecutor implements SqlExecutor {
  constructor(private readonly database: DatabaseSync) {}

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
    await writeFile(`${destination}.meta.json`, JSON.stringify({ contentType }), "utf8");
    await rm(safeStoragePath(this.uploadsRoot, uploadId), { recursive: true, force: true });
  }

  async abortMultipart(_objectKey: string, uploadId: string): Promise<void> {
    await rm(safeStoragePath(this.uploadsRoot, uploadId), { recursive: true, force: true });
  }

  async get(objectKey: string): Promise<BlobObject | null> {
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
    const body = Readable.toWeb(createReadStream(path)) as ReadableStream<Uint8Array>;
    return { body, size: info.size, contentType };
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
