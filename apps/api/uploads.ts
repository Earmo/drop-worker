import type { UploadSessionResponse } from "../../packages/contracts";
import { DIRECT_UPLOAD_ID_PREFIX, type RuntimeServices, type UploadRecord } from "./platform";

function directUploadFor(services: RuntimeServices, upload: UploadRecord) {
  if (!upload.providerUploadId.startsWith(DIRECT_UPLOAD_ID_PREFIX)) return null;
  if (!services.directUploads?.isManagedUpload(upload.providerUploadId)) {
    throw new Error("R2 直传凭据未配置，无法继续已有上传任务");
  }
  return services.directUploads;
}

export function uploadMode(services: RuntimeServices, upload: UploadRecord): "direct" | "proxy" {
  return directUploadFor(services, upload) ? "direct" : "proxy";
}

export function uploadSessionResponse(
  services: RuntimeServices,
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

export async function abortUpload(services: RuntimeServices, upload: UploadRecord): Promise<void> {
  const direct = directUploadFor(services, upload);
  if (direct) {
    await direct.abortMultipart(upload.objectKey, upload.providerUploadId);
    return;
  }
  await services.blobs.abortMultipart(upload.objectKey, upload.providerUploadId);
}

export async function completeUploadStorage(
  services: RuntimeServices,
  upload: UploadRecord,
): Promise<void> {
  const direct = directUploadFor(services, upload);
  if (direct) {
    await direct.completeMultipart(upload.objectKey, upload.providerUploadId, upload.parts);
    return;
  }
  await services.blobs.completeMultipart(
    upload.objectKey,
    upload.providerUploadId,
    upload.parts,
    upload.mimeType,
  );
}
