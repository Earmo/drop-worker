import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  UploadPartCommand,
  type ServerSideEncryption,
} from "@aws-sdk/client-s3";
import type { UploadedPart } from "../../../packages/contracts";
import type { BlobObject, BlobRange, BlobStore } from "../platform";

type S3StoreConfig = {
  bucket: string;
  prefix: string;
  serverSideEncryption?: ServerSideEncryption;
  kmsKeyId?: string;
};

function objectPrefix(value: string | undefined): string {
  const normalized = (value || "drop-worker").trim().replace(/^\/+|\/+$/g, "");
  if (!normalized || normalized.includes("..") || !/^[a-zA-Z0-9/_-]+$/.test(normalized)) {
    throw new Error("S3_PREFIX 无效");
  }
  return `${normalized}/`;
}

function safeObjectKey(prefix: string, key: string): string {
  if (!/^[a-zA-Z0-9/_-]+$/.test(key) || key.includes("..")) throw new Error("无效的对象键");
  return `${prefix}${key}`;
}

function encryptionConfig(): Pick<S3StoreConfig, "serverSideEncryption" | "kmsKeyId"> {
  const value = process.env.S3_SERVER_SIDE_ENCRYPTION?.trim();
  if (!value) return {};
  if (value === "AES256") return { serverSideEncryption: "AES256" };
  if (value === "aws:kms") {
    const kmsKeyId = process.env.S3_KMS_KEY_ID?.trim();
    if (!kmsKeyId) throw new Error("S3_SERVER_SIDE_ENCRYPTION=aws:kms 时必须配置 S3_KMS_KEY_ID");
    return { serverSideEncryption: "aws:kms", kmsKeyId };
  }
  throw new Error("S3_SERVER_SIDE_ENCRYPTION 只能是 AES256 或 aws:kms");
}

function s3Endpoint(): string | undefined {
  const value = process.env.S3_ENDPOINT?.trim();
  if (!value) return undefined;
  const endpoint = new URL(value);
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("S3_ENDPOINT 必须使用 HTTP 或 HTTPS");
  if (endpoint.protocol === "http:" && process.env.S3_ALLOW_INSECURE !== "true") {
    throw new Error("HTTP S3_ENDPOINT 必须显式设置 S3_ALLOW_INSECURE=true");
  }
  if (endpoint.protocol === "http:") {
    console.warn("警告：S3 兼容对象存储连接已显式允许明文传输。");
  }
  return endpoint.toString();
}

function staticCredentials() {
  const accessKeyId = process.env.S3_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY?.trim();
  if (!accessKeyId && !secretAccessKey) return undefined;
  if (!accessKeyId || !secretAccessKey) throw new Error("S3_ACCESS_KEY_ID 与 S3_SECRET_ACCESS_KEY 必须同时配置");
  return {
    accessKeyId,
    secretAccessKey,
    sessionToken: process.env.S3_SESSION_TOKEN?.trim() || undefined,
  };
}

export function createS3BlobStoreFromEnv(): S3BlobStore {
  const bucket = process.env.S3_BUCKET?.trim();
  const region = process.env.S3_REGION?.trim();
  if (!bucket) throw new Error("S3 模式缺少 S3_BUCKET");
  if (!region) throw new Error("S3 模式缺少 S3_REGION");
  const client = new S3Client({
    region,
    endpoint: s3Endpoint(),
    forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
    credentials: staticCredentials(),
  });
  return new S3BlobStore(client, {
    bucket,
    prefix: objectPrefix(process.env.S3_PREFIX),
    ...encryptionConfig(),
  });
}

export class S3BlobStore implements BlobStore {
  private healthyUntil = 0;

  constructor(
    private readonly client: S3Client,
    private readonly config: S3StoreConfig,
  ) {}

  private key(objectKey: string): string {
    return safeObjectKey(this.config.prefix, objectKey);
  }

  close(): void {
    this.client.destroy();
  }

  async healthCheck(): Promise<void> {
    if (this.healthyUntil > Date.now()) return;
    const objectKey = `health/${crypto.randomUUID().replaceAll("-", "")}`;
    let uploadId: string | null = null;
    try {
      uploadId = await this.createMultipart(objectKey, "application/octet-stream");
      const bytes = new Uint8Array([1]);
      const etag = await this.putPart(objectKey, uploadId, 1, bytes);
      await this.completeMultipart(objectKey, uploadId, [{ partNumber: 1, etag, sizeBytes: 1 }], "application/octet-stream");
      uploadId = null;
      if ((await this.size(objectKey)) !== 1) throw new Error("S3 健康检查读取失败");
      await this.delete(objectKey);
      this.healthyUntil = Date.now() + 60_000;
    } catch (error) {
      if (uploadId) await this.abortMultipart(objectKey, uploadId).catch(() => undefined);
      await this.delete(objectKey).catch(() => undefined);
      throw error;
    }
  }

  async isEmpty(): Promise<boolean> {
    const result = await this.client.send(new ListObjectsV2Command({
      Bucket: this.config.bucket,
      Prefix: this.config.prefix,
      MaxKeys: 1,
    }));
    return (result.KeyCount || 0) === 0;
  }

  async createMultipart(objectKey: string, contentType: string): Promise<string> {
    const result = await this.client.send(new CreateMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: this.key(objectKey),
      ContentType: contentType,
      ServerSideEncryption: this.config.serverSideEncryption,
      SSEKMSKeyId: this.config.kmsKeyId,
    }));
    if (!result.UploadId) throw new Error("S3 未返回 multipart upload ID");
    return result.UploadId;
  }

  async putPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const result = await this.client.send(new UploadPartCommand({
      Bucket: this.config.bucket,
      Key: this.key(objectKey),
      UploadId: uploadId,
      PartNumber: partNumber,
      Body: bytes,
      ContentLength: bytes.byteLength,
    }));
    if (!result.ETag) throw new Error("S3 未返回分片 ETag");
    return result.ETag;
  }

  async completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: UploadedPart[],
    contentType: string,
  ): Promise<void> {
    void contentType;
    await this.client.send(new CompleteMultipartUploadCommand({
      Bucket: this.config.bucket,
      Key: this.key(objectKey),
      UploadId: uploadId,
      MultipartUpload: {
        Parts: [...parts]
          .sort((left, right) => left.partNumber - right.partNumber)
          .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
      },
    }));
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    try {
      await this.client.send(new AbortMultipartUploadCommand({
        Bucket: this.config.bucket,
        Key: this.key(objectKey),
        UploadId: uploadId,
      }));
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      const name = error instanceof Error ? error.name : "";
      if (status !== 404 && name !== "NoSuchUpload") throw error;
    }
  }

  async get(objectKey: string, range?: BlobRange): Promise<BlobObject | null> {
    try {
      const result = await this.client.send(new GetObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(objectKey),
        Range: range ? `bytes=${range.offset}-${range.offset + range.length - 1}` : undefined,
      }));
      if (!result.Body) return null;
      const contentRange = result.ContentRange ? /bytes\s+(\d+)-(\d+)\/(\d+)/i.exec(result.ContentRange) : null;
      const totalSize = contentRange ? Number(contentRange[3]) : Number(result.ContentLength || 0);
      const rangeOffset = contentRange ? Number(contentRange[1]) : 0;
      const selectedSize = Number(result.ContentLength || (range?.length ?? totalSize));
      return {
        body: result.Body.transformToWebStream() as ReadableStream<Uint8Array>,
        size: selectedSize,
        totalSize,
        rangeOffset,
        contentType: result.ContentType || "application/octet-stream",
        etag: result.ETag,
      };
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error instanceof Error && error.name === "NoSuchKey")) return null;
      throw error;
    }
  }

  async size(objectKey: string): Promise<number | null> {
    try {
      const result = await this.client.send(new HeadObjectCommand({
        Bucket: this.config.bucket,
        Key: this.key(objectKey),
      }));
      return result.ContentLength ?? null;
    } catch (error) {
      const status = (error as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
      if (status === 404 || (error instanceof Error && error.name === "NotFound")) return null;
      throw error;
    }
  }

  async delete(objectKey: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({
      Bucket: this.config.bucket,
      Key: this.key(objectKey),
    }));
  }
}
