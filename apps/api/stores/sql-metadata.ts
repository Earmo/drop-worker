import type {
  DropItem,
  StorageSummary,
  UploadedPart,
} from "../../../packages/contracts";
import { schemaStatements } from "../../../db/sql";
import type {
  ListOptions,
  MetadataStore,
  StoredItem,
  UploadRecord,
} from "../platform";

export type SqlValue = string | number | null;

export interface SqlExecutor {
  all<T>(sql: string, params?: SqlValue[]): Promise<T[]>;
  first<T>(sql: string, params?: SqlValue[]): Promise<T | null>;
  run(sql: string, params?: SqlValue[]): Promise<{ changes: number }>;
  batch(statements: Array<{ sql: string; params?: SqlValue[] }>): Promise<Array<{ changes: number }>>;
}

type ItemRow = {
  id: string;
  owner_id: string;
  type: "text" | "link" | "file";
  content: string | null;
  title: string | null;
  object_key: string | null;
  original_name: string | null;
  display_name: string | null;
  mime_type: string | null;
  size_bytes: number;
  favorite: number;
  created_at: number;
  updated_at: number;
  deleted_at: number | null;
};

type UploadRow = {
  id: string;
  owner_id: string;
  object_key: string;
  provider_upload_id: string;
  file_name: string;
  mime_type: string;
  size_bytes: number;
  fingerprint: string;
  parts_json: string;
  status: "uploading" | "completed" | "cancelled" | "expired";
  created_at: number;
  updated_at: number;
  expires_at: number;
};

const ITEM_COLUMNS = `id, owner_id, type, content, title, object_key,
  original_name, display_name, mime_type, size_bytes, favorite,
  created_at, updated_at, deleted_at`;
const UPLOAD_COLUMNS = `id, owner_id, object_key, provider_upload_id, file_name,
  mime_type, size_bytes, fingerprint, parts_json, status, created_at,
  updated_at, expires_at`;

function itemFromRow(row: ItemRow): StoredItem {
  return {
    id: row.id,
    ownerId: row.owner_id,
    type: row.type,
    content: row.content,
    title: row.title,
    objectKey: row.object_key,
    originalName: row.original_name,
    displayName: row.display_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    favorite: row.favorite === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at,
  };
}

function publicItem(item: StoredItem): DropItem {
  return {
    id: item.id,
    type: item.type,
    content: item.content,
    title: item.title,
    originalName: item.originalName,
    displayName: item.displayName,
    mimeType: item.mimeType,
    sizeBytes: item.sizeBytes,
    favorite: item.favorite,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
    deletedAt: item.deletedAt,
  };
}

function uploadFromRow(row: UploadRow): UploadRecord {
  let parts: UploadedPart[] = [];
  try {
    const parsed: unknown = JSON.parse(row.parts_json);
    if (Array.isArray(parsed)) parts = parsed as UploadedPart[];
  } catch {
    parts = [];
  }
  return {
    id: row.id,
    ownerId: row.owner_id,
    objectKey: row.object_key,
    providerUploadId: row.provider_upload_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    fingerprint: row.fingerprint,
    parts,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

export class SqlMetadataStore implements MetadataStore {
  constructor(private readonly sql: SqlExecutor) {}

  async ensureSchema(): Promise<void> {
    const existing = await this.sql.first<{ name: string }>(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'items'",
    );
    if (existing) return;
    await this.sql.batch(schemaStatements.map((sql) => ({ sql })));
  }

  async listItems(ownerId: string, options: ListOptions) {
    const clauses = ["owner_id = ?", options.trash ? "deleted_at > 0" : "deleted_at IS NULL"];
    const params: SqlValue[] = [ownerId];
    if (options.type) {
      clauses.push("type = ?");
      params.push(options.type);
    }
    if (options.favorites !== undefined) {
      clauses.push("favorite = ?");
      params.push(options.favorites ? 1 : 0);
    }
    if (options.query) {
      const query = `%${options.query.toLocaleLowerCase()}%`;
      clauses.push(`LOWER(COALESCE(content, '') || ' ' || COALESCE(title, '') || ' ' ||
        COALESCE(original_name, '') || ' ' || COALESCE(display_name, '') || ' ' || COALESCE(mime_type, '')) LIKE ?`);
      params.push(query);
    }
    const orderBy =
      options.sort === "oldest"
        ? "created_at ASC, id ASC"
        : options.sort === "largest"
          ? "size_bytes DESC, created_at DESC"
          : "created_at DESC, id DESC";
    params.push(options.limit + 1, options.cursor);
    const rows = await this.sql.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE ${clauses.join(" AND ")}
       ORDER BY ${orderBy} LIMIT ? OFFSET ?`,
      params,
    );
    const hasMore = rows.length > options.limit;
    const selected = hasMore ? rows.slice(0, options.limit) : rows;
    return {
      items: selected.map(itemFromRow).map(publicItem),
      nextCursor: hasMore ? options.cursor + options.limit : null,
    };
  }

  async getItem(ownerId: string, id: string): Promise<StoredItem | null> {
    const row = await this.sql.first<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items
       WHERE owner_id = ? AND id = ? AND (deleted_at IS NULL OR deleted_at > 0)`,
      [ownerId, id],
    );
    return row ? itemFromRow(row) : null;
  }

  private async getAnyItem(ownerId: string, id: string): Promise<StoredItem | null> {
    const row = await this.sql.first<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items WHERE owner_id = ? AND id = ?`,
      [ownerId, id],
    );
    return row ? itemFromRow(row) : null;
  }

  async createItem(input: {
    ownerId: string;
    type: "text" | "link" | "file";
    content?: string | null;
    title?: string | null;
    objectKey?: string | null;
    originalName?: string | null;
    displayName?: string | null;
    mimeType?: string | null;
    sizeBytes?: number;
  }): Promise<StoredItem> {
    const id = crypto.randomUUID();
    const now = Date.now();
    await this.sql.run(
      `INSERT INTO items (
        id, owner_id, type, content, title, object_key, original_name,
        display_name, mime_type, size_bytes, favorite, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)`,
      [
        id,
        input.ownerId,
        input.type,
        input.content ?? null,
        input.title ?? null,
        input.objectKey ?? null,
        input.originalName ?? null,
        input.displayName ?? null,
        input.mimeType ?? null,
        input.sizeBytes ?? 0,
        now,
        now,
      ],
    );
    const item = await this.getItem(input.ownerId, id);
    if (!item) throw new Error("条目创建后无法读取");
    return item;
  }

  async updateItem(
    ownerId: string,
    id: string,
    changes: { content?: string; title?: string; displayName?: string; favorite?: boolean },
  ): Promise<StoredItem | null> {
    const sets: string[] = [];
    const params: SqlValue[] = [];
    if (changes.content !== undefined) {
      sets.push("content = ?");
      params.push(changes.content);
    }
    if (changes.title !== undefined) {
      sets.push("title = ?");
      params.push(changes.title);
    }
    if (changes.displayName !== undefined) {
      sets.push("display_name = ?");
      params.push(changes.displayName);
    }
    if (changes.favorite !== undefined) {
      sets.push("favorite = ?");
      params.push(changes.favorite ? 1 : 0);
    }
    sets.push("updated_at = ?");
    params.push(Date.now(), ownerId, id);
    await this.sql.run(
      `UPDATE items SET ${sets.join(", ")} WHERE owner_id = ? AND id = ?`,
      params,
    );
    return this.getItem(ownerId, id);
  }

  async setDeleted(ownerId: string, ids: string[], deletedAt: number | null): Promise<number> {
    if (ids.length === 0) return 0;
    const placeholders = ids.map(() => "?").join(", ");
    const result = await this.sql.run(
      `UPDATE items SET deleted_at = ?, updated_at = ?
       WHERE owner_id = ? AND id IN (${placeholders})
         AND ${deletedAt === null ? "deleted_at > 0" : "deleted_at IS NULL"}`,
      [deletedAt, Date.now(), ownerId, ...ids],
    );
    return result.changes;
  }

  async beginPurge(ownerId: string, id: string): Promise<StoredItem | null> {
    await this.sql.run(
      `UPDATE items SET deleted_at = -ABS(deleted_at), updated_at = ?
       WHERE owner_id = ? AND id = ? AND deleted_at IS NOT NULL`,
      [Date.now(), ownerId, id],
    );
    const item = await this.getAnyItem(ownerId, id);
    return item?.deletedAt && item.deletedAt < 0 ? item : null;
  }

  async permanentlyDelete(ownerId: string, id: string): Promise<StoredItem | null> {
    const item = await this.getAnyItem(ownerId, id);
    if (!item?.deletedAt || item.deletedAt >= 0) return null;
    const result = await this.sql.run(
      "DELETE FROM items WHERE owner_id = ? AND id = ? AND deleted_at < 0",
      [ownerId, id],
    );
    return result.changes > 0 ? item : null;
  }

  async storageSummary(ownerId: string, quotaBytes: number): Promise<StorageSummary> {
    const [usage, reserved] = await Promise.all([
      this.sql.first<{
        used_bytes: number | null;
        file_bytes: number | null;
        trash_bytes: number | null;
        text_count: number | null;
        link_count: number | null;
      }>(
        `SELECT
          SUM(CASE WHEN type = 'file' THEN size_bytes ELSE 0 END) AS used_bytes,
          SUM(CASE WHEN type = 'file' AND deleted_at IS NULL THEN size_bytes ELSE 0 END) AS file_bytes,
          SUM(CASE WHEN type = 'file' AND deleted_at IS NOT NULL THEN size_bytes ELSE 0 END) AS trash_bytes,
          SUM(CASE WHEN type = 'text' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS text_count,
          SUM(CASE WHEN type = 'link' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS link_count
         FROM items WHERE owner_id = ?`,
        [ownerId],
      ),
      this.sql.first<{ reserved_bytes: number | null }>(
        "SELECT SUM(size_bytes) AS reserved_bytes FROM uploads WHERE owner_id = ? AND status = 'uploading'",
        [ownerId],
      ),
    ]);
    return {
      usedBytes: usage?.used_bytes ?? 0,
      reservedBytes: reserved?.reserved_bytes ?? 0,
      quotaBytes,
      warningThreshold: 0.8,
      byType: {
        text: usage?.text_count ?? 0,
        link: usage?.link_count ?? 0,
        file: usage?.file_bytes ?? 0,
        trash: usage?.trash_bytes ?? 0,
      },
    };
  }

  async createUpload(input: {
    ownerId: string;
    objectKey: string;
    providerUploadId: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    fingerprint: string;
    now: number;
    expiresAt: number;
  }, quotaBytes: number): Promise<UploadRecord | null> {
    const id = crypto.randomUUID();
    const result = await this.sql.run(
      `INSERT INTO uploads (
        id, owner_id, object_key, provider_upload_id, file_name, mime_type,
        size_bytes, fingerprint, parts_json, status, created_at, updated_at, expires_at
      ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, '[]', 'uploading', ?, ?, ?
        WHERE (
          COALESCE((SELECT SUM(size_bytes) FROM items WHERE owner_id = ? AND type = 'file'), 0) +
          COALESCE((SELECT SUM(size_bytes) FROM uploads WHERE owner_id = ? AND status = 'uploading'), 0) +
          ?
        ) <= ?`,
      [
        id,
        input.ownerId,
        input.objectKey,
        input.providerUploadId,
        input.fileName,
        input.mimeType,
        input.sizeBytes,
        input.fingerprint,
        input.now,
        input.now,
        input.expiresAt,
        input.ownerId,
        input.ownerId,
        input.sizeBytes,
        quotaBytes,
      ],
    );
    if (result.changes === 0) return null;
    const upload = await this.getUpload(input.ownerId, id);
    if (!upload) throw new Error("上传会话创建后无法读取");
    return upload;
  }

  async getUpload(ownerId: string, id: string): Promise<UploadRecord | null> {
    const row = await this.sql.first<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE owner_id = ? AND id = ?`,
      [ownerId, id],
    );
    return row ? uploadFromRow(row) : null;
  }

  async saveUploadPart(ownerId: string, id: string, part: UploadedPart): Promise<UploadRecord | null> {
    const upload = await this.getUpload(ownerId, id);
    if (!upload || upload.status !== "uploading") return null;
    const nextParts = [...upload.parts.filter((value) => value.partNumber !== part.partNumber), part].sort(
      (a, b) => a.partNumber - b.partNumber,
    );
    await this.sql.run(
      `UPDATE uploads SET parts_json = ?, updated_at = ?
       WHERE owner_id = ? AND id = ? AND status = 'uploading'`,
      [JSON.stringify(nextParts), Date.now(), ownerId, id],
    );
    return this.getUpload(ownerId, id);
  }

  async completeUpload(ownerId: string, id: string): Promise<StoredItem | null> {
    const upload = await this.getUpload(ownerId, id);
    if (!upload) return null;
    if (upload.status === "completed") return this.getItem(ownerId, id);
    if (upload.status !== "uploading") return null;
    const now = Date.now();
    await this.sql.batch([
      {
        sql: `INSERT OR IGNORE INTO items (
          id, owner_id, type, content, title, object_key, original_name,
          display_name, mime_type, size_bytes, favorite, created_at, updated_at
        ) SELECT id, owner_id, 'file', NULL, NULL, object_key, file_name,
          file_name, mime_type, size_bytes, 0, ?, ?
          FROM uploads WHERE owner_id = ? AND id = ? AND status = 'uploading'`,
        params: [now, now, ownerId, id],
      },
      {
        sql: `UPDATE uploads SET status = 'completed', updated_at = ?
          WHERE owner_id = ? AND id = ? AND status = 'uploading'`,
        params: [now, ownerId, id],
      },
    ]);
    return this.getItem(ownerId, id);
  }

  async markUpload(
    ownerId: string,
    id: string,
    status: "cancelled" | "expired",
  ): Promise<UploadRecord | null> {
    const upload = await this.getUpload(ownerId, id);
    if (!upload || upload.status !== "uploading") return null;
    await this.sql.run(
      "UPDATE uploads SET status = ?, updated_at = ? WHERE owner_id = ? AND id = ?",
      [status, Date.now(), ownerId, id],
    );
    return { ...upload, status };
  }

  async listExpiredUploads(now: number): Promise<UploadRecord[]> {
    const rows = await this.sql.all<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE status = 'uploading' AND expires_at <= ? LIMIT 200`,
      [now],
    );
    return rows.map(uploadFromRow);
  }

  async listExpiredTrash(before: number): Promise<StoredItem[]> {
    const rows = await this.sql.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items
       WHERE deleted_at < 0 OR (deleted_at > 0 AND deleted_at <= ?) LIMIT 200`,
      [before],
    );
    return rows.map(itemFromRow);
  }

  async listAllForExport(ownerId: string): Promise<DropItem[]> {
    const rows = await this.sql.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items
       WHERE owner_id = ? AND (deleted_at IS NULL OR deleted_at > 0)
       ORDER BY created_at ASC, id ASC`,
      [ownerId],
    );
    return rows.map(itemFromRow).map(publicItem);
  }

  async deleteExpiredSessions(now: number): Promise<void> {
    await this.sql.run("DELETE FROM local_sessions WHERE expires_at <= ?", [now]);
    await this.sql.run("DELETE FROM auth_challenges WHERE expires_at <= ?", [now]);
  }
}
