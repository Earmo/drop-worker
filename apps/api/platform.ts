import type {
  DropItem,
  ItemType,
  ListItemsResponse,
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

export type UploadRecord = UploadSession & {
  ownerId: string;
  objectKey: string;
  providerUploadId: string;
};

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
  ensureSchema(): Promise<void>;
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
  saveUploadPart(ownerId: string, id: string, part: UploadedPart): Promise<UploadRecord | null>;
  completeUpload(ownerId: string, id: string): Promise<StoredItem | null>;
  markUpload(ownerId: string, id: string, status: "cancelled" | "expired"): Promise<UploadRecord | null>;
  listExpiredUploads(now: number): Promise<UploadRecord[]>;
  listExpiredTrash(before: number): Promise<StoredItem[]>;
  listAllForExport(ownerId: string): Promise<DropItem[]>;
  deleteExpiredSessions(now: number): Promise<void>;
}

export type BlobObject = {
  body: ReadableStream<Uint8Array>;
  size: number;
  contentType: string;
  etag?: string;
};

export interface BlobStore {
  createMultipart(objectKey: string, contentType: string): Promise<string>;
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
  get(objectKey: string): Promise<BlobObject | null>;
  size(objectKey: string): Promise<number | null>;
  delete(objectKey: string): Promise<void>;
}

export type RuntimeServices = {
  metadata: MetadataStore;
  blobs: BlobStore;
  quotaBytes: number;
  resolveIdentity(request: Request): Promise<Identity | null>;
  authMode: "platform" | "password" | "smtp-otp" | "development";
  insecureHttp: boolean;
  handleAuthRequest?(request: Request): Promise<Response | null>;
};
