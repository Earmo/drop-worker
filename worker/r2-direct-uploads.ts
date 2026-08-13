import { AwsClient } from "aws4fetch";
import { DIRECT_UPLOAD_ID_PREFIX, type DirectUploadService } from "../apps/api/platform";
import type { UploadedPart } from "../packages/contracts";

type R2DirectUploadConfig = {
  accountId: string;
  bucketName: string;
  accessKeyId: string;
  secretAccessKey: string;
};

function encodedObjectPath(bucketName: string, objectKey: string): string {
  return [bucketName, ...objectKey.split("/")].map(encodeURIComponent).join("/");
}

function xmlValue(xml: string, tag: string): string {
  const match = new RegExp(`<${tag}>([^<]+)</${tag}>`).exec(xml);
  if (!match?.[1]) throw new Error(`R2 S3 响应缺少 ${tag}`);
  return match[1]
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'");
}

function multipartXml(parts: UploadedPart[]): string {
  const body = [...parts]
    .sort((left, right) => left.partNumber - right.partNumber)
    .map((part) => `<Part><PartNumber>${part.partNumber}</PartNumber><ETag>${part.etag
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")}</ETag></Part>`)
    .join("");
  return `<CompleteMultipartUpload>${body}</CompleteMultipartUpload>`;
}

export class R2DirectUploadService implements DirectUploadService {
  private readonly client: AwsClient;
  private readonly endpoint: string;

  constructor(private readonly config: R2DirectUploadConfig) {
    this.client = new AwsClient({
      service: "s3",
      region: "auto",
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
    });
    this.endpoint = `https://${config.accountId}.r2.cloudflarestorage.com`;
  }

  isManagedUpload(uploadId: string): boolean {
    return uploadId.startsWith(DIRECT_UPLOAD_ID_PREFIX);
  }

  private providerUploadId(uploadId: string): string {
    if (!this.isManagedUpload(uploadId)) throw new Error("上传会话不属于 R2 直传服务");
    return uploadId.slice(DIRECT_UPLOAD_ID_PREFIX.length);
  }

  private objectUrl(objectKey: string): URL {
    return new URL(`${this.endpoint}/${encodedObjectPath(this.config.bucketName, objectKey)}`);
  }

  private async fetch(request: Request): Promise<Response> {
    const response = await this.client.fetch(request);
    if (response.ok) return response;
    const detail = (await response.text()).slice(0, 1_024);
    throw new Error(`R2 S3 请求失败 (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  async createMultipart(objectKey: string, contentType: string): Promise<string> {
    const url = this.objectUrl(objectKey);
    url.searchParams.set("uploads", "");
    const response = await this.fetch(new Request(url, {
      method: "POST",
      headers: { "content-type": contentType },
    }));
    return `${DIRECT_UPLOAD_ID_PREFIX}${xmlValue(await response.text(), "UploadId")}`;
  }

  async createPartUploadUrl(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    const url = this.objectUrl(objectKey);
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", this.providerUploadId(uploadId));
    url.searchParams.set("X-Amz-Expires", String(expiresInSeconds));
    const signed = await this.client.sign(new Request(url, { method: "PUT" }), {
      aws: { signQuery: true },
    });
    return signed.url;
  }

  async putPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string> {
    const url = this.objectUrl(objectKey);
    url.searchParams.set("partNumber", String(partNumber));
    url.searchParams.set("uploadId", this.providerUploadId(uploadId));
    const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const response = await this.fetch(new Request(url, { method: "PUT", body }));
    const etag = response.headers.get("etag");
    if (!etag) throw new Error("R2 S3 未返回分片 ETag");
    return etag;
  }

  async completeMultipart(objectKey: string, uploadId: string, parts: UploadedPart[]): Promise<void> {
    const url = this.objectUrl(objectKey);
    url.searchParams.set("uploadId", this.providerUploadId(uploadId));
    const response = await this.fetch(new Request(url, {
      method: "POST",
      headers: { "content-type": "application/xml" },
      body: multipartXml(parts),
    }));
    const result = await response.text();
    if (/<Error(?:\s|>)/i.test(result)) throw new Error(`R2 S3 完成上传失败: ${result.slice(0, 1_024)}`);
  }

  async abortMultipart(objectKey: string, uploadId: string): Promise<void> {
    const url = this.objectUrl(objectKey);
    url.searchParams.set("uploadId", this.providerUploadId(uploadId));
    const response = await this.client.fetch(new Request(url, { method: "DELETE" }));
    if (!response.ok && response.status !== 404) {
      throw new Error(`R2 S3 中止上传失败 (${response.status})`);
    }
  }
}
