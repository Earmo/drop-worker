import { bigint, index, int, mysqlTable, primaryKey, text, uniqueIndex, varchar } from "drizzle-orm/mysql-core";

// Drizzle schema builder 尚不承载数据库 COMMENT 元数据；原生注释由基线迁移维护。
const epoch = (name: string) => bigint(name, { mode: "number" });

export const items = mysqlTable("items", {
  id: varchar("id", { length: 64 }).primaryKey(),
  ownerId: varchar("owner_id", { length: 255 }).notNull(),
  type: varchar("type", { length: 16 }).notNull(),
  content: text("content"),
  title: text("title"),
  objectKey: text("object_key"),
  originalName: text("original_name"),
  displayName: text("display_name"),
  mimeType: varchar("mime_type", { length: 255 }),
  sizeBytes: epoch("size_bytes").notNull().default(0),
  favorite: int("favorite").notNull().default(0),
  createdAt: epoch("created_at").notNull(),
  updatedAt: epoch("updated_at").notNull(),
  deletedAt: epoch("deleted_at"),
}, (table) => [
  index("idx_items_owner_created").on(table.ownerId, table.createdAt),
  index("idx_items_owner_deleted").on(table.ownerId, table.deletedAt),
  index("idx_items_owner_favorite").on(table.ownerId, table.favorite),
  index("idx_items_owner_type").on(table.ownerId, table.type),
]);

export const uploads = mysqlTable("uploads", {
  id: varchar("id", { length: 64 }).primaryKey(), ownerId: varchar("owner_id", { length: 255 }).notNull(),
  objectKey: text("object_key").notNull(), providerUploadId: text("provider_upload_id").notNull(),
  fileName: text("file_name").notNull(), mimeType: varchar("mime_type", { length: 255 }).notNull(),
  sizeBytes: epoch("size_bytes").notNull(), fingerprint: text("fingerprint").notNull(),
  partsJson: text("parts_json").notNull().default("[]"), status: varchar("status", { length: 20 }).notNull().default("uploading"),
  createdAt: epoch("created_at").notNull(), updatedAt: epoch("updated_at").notNull(), expiresAt: epoch("expires_at").notNull(),
}, (table) => [index("idx_uploads_owner_status").on(table.ownerId, table.status), index("idx_uploads_expires").on(table.expiresAt)]);

export const localSessions = mysqlTable("local_sessions", {
  id: varchar("id", { length: 64 }).primaryKey(), tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  ownerId: varchar("owner_id", { length: 255 }).notNull(), email: varchar("email", { length: 320 }).notNull(),
  createdAt: epoch("created_at").notNull(), expiresAt: epoch("expires_at").notNull(),
}, (table) => [uniqueIndex("idx_local_sessions_token_hash").on(table.tokenHash), index("idx_local_sessions_expires").on(table.expiresAt)]);

export const authChallenges = mysqlTable("auth_challenges", {
  id: varchar("id", { length: 64 }).primaryKey(), email: varchar("email", { length: 320 }).notNull(),
  codeHash: varchar("code_hash", { length: 128 }).notNull(), attempts: int("attempts").notNull().default(0),
  createdAt: epoch("created_at").notNull(), expiresAt: epoch("expires_at").notNull(),
}, (table) => [index("idx_auth_challenges_expires").on(table.expiresAt)]);

export const shares = mysqlTable("shares", {
  id: varchar("id", { length: 64 }).primaryKey(), ownerId: varchar("owner_id", { length: 255 }).notNull(),
  name: text("name"),
  // 兼容历史单项分享；集合成员关系以 share_members 为准。
  itemId: varchar("item_id", { length: 64 }).notNull(), tokenHash: varchar("token_hash", { length: 128 }).notNull(),
  accessMode: varchar("access_mode", { length: 16 }).notNull(), codeHash: varchar("code_hash", { length: 128 }),
  codeEncrypted: text("code_encrypted"),
  createdAt: epoch("created_at").notNull(), expiresAt: epoch("expires_at").notNull(), revokedAt: epoch("revoked_at"),
  accessCount: int("access_count").notNull().default(0), downloadCount: int("download_count").notNull().default(0),
  lastAccessedAt: epoch("last_accessed_at"),
}, (table) => [
  uniqueIndex("idx_shares_token_hash").on(table.tokenHash), index("idx_shares_owner_created").on(table.ownerId, table.createdAt),
  index("idx_shares_item_status").on(table.itemId, table.revokedAt, table.expiresAt), index("idx_shares_retention").on(table.expiresAt, table.revokedAt),
]);

export const shareMembers = mysqlTable("share_members", {
  shareId: varchar("share_id", { length: 64 }).notNull(), itemId: varchar("item_id", { length: 64 }).notNull(),
  position: int("position").notNull(), addedAt: epoch("added_at").notNull(), removedAt: epoch("removed_at"),
  removalReason: varchar("removal_reason", { length: 16 }), downloadCount: int("download_count").notNull().default(0),
}, (table) => [
  primaryKey({ columns: [table.shareId, table.itemId] }),
  index("idx_share_members_share_active").on(table.shareId, table.removedAt, table.position),
  index("idx_share_members_item_active").on(table.itemId, table.removedAt),
]);

export const shareAttempts = mysqlTable("share_attempts", {
  shareId: varchar("share_id", { length: 64 }).notNull(), sourceHash: varchar("source_hash", { length: 128 }).notNull(),
  failures: int("failures").notNull().default(0), lockedUntil: epoch("locked_until").notNull().default(0), updatedAt: epoch("updated_at").notNull(),
}, (table) => [primaryKey({ columns: [table.shareId, table.sourceHash] }), index("idx_share_attempts_updated").on(table.updatedAt)]);

export const schemaVersion = mysqlTable("schema_version", {
  id: int("id").primaryKey(), version: int("version").notNull(),
});

export const migrationState = mysqlTable("migration_state", {
  id: varchar("id", { length: 64 }).primaryKey(), status: varchar("status", { length: 20 }).notNull(),
  createdAt: epoch("created_at").notNull(), updatedAt: epoch("updated_at").notNull(),
});
