import type { UploadSessionResponse } from "../../packages/contracts";
import {
  DIRECT_UPLOAD_ID_PREFIX,
  type BlobStore,
  type DirectUploadService,
  type AppContext,
  type UploadRecord,
  type UploadTransport,
} from "../platform";

/**
 * 统一上传传输 adapter。
 *
 * 新建会话时根据组合根是否提供直传能力选择供应商；恢复已有会话时仍根据
 * 持久化的 providerUploadId 识别模式，避免配置变化后把 R2 会话误当成本地代理会话。
 */
export class StorageUploadTransport implements UploadTransport {
  constructor(
    private readonly blobs: BlobStore,
    private readonly directUploads?: DirectUploadService,
  ) {}

  async createMultipart(
    objectKey: string,
    contentType: string,
    contentDisposition?: string,
  ): Promise<string> {
    return this.directUploads
      ? this.directUploads.createMultipart(objectKey, contentType, contentDisposition)
      : this.blobs.createMultipart(objectKey, contentType, contentDisposition);
  }

  mode(uploadId: string): "direct" | "proxy" {
    return this.directUploadFor(uploadId) ? "direct" : "proxy";
  }

  async createPartUploadUrl(
    upload: UploadRecord,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string> {
    const direct = this.directUploadFor(upload.providerUploadId);
    if (!direct) throw new Error("当前存储不支持直接上传");
    return direct.createPartUploadUrl(
      upload.objectKey,
      upload.providerUploadId,
      partNumber,
      expiresInSeconds,
    );
  }

  async putPart(upload: UploadRecord, partNumber: number, bytes: Uint8Array): Promise<string> {
    const direct = this.directUploadFor(upload.providerUploadId);
    return direct
      ? direct.putPart(upload.objectKey, upload.providerUploadId, partNumber, bytes)
      : this.blobs.putPart(upload.objectKey, upload.providerUploadId, partNumber, bytes);
  }

  async complete(upload: UploadRecord): Promise<void> {
    const direct = this.directUploadFor(upload.providerUploadId);
    if (direct) {
      await direct.completeMultipart(upload.objectKey, upload.providerUploadId, upload.parts);
      return;
    }
    await this.blobs.completeMultipart(
      upload.objectKey,
      upload.providerUploadId,
      upload.parts,
      upload.mimeType,
    );
  }

  async abort(upload: UploadRecord): Promise<void> {
    const direct = this.directUploadFor(upload.providerUploadId);
    if (direct) {
      await direct.abortMultipart(upload.objectKey, upload.providerUploadId);
      return;
    }
    await this.blobs.abortMultipart(upload.objectKey, upload.providerUploadId);
  }

  async abortUnpersisted(objectKey: string, providerUploadId: string): Promise<void> {
    const direct = this.directUploadFor(providerUploadId);
    if (direct) {
      await direct.abortMultipart(objectKey, providerUploadId);
      return;
    }
    await this.blobs.abortMultipart(objectKey, providerUploadId);
  }

  private directUploadFor(uploadId: string): DirectUploadService | null {
    if (!uploadId.startsWith(DIRECT_UPLOAD_ID_PREFIX)) return null;
    if (!this.directUploads?.isManagedUpload(uploadId)) {
      throw new Error("R2 直传凭据未配置，无法继续已有上传任务");
    }
    return this.directUploads;
  }
}

export function createUploadTransport(
  blobs: BlobStore,
  directUploads?: DirectUploadService,
): UploadTransport {
  return new StorageUploadTransport(blobs, directUploads);
}

export function uploadMode(services: AppContext, upload: UploadRecord): "direct" | "proxy" {
  return services.uploads.mode(upload.providerUploadId);
}

export function uploadSessionResponse(
  services: AppContext,
  upload: UploadRecord,
): UploadSessionResponse {
  if (!["uploading", "completed", "cancelled", "expired"].includes(upload.status)) {
    throw new Error("上传任务正处于清理状态");
  }
  return {
    id: upload.id,
    fileName: upload.fileName,
    mimeType: upload.mimeType,
    sizeBytes: upload.sizeBytes,
    fingerprint: upload.fingerprint,
    parts: upload.parts,
    status: upload.status as UploadSessionResponse["status"],
    createdAt: upload.createdAt,
    expiresAt: upload.expiresAt,
    uploadMode: uploadMode(services, upload),
  };
}

/**
 * 保留清理模块的高层调用名称，实际实现已经收敛到 UploadTransport seam。
 */
export function abortUpload(services: AppContext, upload: UploadRecord): Promise<void> {
  return services.uploads.abort(upload);
}

export function completeUploadStorage(
  services: AppContext,
  upload: UploadRecord,
): Promise<void> {
  return services.uploads.complete(upload);
}
