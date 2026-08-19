import { z } from "zod";

export const UPLOAD_PART_SIZE = 16 * 1024 * 1024;
export const UPLOAD_CONCURRENCY = 4;

export const itemTypeSchema = z.enum(["text", "link", "file"]);
export type ItemType = z.infer<typeof itemTypeSchema>;

// DropItem 是前后端共享的公开元数据；ownerId/objectKey 等内部字段不会越过 API 边界。
export const dropItemSchema = z.object({
  id: z.string().uuid(),
  type: itemTypeSchema,
  content: z.string().nullable(),
  title: z.string().nullable(),
  originalName: z.string().nullable(),
  displayName: z.string().nullable(),
  mimeType: z.string().nullable(),
  sizeBytes: z.number().int().nonnegative(),
  favorite: z.boolean(),
  createdAt: z.number().int(),
  updatedAt: z.number().int(),
  deletedAt: z.number().int().nullable(),
});
export type DropItem = z.infer<typeof dropItemSchema>;

export const createTextSchema = z.object({
  content: z.string().trim().min(1).max(65_536),
});

export const createLinkSchema = z.object({
  url: z.string().url().max(4_096),
  title: z.string().trim().max(240).optional(),
});

export const updateItemSchema = z
  .object({
    content: z.string().trim().min(1).max(65_536).optional(),
    title: z.string().trim().max(240).optional(),
    displayName: z.string().trim().min(1).max(255).optional(),
    favorite: z.boolean().optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "至少提供一个变更字段");

export const listItemsQuerySchema = z.object({
  // 列表查询限制最大页大小，避免搜索或回收站清理一次返回过多内容。
  type: itemTypeSchema.optional(),
  q: z.string().trim().max(200).optional(),
  favorites: z.enum(["true", "false"]).optional(),
  trash: z.enum(["true", "false"]).default("false"),
  sort: z.enum(["latest", "oldest", "largest"]).default("latest"),
  cursor: z.coerce.number().int().nonnegative().default(0),
  limit: z.coerce.number().int().min(1).max(100).default(40),
});

// 批量操作是公开 API 契约的一部分；限制 ID 数量，避免一次请求放大副作用。
export const bulkActionSchema = z.object({
  ids: z.array(z.string().uuid()).min(1).max(200),
  action: z.enum(["trash", "restore", "purge"]),
});

export const uploadCreateSchema = z.object({
  // 创建上传时只接受文件元数据；文件正文随后按 16 MiB 分片发送。
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255).default("application/octet-stream"),
  sizeBytes: z.number().int().positive().max(500 * 1024 * 1024),
  fingerprint: z.string().trim().min(8).max(256),
});

export const uploadedPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  etag: z.string().min(1).max(256),
  sizeBytes: z.number().int().positive(),
});
export type UploadedPart = z.infer<typeof uploadedPartSchema>;

export const uploadPartUrlsSchema = z.object({
  partNumbers: z.array(z.number().int().min(1).max(10_000)).min(1).max(UPLOAD_CONCURRENCY),
});

export const uploadPartsConfirmSchema = z.object({
  parts: z.array(z.object({
    partNumber: z.number().int().min(1).max(10_000),
    etag: z.string().trim().min(1).max(256).regex(/^[\x20-\x7e]+$/),
  })).min(1).max(UPLOAD_CONCURRENCY),
});

export const uploadSessionSchema = z.object({
  // 客户端把该会话持久化到 localStorage，用 fingerprint 将本地文件与服务端任务绑定。
  id: z.string().uuid(),
  fileName: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().positive(),
  fingerprint: z.string(),
  parts: z.array(uploadedPartSchema),
  status: z.enum(["uploading", "completed", "cancelled", "expired"]),
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
});
export type UploadSession = z.infer<typeof uploadSessionSchema>;

export type UploadSessionResponse = UploadSession & {
  uploadMode: "direct" | "proxy";
};

export type UploadPartUrl = {
  partNumber: number;
  url: string;
  expiresAt: number;
};

export const storageSummarySchema = z.object({
  usedBytes: z.number().int().nonnegative(),
  reservedBytes: z.number().int().nonnegative(),
  quotaBytes: z.number().int().positive(),
  warningThreshold: z.number().min(0).max(1),
  byType: z.object({
    text: z.number().int().nonnegative(),
    link: z.number().int().nonnegative(),
    file: z.number().int().nonnegative(),
    trash: z.number().int().nonnegative(),
  }),
  itemCounts: z.object({
    text: z.number().int().nonnegative(),
    link: z.number().int().nonnegative(),
    file: z.number().int().nonnegative(),
    trash: z.number().int().nonnegative(),
  }),
  largestFile: z.object({
    id: z.string().uuid(),
    displayName: z.string(),
    sizeBytes: z.number().int().nonnegative(),
  }).nullable(),
  oldestItem: z.object({
    id: z.string().uuid(),
    type: itemTypeSchema,
    displayName: z.string(),
    createdAt: z.number().int(),
  }).nullable(),
});
export type StorageSummary = z.infer<typeof storageSummarySchema>;

export const authStatusSchema = z.object({
  authenticated: z.boolean(),
  mode: z.enum(["password", "smtp-otp", "development"]),
  email: z.string().email().nullable(),
  insecureHttp: z.boolean(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

export const shareAccessModeSchema = z.enum(["public", "code"]);
export type ShareAccessMode = z.infer<typeof shareAccessModeSchema>;
export const SHARE_MAX_ITEMS = 50;

export const shareStatusSchema = z.enum(["active", "expired", "revoked"]);
export type ShareStatus = z.infer<typeof shareStatusSchema>;

export const shareExpirySecondsSchema = z.union([
  z.literal(60 * 60),
  z.literal(24 * 60 * 60),
  z.literal(7 * 24 * 60 * 60),
  z.literal(30 * 24 * 60 * 60),
]);
export type ShareExpirySeconds = z.infer<typeof shareExpirySecondsSchema>;

const shareSettingsFields = {
  name: z.string().trim().min(1).max(120).nullable().optional(),
  accessMode: shareAccessModeSchema,
  expiresInSeconds: shareExpirySecondsSchema.default(7 * 24 * 60 * 60),
  code: z.string().regex(/^\d{4}$/).optional(),
};

export const createShareSchema = z
  .object({
    ...shareSettingsFields,
    itemIds: z.array(z.string().uuid()).min(1).max(SHARE_MAX_ITEMS),
  })
  .superRefine((value, context) => {
    if (value.accessMode === "public" && value.code !== undefined) {
      context.addIssue({ code: "custom", message: "公开分享不能设置口令", path: ["code"] });
    }
  });
export type CreateShareInput = z.infer<typeof createShareSchema>;

export const updateShareSchema = z
  .object({
    name: z.string().trim().min(1).max(120).nullable().optional(),
    itemIds: z.array(z.string().uuid()).max(SHARE_MAX_ITEMS).optional(),
  })
  .refine((value) => Object.keys(value).length > 0, "至少提供一个变更字段");
export type UpdateShareInput = z.infer<typeof updateShareSchema>;

export const shareMemberSummarySchema = z.object({
  itemId: z.string().uuid(),
  itemType: z.enum(["text", "file"]),
  itemLabel: z.string(),
  position: z.number().int().nonnegative(),
  addedAt: z.number().int(),
  downloadCount: z.number().int().nonnegative(),
});
export type ShareMemberSummary = z.infer<typeof shareMemberSummarySchema>;

export const shareSummarySchema = z.object({
  id: z.string().uuid(),
  name: z.string(),
  customName: z.string().nullable(),
  members: z.array(shareMemberSummarySchema).max(SHARE_MAX_ITEMS),
  itemCount: z.number().int().nonnegative().max(SHARE_MAX_ITEMS),
  accessMode: shareAccessModeSchema,
  status: shareStatusSchema,
  createdAt: z.number().int(),
  expiresAt: z.number().int(),
  revokedAt: z.number().int().nullable(),
  accessCount: z.number().int().nonnegative(),
  downloadCount: z.number().int().nonnegative(),
  lastAccessedAt: z.number().int().nullable(),
  shareUrl: z.string().url().nullable(),
  code: z.string().regex(/^\d{4}$/).nullable(),
});
export type ShareSummary = z.infer<typeof shareSummarySchema>;

export const createShareResponseSchema = z.object({
  share: shareSummarySchema,
  shareUrl: z.string().url(),
  generatedCode: z.string().regex(/^\d{4}$/).nullable(),
});
export type CreateShareResponse = z.infer<typeof createShareResponseSchema>;

export const publicShareMemberSchema = z.discriminatedUnion("type", [
  z.object({
    id: z.string().uuid(),
    type: z.literal("text"),
    content: z.string(),
    updatedAt: z.number().int(),
  }),
  z.object({
    id: z.string().uuid(),
    type: z.literal("file"),
    fileName: z.string(),
    mimeType: z.string(),
    sizeBytes: z.number().int().nonnegative(),
    updatedAt: z.number().int(),
  }),
]);
export type PublicShareMember = z.infer<typeof publicShareMemberSchema>;

export const publicShareContentSchema = z.object({
  name: z.string(),
  expiresAt: z.number().int(),
  members: z.array(publicShareMemberSchema).min(1).max(SHARE_MAX_ITEMS),
});
export type PublicShareContent = z.infer<typeof publicShareContentSchema>;

export const verifyShareSchema = z.object({
  code: z.string().regex(/^\d{4}$/),
});

export type ListSharesResponse = {
  shares: ShareSummary[];
};

export type ListItemsResponse = {
  items: DropItem[];
  nextCursor: number | null;
};

export type ApiError = {
  error: {
    code: string;
    message: string;
    requestId: string;
  };
};

export type ExportBundle = {
  format: "drop-worker-export";
  version: 1 | 2;
  exportedAt: string;
  items: DropItem[];
  shares?: Array<Omit<ShareSummary, "shareUrl" | "code">>;
};
