import type { UploadedPart } from "../../../packages/contracts";
import type { BlobObject, BlobStore } from "../platform";
import { SqlMetadataStore, type SqlExecutor, type SqlValue } from "./sql-metadata";

class D1Executor implements SqlExecutor {
  constructor(private readonly database: D1Database) {}

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const result = await this.database.prepare(sql).bind(...params).all<T>();
    return result.results;
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return this.database.prepare(sql).bind(...params).first<T>();
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const result = await this.database.prepare(sql).bind(...params).run();
    return { changes: result.meta.changes ?? 0 };
  }

  async batch(statements: Array<{ sql: string; params?: SqlValue[] }>): Promise<Array<{ changes: number }>> {
    const results = await this.database.batch(
      statements.map(({ sql, params = [] }) => this.database.prepare(sql).bind(...params)),
    );
    return results.map((result) => ({ changes: result.meta.changes ?? 0 }));
  }
}

export function createD1MetadataStore(database: D1Database): SqlMetadataStore {
  return new SqlMetadataStore(new D1Executor(database));
}

export class R2BlobStore implements BlobStore {
  constructor(private readonly bucket: R2Bucket) {}

  async createMultipart(objectKey: string, contentType: string): Promise<string> {
    const upload = await this.bucket.createMultipartUpload(objectKey, {
      httpMetadata: { contentType },
    });
    return upload.uploadId;
  }

  async putPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const upload = this.bucket.resumeMultipartUpload(objectKey, uploadId);
    const part = await upload.uploadPart(partNumber, bytes);
    return part.etag;
  }

  async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: UploadedPart[],
    contentType: string,
  ): Promise<void> {
    void contentType;
    const upload = this.bucket.resumeMultipartUpload(objectKey, uploadId);
    await upload.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(objectKey, uploadId);
    await upload.abort();
  }

  async get(objectKey: string): Promise<BlobObject | null> {
    const object = await this.bucket.get(objectKey);
    if (!object) return null;
    return {
      body: object.body,
      size: object.size,
      contentType: object.httpMetadata?.contentType ?? "application/octet-stream",
      etag: object.httpEtag,
    };
  }

  async size(objectKey: string): Promise<number | null> {
    const object = await this.bucket.head(objectKey);
    return object?.size ?? null;
  }

  async delete(objectKey: string): Promise<void> {
    await this.bucket.delete(objectKey);
  }
}
