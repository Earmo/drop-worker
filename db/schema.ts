import { index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

// Drizzle schema 是迁移和类型生成的来源；字段名映射到运行时共享的 snake_case SQL 表。
export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    type: text("type", { enum: ["text", "link", "file"] }).notNull(),
    content: text("content"),
    title: text("title"),
    objectKey: text("object_key"),
    originalName: text("original_name"),
    displayName: text("display_name"),
    mimeType: text("mime_type"),
    sizeBytes: integer("size_bytes").notNull().default(0),
    favorite: integer("favorite", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    deletedAt: integer("deleted_at"),
  },
  (table) => [
    index("idx_items_owner_created").on(table.ownerId, table.createdAt),
    index("idx_items_owner_deleted").on(table.ownerId, table.deletedAt),
    index("idx_items_owner_favorite").on(table.ownerId, table.favorite),
    index("idx_items_owner_type").on(table.ownerId, table.type),
  ],
);

export const uploads = sqliteTable(
  // 未完成上传的 partsJson 与对象存储 multipart 会话共同构成断点续传状态。
  "uploads",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    objectKey: text("object_key").notNull(),
    providerUploadId: text("provider_upload_id").notNull(),
    fileName: text("file_name").notNull(),
    mimeType: text("mime_type").notNull(),
    sizeBytes: integer("size_bytes").notNull(),
    fingerprint: text("fingerprint").notNull(),
    partsJson: text("parts_json").notNull().default("[]"),
    status: text("status", {
      enum: ["uploading", "completed", "cancelled", "expired", "cancelling", "expiring"],
    })
      .notNull()
      .default("uploading"),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [
    index("idx_uploads_owner_status").on(table.ownerId, table.status),
    index("idx_uploads_expires").on(table.expiresAt),
  ],
);

export const localSessions = sqliteTable(
  "local_sessions",
  {
    id: text("id").primaryKey(),
    tokenHash: text("token_hash").notNull().unique(),
    ownerId: text("owner_id").notNull(),
    email: text("email").notNull(),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_local_sessions_expires").on(table.expiresAt)],
);

export const authChallenges = sqliteTable(
  // 验证码挑战与会话分开保存，挑战过期/次数耗尽后不能直接换成登录会话。
  "auth_challenges",
  {
    id: text("id").primaryKey(),
    email: text("email").notNull(),
    codeHash: text("code_hash").notNull(),
    attempts: integer("attempts").notNull().default(0),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (table) => [index("idx_auth_challenges_expires").on(table.expiresAt)],
);

export const shares = sqliteTable(
  "shares",
  {
    id: text("id").primaryKey(),
    ownerId: text("owner_id").notNull(),
    itemId: text("item_id").notNull(),
    tokenHash: text("token_hash").notNull(),
    accessMode: text("access_mode", { enum: ["public", "code"] }).notNull(),
    codeHash: text("code_hash"),
    codeEncrypted: text("code_encrypted"),
    createdAt: integer("created_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
    revokedAt: integer("revoked_at"),
    accessCount: integer("access_count").notNull().default(0),
    downloadCount: integer("download_count").notNull().default(0),
    lastAccessedAt: integer("last_accessed_at"),
  },
  (table) => [
    uniqueIndex("idx_shares_token_hash").on(table.tokenHash),
    index("idx_shares_owner_created").on(table.ownerId, table.createdAt),
    index("idx_shares_item_status").on(table.itemId, table.revokedAt, table.expiresAt),
    index("idx_shares_retention").on(table.expiresAt, table.revokedAt),
  ],
);

export const shareAttempts = sqliteTable(
  "share_attempts",
  {
    shareId: text("share_id").notNull(),
    sourceHash: text("source_hash").notNull(),
    failures: integer("failures").notNull().default(0),
    lockedUntil: integer("locked_until").notNull().default(0),
    updatedAt: integer("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.shareId, table.sourceHash] }),
    index("idx_share_attempts_updated").on(table.updatedAt),
  ],
);

export const schemaVersion = sqliteTable("schema_version", {
  id: integer("id").primaryKey(),
  version: integer("version").notNull(),
});

export const migrationState = sqliteTable("migration_state", {
  id: text("id").primaryKey(),
  status: text("status", { enum: ["in_progress", "complete"] }).notNull(),
  createdAt: integer("created_at").notNull(),
  updatedAt: integer("updated_at").notNull(),
});
