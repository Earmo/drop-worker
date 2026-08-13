import type {
  DropItem,
  ItemType,
  ListItemsResponse,
  ShareAccessMode,
  StorageSummary,
  UploadedPart,
  UploadSession,
} from "../../packages/contracts";

export type Identity = {
  ownerId: string;
  email: string;
};

export type StoredItem = DropItem & {
  ownerId: string;
  objectKey: string | null;
};

// 这两个中间状态代表已领取外部清理租约，但对象存储删除尚未完成。
export type UploadCleanupStatus = "cancelling" | "expiring";
export const DIRECT_UPLOAD_ID_PREFIX = "r2-s3:";

export type UploadRecord = Omit<UploadSession, "status"> & {
  status: UploadSession["status"] | UploadCleanupStatus;
  ownerId: string;
  objectKey: string;
  providerUploadId: string;
};

export type StoredShare = {
  id: string;
  ownerId: string;
  itemId: string;
  tokenHash: string;
  accessMode: ShareAccessMode;
  codeHash: string | null;
  codeEncrypted: string | null;
  createdAt: number;
  expiresAt: number;
  revokedAt: number | null;
  accessCount: number;
  downloadCount: number;
  lastAccessedAt: number | null;
  item: StoredItem;
};

export type ShareAttemptRecord = {
  shareId: string;
  sourceHash: string;
  failures: number;
  lockedUntil: number;
  updatedAt: number;
};

export type AuthSessionRecord = {
  ownerId: string;
  email: string;
  expiresAt: number;
};

export type AuthChallengeRecord = {
  id: string;
  email: string;
  codeHash: string;
  attempts: number;
  createdAt: number;
  expiresAt: number;
};

// 列表筛选统一由存储层实现；cursor 是 offset，limit 的上限由 contracts schema 限制。
export type ListOptions = {
  type?: ItemType;
  query?: string;
  favorites?: boolean;
  trash: boolean;
  sort: "latest" | "oldest" | "largest";
  cursor: number;
  limit: number;
};

export interface MetadataStore {
  healthCheck(): Promise<void>;
  ensureSchema(): Promise<void>;
  ensureApplicationReady(): Promise<void>;
  listItems(ownerId: string, options: ListOptions): Promise<ListItemsResponse>;
  getItem(ownerId: string, id: string): Promise<StoredItem | null>;
  createItem(input: {
    ownerId: string;
    type: ItemType;
    content?: string | null;
    title?: string | null;
    objectKey?: string | null;
    originalName?: string | null;
    displayName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number;
  }): Promise<StoredItem>;
  updateItem(
    ownerId: string,
    id: string,
    changes: {
      content?: string;
      title?: string;
      displayName?: string;
      favorite?: boolean;
    },
  ): Promise<StoredItem | null>;
  setDeleted(ownerId: string, ids: string[], deletedAt: number | null): Promise<number>;
  beginPurge(ownerId: string, id: string): Promise<StoredItem | null>;
  permanentlyDelete(ownerId: string, id: string): Promise<StoredItem | null>;
  storageSummary(ownerId: string, quotaBytes: number): Promise<StorageSummary>;
  createUpload(input: {
    ownerId: string;
    objectKey: string;
    providerUploadId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    fingerprint: string;
    now: number;
    expiresAt: number;
  }, quotaBytes: number): Promise<UploadRecord | null>;
  getUpload(ownerId: string, id: string): Promise<UploadRecord | null>;
  saveUploadParts(ownerId: string, id: string, parts: UploadedPart[]): Promise<UploadRecord | null>;
  completeUpload(ownerId: string, id: string): Promise<StoredItem | null>;
  beginUploadCleanup(ownerId: string, id: string, finalStatus: "cancelled" | "expired"): Promise<UploadRecord | null>;
  finishUploadCleanup(ownerId: string, id: string, finalStatus: "cancelled" | "expired"): Promise<UploadRecord | null>;
  listExpiredUploads(now: number): Promise<UploadRecord[]>;
  listExpiredTrash(before: number): Promise<StoredItem[]>;
  listAllForExport(ownerId: string): Promise<DropItem[]>;
  createShare(input: {
    id: string;
    ownerId: string;
    itemId: string;
    tokenHash: string;
    accessMode: ShareAccessMode;
    codeHash: string | null;
    codeEncrypted?: string | null;
    now: number;
    expiresAt: number;
  }): Promise<StoredShare | null>;
  listShares(ownerId: string, now: number, historyAfter: number): Promise<StoredShare[]>;
  getShareByTokenHash(tokenHash: string): Promise<StoredShare | null>;
  revokeShare(ownerId: string, id: string, now: number): Promise<StoredShare | null>;
  recordShareAccess(id: string, now: number, download: boolean): Promise<void>;
  getShareAttempt(shareId: string, sourceHash: string): Promise<ShareAttemptRecord | null>;
  recordShareFailure(shareId: string, sourceHash: string, now: number): Promise<ShareAttemptRecord>;
  saveShareAttempt(record: ShareAttemptRecord): Promise<void>;
  deleteShareAttempt(shareId: string, sourceHash: string): Promise<void>;
  deleteExpiredShares(before: number, attemptsBefore: number): Promise<void>;
  getAuthSession(tokenHash: string, now: number): Promise<AuthSessionRecord | null>;
  createAuthSession(input: {
    id: string;
    tokenHash: string;
    ownerId: string;
    email: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void>;
  deleteAuthSession(tokenHash: string): Promise<void>;
  createAuthChallenge(input: AuthChallengeRecord): Promise<void>;
  getAuthChallenge(id: string, email: string): Promise<AuthChallengeRecord | null>;
  incrementAuthChallengeAttempts(id: string): Promise<void>;
  deleteAuthChallenge(id: string): Promise<void>;
  isPortableTargetEmpty(): Promise<boolean>;
  listPortableItems(): Promise<StoredItem[]>;
  listPortableShares(): Promise<StoredShare[]>;
  listPortablePendingUploads(): Promise<UploadRecord[]>;
  discardPortableUpload(ownerId: string, id: string): Promise<void>;
  importPortableItem(item: StoredItem): Promise<void>;
  importPortableShare(share: Omit<StoredShare, "item">): Promise<void>;
  preparePortableImport(migrationId: string, now: number, blobsEmpty: boolean): Promise<"new" | "resume" | "rejected">;
  finishPortableImport(migrationId: string, now: number): Promise<void>;
  deleteExpiredSessions(now: number): Promise<void>;
}

export type BlobObject = {
  body: ReadableStream<Uint8Array>;
  size: number;
  totalSize: number;
  rangeOffset: number;
  contentType: string;
  etag?: string;
};

export type BlobRange = {
  offset: number;
  length: number;
};

export interface BlobStore {
  healthCheck(): Promise<void>;
  isEmpty(): Promise<boolean>;
  createMultipart(objectKey: string, contentType: string, contentDisposition?: string): Promise<string>;
  putPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string>;
  completeMultipart(
    objectKey: string,
    uploadId: string,
    parts: UploadedPart[],
    contentType: string,
  ): Promise<void>;
  abortMultipart(objectKey: string, uploadId: string): Promise<void>;
  get(objectKey: string, range?: BlobRange): Promise<BlobObject | null>;
  size(objectKey: string): Promise<number | null>;
  delete(objectKey: string): Promise<void>;
}

export interface DirectUploadService {
  isManagedUpload(uploadId: string): boolean;
  createMultipart(objectKey: string, contentType: string, contentDisposition?: string): Promise<string>;
  createPartUploadUrl(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    expiresInSeconds: number,
  ): Promise<string>;
  putPart(
    objectKey: string,
    uploadId: string,
    partNumber: number,
    bytes: Uint8Array,
  ): Promise<string>;
  completeMultipart(objectKey: string, uploadId: string, parts: UploadedPart[]): Promise<void>;
  abortMultipart(objectKey: string, uploadId: string): Promise<void>;
}

export type RuntimeServices = {
  metadata: MetadataStore;
  blobs: BlobStore;
  directUploads?: DirectUploadService;
  publicFilesUrl?: URL;
  quotaBytes: number;
  resolveIdentity(request: Request): Promise<Identity | null>;
  authMode: "platform" | "password" | "smtp-otp" | "development";
  insecureHttp: boolean;
  sharing: {
    enabled: boolean;
    publicUrl: URL;
    secret: string;
    resolveClientAddress(request: Request): string;
  };
  handleAuthRequest?(request: Request): Promise<Response | null>;
};
