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
    // D1 batch 在 Cloudflare 侧作为一组语句执行，SQL 适配器只把平台结果转换成通用 changes 数值。
    const results = await this.database.batch(
      statements.map(({ sql, params = [] }) => this.database.prepare(sql).bind(...params)),
    );
    return results.map((result) => ({ changes: result.meta.changes ?? 0 }));
  }
}

export function createD1MetadataStore(database: D1Database): SqlMetadataStore {
  return new SqlMetadataStore(new D1Executor(database), false);
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
    // R2 multipart 的 uploadId 由数据库保存，断点续传时通过同一个 ID 恢复供应商会话。
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
    // R2 只需要 partNumber + ETag；分片大小由元数据层负责校验。
    void contentType;
    const upload = this.bucket.resumeMultipartUpload(objectKey, uploadId);
    await upload.complete(parts.map(({ partNumber, etag }) => ({ partNumber, etag })));
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    const upload = this.bucket.resumeMultipartUpload(objectKey, uploadId);
    try {
      await upload.abort();
    } catch (error) {
      // 404 表示供应商端已没有该 multipart，会话清理可视为已经完成，保持清理任务幂等。
      const status = (error as { status?: unknown }).status;
      const message = error instanceof Error ? error.message : String(error);
      if (status !== 404 && !/no such upload|not found/i.test(message)) throw error;
    }
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
