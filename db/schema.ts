import { index, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";

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
