import { z } from "zod";

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
  // 创建上传时只接受文件元数据；文件正文随后按 8 MB 左右的分片发送。
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.string().trim().min(1).max(255).default("application/octet-stream"),
  sizeBytes: z.number().int().positive().max(500 * 1024 * 1024),
  fingerprint: z.string().trim().min(8).max(256),
});

export const uploadedPartSchema = z.object({
  partNumber: z.number().int().min(1).max(10_000),
  etag: z.string().min(1),
  sizeBytes: z.number().int().positive(),
});
export type UploadedPart = z.infer<typeof uploadedPartSchema>;

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
  mode: z.enum(["platform", "password", "smtp-otp", "development"]),
  email: z.string().email().nullable(),
  insecureHttp: z.boolean(),
});
export type AuthStatus = z.infer<typeof authStatusSchema>;

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
  version: 1;
  exportedAt: string;
  items: DropItem[];
};
