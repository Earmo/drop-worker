import {
  SHARE_MAX_ITEMS,
  type DropItem,
  type StorageSummary,
  type UploadedPart,
} from "../../packages/contracts";
import { schemaStatements } from "../../db/sql";
import type {
  AuthChallengeRecord,
  AuthSessionRecord,
  ListOptions,
  MetadataStore,
  ShareAttemptRecord,
  ShareMemberRemovalReason,
  StoredItem,
  StoredShare,
  StoredShareMember,
  UploadRecord,
} from "../platform";

export type SqlValue = string | number | null;

export interface SqlExecutor {
  tableExists(name: string): Promise<boolean>;
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
  status: "uploading" | "completed" | "cancelled" | "expired" | "cancelling" | "expiring";
  created_at: number;
  updated_at: number;
  expires_at: number;
};

type AuthChallengeRow = {
  id: string;
  email: string;
  code_hash: string;
  attempts: number;
  created_at: number;
  expires_at: number;
};

type ShareRow = {
  id: string;
  owner_id: string;
  name: string | null;
  token_hash: string;
  access_mode: "public" | "code";
  code_hash: string | null;
  code_encrypted: string | null;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  access_count: number;
  download_count: number;
  last_accessed_at: number | null;
};

type ShareMemberJoinedRow = {
  share_id: string;
  item_id: string;
  position: number;
  added_at: number;
  removed_at: number | null;
  removal_reason: ShareMemberRemovalReason | null;
  member_download_count: number;
  item_owner_id: string | null;
  item_type: "text" | "link" | "file" | null;
  item_content: string | null;
  item_title: string | null;
  item_object_key: string | null;
  item_original_name: string | null;
  item_display_name: string | null;
  item_mime_type: string | null;
  item_size_bytes: number | null;
  item_favorite: number | null;
  item_created_at: number | null;
  item_updated_at: number | null;
  item_deleted_at: number | null;
};

const ITEM_COLUMNS = `id, owner_id, type, content, title, object_key,
  original_name, display_name, mime_type, size_bytes, favorite,
  created_at, updated_at, deleted_at`;
const UPLOAD_COLUMNS = `id, owner_id, object_key, provider_upload_id, file_name,
  mime_type, size_bytes, fingerprint, parts_json, status, created_at,
  updated_at, expires_at`;
const SHARE_COLUMNS = `id, owner_id, name, token_hash, access_mode, code_hash,
  code_encrypted, created_at, expires_at, revoked_at, access_count,
  download_count, last_accessed_at`;
const SHARE_MEMBER_JOIN_COLUMNS = `
  sm.share_id, sm.item_id, sm.position, sm.added_at, sm.removed_at,
  sm.removal_reason, sm.download_count AS member_download_count,
  i.owner_id AS item_owner_id,
  i.type AS item_type, i.content AS item_content, i.title AS item_title,
  i.object_key AS item_object_key, i.original_name AS item_original_name,
  i.display_name AS item_display_name, i.mime_type AS item_mime_type,
  i.size_bytes AS item_size_bytes, i.favorite AS item_favorite,
  i.created_at AS item_created_at, i.updated_at AS item_updated_at,
  i.deleted_at AS item_deleted_at`;

// 数据库列名使用 snake_case，API 契约使用 camelCase；转换集中在这里，避免适配层和路由各自映射。
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
    // parts_json 是为了让 D1 和 SQLite 共享同一套表结构；损坏时按空分片处理，
    // 让清理任务仍能回收会话，而不是让单行坏数据阻塞整个列表查询。
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

function authChallengeFromRow(row: AuthChallengeRow): AuthChallengeRecord {
  return {
    id: row.id,
    email: row.email,
    codeHash: row.code_hash,
    attempts: row.attempts,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  };
}

function shareMemberFromRow(row: ShareMemberJoinedRow): StoredShareMember {
  const hasItem = row.item_owner_id !== null && row.item_type !== null
    && row.item_size_bytes !== null && row.item_favorite !== null
    && row.item_created_at !== null && row.item_updated_at !== null;
  return {
    itemId: row.item_id,
    position: row.position,
    addedAt: row.added_at,
    removedAt: row.removed_at,
    removalReason: row.removal_reason,
    downloadCount: row.member_download_count,
    item: hasItem ? {
      id: row.item_id,
      ownerId: row.item_owner_id!,
      type: row.item_type!,
      content: row.item_content,
      title: row.item_title,
      objectKey: row.item_object_key,
      originalName: row.item_original_name,
      displayName: row.item_display_name,
      mimeType: row.item_mime_type,
      sizeBytes: row.item_size_bytes!,
      favorite: row.item_favorite === 1,
      createdAt: row.item_created_at!,
      updatedAt: row.item_updated_at!,
      deletedAt: row.item_deleted_at,
    } : null,
  };
}

function shareFromRow(row: ShareRow, members: StoredShareMember[]): StoredShare {
  return {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    tokenHash: row.token_hash,
    accessMode: row.access_mode,
    codeHash: row.code_hash,
    codeEncrypted: row.code_encrypted,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at,
    accessCount: row.access_count,
    downloadCount: members.reduce((total, member) => total + member.downloadCount, 0),
    lastAccessedAt: row.last_accessed_at,
    members,
  };
}

export class SqlMetadataStore implements MetadataStore {
  private readonly operationLocks = new Map<string, Promise<void>>();
  private schemaReady = false;

  constructor(
    private readonly sql: SqlExecutor,
    private readonly autoCreateSchema = true,
  ) {}

  async healthCheck(): Promise<void> {
    await this.sql.first<{ healthy: number }>("SELECT 1 AS healthy");
  }

  private async withOperationLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.operationLocks.get(key) || Promise.resolve();
    const current = previous.then(operation, operation);
    const tail = current.then(() => undefined, () => undefined);
    this.operationLocks.set(key, tail);
    try {
      return await current;
    } finally {
      if (this.operationLocks.get(key) === tail) this.operationLocks.delete(key);
    }
  }

  async ensureSchema(): Promise<void> {
    if (this.schemaReady) return;
    if (this.autoCreateSchema) {
      // 本地零配置模式每次执行幂等语句，使已有 SQLite 实例也能补齐新增表。
      await this.sql.batch(schemaStatements.map((sql) => ({ sql })));
      try {
        await this.sql.run("ALTER TABLE shares ADD COLUMN code_encrypted TEXT");
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
      try {
        await this.sql.run("ALTER TABLE shares ADD COLUMN name TEXT");
      } catch (error) {
        if (!(error instanceof Error) || !/duplicate column name/i.test(error.message)) throw error;
      }
      // 每条旧分享成为一个单成员集合；历史下载次数迁移到成员后即可按成员保留。
      await this.sql.run(
        `INSERT OR IGNORE INTO share_members (
          share_id, item_id, position, added_at, removed_at, removal_reason, download_count
        ) SELECT id, item_id, 0, created_at, NULL, NULL, download_count FROM shares`,
      );
      await this.sql.run("UPDATE schema_version SET version = 5 WHERE id = 1 AND version < 5");
      this.schemaReady = true;
      return;
    }
    const [itemsExist, sharesExist, membersExist, versionTableExists] = await Promise.all([
      this.sql.tableExists("items"),
      this.sql.tableExists("shares"),
      this.sql.tableExists("share_members"),
      this.sql.tableExists("schema_version"),
    ]);
    const schemaVersion = versionTableExists
      ? await this.sql.first<{ version: number }>("SELECT version FROM schema_version WHERE id = 1")
      : null;
    if (!itemsExist || !sharesExist || !membersExist || !schemaVersion || schemaVersion.version !== 5) {
      throw new Error("数据库架构尚未迁移，请先应用正式迁移");
    }
    this.schemaReady = true;
  }

  async ensureApplicationReady(): Promise<void> {
    const migration = await this.sql.first<{ status: string }>(
      "SELECT status FROM migration_state LIMIT 1",
    );
    if (migration && migration.status !== "complete") {
      throw new Error("存储迁移尚未完成，当前目标不能用于应用启动");
    }
  }

  async listItems(ownerId: string, options: ListOptions) {
    // 过滤条件全部进入参数绑定，只有预先固定的排序片段允许拼接进 SQL。
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
      clauses.push(`(
        LOWER(COALESCE(content, '')) LIKE ? OR LOWER(COALESCE(title, '')) LIKE ? OR
        LOWER(COALESCE(original_name, '')) LIKE ? OR LOWER(COALESCE(display_name, '')) LIKE ? OR
        LOWER(COALESCE(mime_type, '')) LIKE ?
      )`);
      params.push(query, query, query, query, query);
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
    // 多取一行判断是否还有下一页；返回的 cursor 使用 offset，保持前端续读逻辑简单。
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
    // 只拼接调用方实际提供的字段，值仍然通过参数绑定传入，避免动态 UPDATE 产生注入面。
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
    const now = Date.now();
    const updateItem = {
      sql: `UPDATE items SET deleted_at = ?, updated_at = ?
        WHERE owner_id = ? AND id IN (${placeholders})
          AND ${deletedAt === null ? "deleted_at > 0" : "deleted_at IS NULL"}`,
      params: [deletedAt, now, ownerId, ...ids] as SqlValue[],
    };
    if (deletedAt === null) return (await this.sql.run(updateItem.sql, updateItem.params)).changes;
    const [result] = await this.sql.batch([
      updateItem,
      {
        sql: `UPDATE share_members SET removed_at = ?, removal_reason = 'trash'
          WHERE removed_at IS NULL AND item_id IN (${placeholders})
            AND item_id IN (SELECT id FROM items WHERE owner_id = ? AND deleted_at IS NOT NULL)
            AND share_id IN (SELECT id FROM shares WHERE owner_id = ?)`,
        params: [now, ...ids, ownerId, ownerId],
      },
      {
        sql: `UPDATE shares SET revoked_at = ?
          WHERE owner_id = ? AND revoked_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM share_members sm
              WHERE sm.share_id = shares.id AND sm.removed_at IS NULL
            )`,
        params: [now, ownerId],
      },
    ]);
    return result?.changes ?? 0;
  }

  async beginPurge(ownerId: string, id: string): Promise<StoredItem | null> {
    // 正数 deleted_at 表示回收站，负数表示已获得删除租约；ABS 保留原删除时间用于审计/筛选。
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
    const results = await this.sql.batch([
      {
        sql: "DELETE FROM items WHERE owner_id = ? AND id = ? AND deleted_at < 0",
        params: [ownerId, id],
      },
    ]);
    const result = results[0];
    return result.changes > 0 ? item : null;
  }

  async storageSummary(ownerId: string, quotaBytes: number): Promise<StorageSummary> {
    // 这些统计相互独立，使用 Promise.all 并行读取；reserved_bytes 还包括正在上传的预留空间。
    const [usage, reserved, largestFile, oldestItem] = await Promise.all([
      this.sql.first<{
        used_bytes: number | null;
        file_bytes: number | null;
        trash_bytes: number | null;
        text_count: number | null;
        file_count: number | null;
        trash_count: number | null;
        link_count: number | null;
      }>(
        `SELECT
          SUM(CASE WHEN type = 'file' THEN size_bytes ELSE 0 END) AS used_bytes,
          SUM(CASE WHEN type = 'file' AND deleted_at IS NULL THEN size_bytes ELSE 0 END) AS file_bytes,
          SUM(CASE WHEN type = 'file' AND deleted_at IS NOT NULL THEN size_bytes ELSE 0 END) AS trash_bytes,
          SUM(CASE WHEN type = 'text' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS text_count,
          SUM(CASE WHEN type = 'link' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS link_count,
          SUM(CASE WHEN type = 'file' AND deleted_at IS NULL THEN 1 ELSE 0 END) AS file_count,
          SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END) AS trash_count
         FROM items WHERE owner_id = ?`,
        [ownerId],
      ),
      this.sql.first<{ reserved_bytes: number | null }>(
        "SELECT SUM(size_bytes) AS reserved_bytes FROM uploads WHERE owner_id = ? AND status IN ('uploading', 'cancelling', 'expiring')",
        [ownerId],
      ),
      this.sql.first<{ id: string; display_name: string; size_bytes: number }>(
        `SELECT id, COALESCE(display_name, original_name, '未命名文件') AS display_name, size_bytes
         FROM items
         WHERE owner_id = ? AND deleted_at IS NULL AND favorite = 0 AND type = 'file'
         ORDER BY size_bytes DESC, created_at ASC LIMIT 1`,
        [ownerId],
      ),
      this.sql.first<{ id: string; type: "text" | "link" | "file"; display_name: string; created_at: number }>(
        `SELECT id, type,
          COALESCE(display_name, original_name, title, SUBSTR(content, 1, 80), '未命名内容') AS display_name,
          created_at
         FROM items
         WHERE owner_id = ? AND deleted_at IS NULL AND favorite = 0
         ORDER BY created_at ASC, id ASC LIMIT 1`,
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
      itemCounts: {
        text: usage?.text_count ?? 0,
        link: usage?.link_count ?? 0,
        file: usage?.file_count ?? 0,
        trash: usage?.trash_count ?? 0,
      },
      largestFile: largestFile ? {
        id: largestFile.id,
        displayName: largestFile.display_name,
        sizeBytes: largestFile.size_bytes,
      } : null,
      oldestItem: oldestItem ? {
        id: oldestItem.id,
        type: oldestItem.type,
        displayName: oldestItem.display_name,
        createdAt: oldestItem.created_at,
      } : null,
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
    return this.withOperationLock(`quota:${input.ownerId}`, () => this.createUploadUnlocked(input, quotaBytes));
  }

  private async createUploadUnlocked(input: {
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
    // 配额检查和 INSERT 放在同一条条件 INSERT 中：并发上传时由数据库决定谁能成功预留空间。
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

  async saveUploadParts(ownerId: string, id: string, parts: UploadedPart[]): Promise<UploadRecord | null> {
    return this.withOperationLock(`upload:${ownerId}:${id}`, () => this.saveUploadPartsUnlocked(ownerId, id, parts));
  }

  private async saveUploadPartsUnlocked(
    ownerId: string,
    id: string,
    parts: UploadedPart[],
  ): Promise<UploadRecord | null> {
    const partNumbers = new Set(parts.map((part) => part.partNumber));
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const row = await this.sql.first<UploadRow>(
        `SELECT ${UPLOAD_COLUMNS} FROM uploads WHERE owner_id = ? AND id = ?`,
        [ownerId, id],
      );
      if (!row || row.status !== "uploading") return null;
      const upload = uploadFromRow(row);
      const nextParts = [...upload.parts.filter((value) => !partNumbers.has(value.partNumber)), ...parts].sort(
        (a, b) => a.partNumber - b.partNumber,
      );
      // parts_json 作为版本值参与 WHERE；不同 Worker 实例并发确认时，落后的写入会重读并合并。
      const result = await this.sql.run(
        `UPDATE uploads SET parts_json = ?, updated_at = ?
         WHERE owner_id = ? AND id = ? AND status = 'uploading' AND parts_json = ?`,
        [JSON.stringify(nextParts), Date.now(), ownerId, id, row.parts_json],
      );
      if (result.changes > 0) return this.getUpload(ownerId, id);
    }
    throw new Error("并发保存上传分片失败，请重试");
  }

  async completeUpload(ownerId: string, id: string): Promise<StoredItem | null> {
    const upload = await this.getUpload(ownerId, id);
    if (!upload) return null;
    if (upload.status === "completed") return this.getItem(ownerId, id);
    if (upload.status !== "uploading") return null;
    const now = Date.now();
    // 元数据落库也分两步放进同一个 batch：先生成 file 条目，再释放上传中的状态。
    // 两步要么一起提交，要么一起回滚，避免出现“文件可见但配额仍被预留”的中间态。
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

  async beginUploadCleanup(
    ownerId: string,
    id: string,
    finalStatus: "cancelled" | "expired",
  ): Promise<UploadRecord | null> {
    const upload = await this.getUpload(ownerId, id);
    const pendingStatus = finalStatus === "cancelled" ? "cancelling" : "expiring";
    if (!upload || (upload.status !== "uploading" && upload.status !== pendingStatus)) return null;
    // 把 uploading 转为 pending 状态相当于领取清理租约；已领取的任务可被下一轮继续处理。
    await this.sql.run(
      `UPDATE uploads SET status = ?, updated_at = ?
       WHERE owner_id = ? AND id = ? AND status IN ('uploading', ?)`,
      [pendingStatus, Date.now(), ownerId, id, pendingStatus],
    );
    return { ...upload, status: pendingStatus };
  }

  async finishUploadCleanup(
    ownerId: string,
    id: string,
    finalStatus: "cancelled" | "expired",
  ): Promise<UploadRecord | null> {
    const pendingStatus = finalStatus === "cancelled" ? "cancelling" : "expiring";
    const upload = await this.getUpload(ownerId, id);
    if (!upload || upload.status !== pendingStatus) return null;
    // 外部对象删除成功后才落最终状态，避免数据库“已取消”但对象仍占用空间。
    await this.sql.run(
      "UPDATE uploads SET status = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND status = ?",
      [finalStatus, Date.now(), ownerId, id, pendingStatus],
    );
    return { ...upload, status: finalStatus };
  }

  async listExpiredUploads(now: number): Promise<UploadRecord[]> {
    // 同时返回处理中状态，支持上一次清理在外部调用失败后的重试。
    const rows = await this.sql.all<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM uploads
       WHERE status IN ('cancelling', 'expiring')
          OR (status = 'uploading' AND expires_at <= ?) LIMIT 200`,
      [now],
    );
    return rows.map(uploadFromRow);
  }

  async listExpiredTrash(before: number): Promise<StoredItem[]> {
    // 负数是上次已领取但未完成的删除任务，正数则按回收站保留期筛选。
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

  private async sharesFromRows(rows: ShareRow[]): Promise<StoredShare[]> {
    if (rows.length === 0) return [];
    const placeholders = rows.map(() => "?").join(", ");
    const memberRows = await this.sql.all<ShareMemberJoinedRow>(
      `SELECT ${SHARE_MEMBER_JOIN_COLUMNS}
       FROM share_members sm
       JOIN shares s ON s.id = sm.share_id
       LEFT JOIN items i ON i.id = sm.item_id AND i.owner_id = s.owner_id
       WHERE sm.share_id IN (${placeholders})
       ORDER BY sm.share_id ASC, sm.position ASC, sm.item_id ASC`,
      rows.map((row) => row.id),
    );
    const membersByShare = new Map<string, StoredShareMember[]>();
    for (const memberRow of memberRows) {
      const members = membersByShare.get(memberRow.share_id) || [];
      members.push(shareMemberFromRow(memberRow));
      membersByShare.set(memberRow.share_id, members);
    }
    return rows.map((row) => shareFromRow(row, membersByShare.get(row.id) || []));
  }

  private async getShareById(id: string): Promise<StoredShare | null> {
    const row = await this.sql.first<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM shares WHERE id = ?`,
      [id],
    );
    return row ? (await this.sharesFromRows([row]))[0] || null : null;
  }

  private async validShareItems(ownerId: string, itemIds: string[]): Promise<boolean> {
    if (itemIds.length === 0 || itemIds.length > SHARE_MAX_ITEMS) return false;
    const placeholders = itemIds.map(() => "?").join(", ");
    // 链接与文本、文件一样可以作为集合成员；协议合法性在公开组装时再校验。
    const rows = await this.sql.all<{ id: string }>(
      `SELECT id FROM items WHERE owner_id = ? AND deleted_at IS NULL
       AND type IN ('text', 'file', 'link') AND id IN (${placeholders})`,
      [ownerId, ...itemIds],
    );
    return rows.length === itemIds.length;
  }

  async createShare(input: {
    id: string;
    ownerId: string;
    itemIds: string[];
    name: string | null;
    tokenHash: string;
    accessMode: "public" | "code";
    codeHash: string | null;
    codeEncrypted?: string | null;
    now: number;
    expiresAt: number;
  }): Promise<StoredShare | null> {
    return this.withOperationLock(`share-owner:${input.ownerId}`, async () => {
      const itemIds = [...new Set(input.itemIds)];
      if (!(await this.validShareItems(input.ownerId, itemIds))) return null;
      const statements: Array<{ sql: string; params?: SqlValue[] }> = [{
        sql: `INSERT INTO shares (
          id, owner_id, name, item_id, token_hash, access_mode, code_hash, code_encrypted,
          created_at, expires_at, revoked_at, access_count, download_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, 0)`,
        params: [
          input.id, input.ownerId, input.name, itemIds[0]!, input.tokenHash,
          input.accessMode, input.codeHash, input.codeEncrypted ?? null,
          input.now, input.expiresAt,
        ],
      }];
      itemIds.forEach((itemId, position) => statements.push({
        sql: `INSERT INTO share_members (
          share_id, item_id, position, added_at, removed_at, removal_reason, download_count
        ) VALUES (?, ?, ?, ?, NULL, NULL, 0)`,
        params: [input.id, itemId, position, input.now],
      }));
      await this.sql.batch(statements);
      return this.getShareById(input.id);
    });
  }

  async updateShare(
    ownerId: string,
    id: string,
    changes: { name?: string | null; itemIds?: string[] },
    now: number,
  ): Promise<StoredShare | null> {
    return this.withOperationLock(`share:${id}`, async () => {
      const current = await this.getShareById(id);
      if (!current || current.ownerId !== ownerId || current.revokedAt !== null || current.expiresAt <= now) {
        return null;
      }
      const itemIds = changes.itemIds === undefined ? undefined : [...new Set(changes.itemIds)];
      if (itemIds && itemIds.length > 0 && !(await this.validShareItems(ownerId, itemIds))) return null;
      if (itemIds && itemIds.length > SHARE_MAX_ITEMS) return null;

      const statements: Array<{ sql: string; params?: SqlValue[] }> = [];
      if (changes.name !== undefined) {
        statements.push({
          sql: "UPDATE shares SET name = ? WHERE id = ? AND owner_id = ?",
          params: [changes.name, id, ownerId],
        });
      }
      if (itemIds !== undefined) {
        const desired = new Set(itemIds);
        const activeMembers = current.members.filter((member) => member.removedAt === null);
        for (const member of activeMembers) {
          if (!desired.has(member.itemId)) {
            statements.push({
              sql: `UPDATE share_members SET removed_at = ?, removal_reason = 'manual'
                WHERE share_id = ? AND item_id = ? AND removed_at IS NULL`,
              params: [now, id, member.itemId],
            });
          }
        }
        const activeIds = new Set(activeMembers.map((member) => member.itemId));
        let position = current.members.reduce((maximum, member) => Math.max(maximum, member.position), -1) + 1;
        for (const itemId of itemIds) {
          if (activeIds.has(itemId)) continue;
          statements.push({
            sql: `UPDATE share_members SET position = ?, added_at = ?, removed_at = NULL, removal_reason = NULL
              WHERE share_id = ? AND item_id = ?`,
            params: [position, now, id, itemId],
          });
          statements.push({
            sql: `INSERT OR IGNORE INTO share_members (
              share_id, item_id, position, added_at, removed_at, removal_reason, download_count
            ) VALUES (?, ?, ?, ?, NULL, NULL, 0)`,
            params: [id, itemId, position, now],
          });
          position += 1;
        }
        statements.push({
          sql: `UPDATE shares SET revoked_at = ? WHERE id = ? AND owner_id = ? AND revoked_at IS NULL
            AND NOT EXISTS (
              SELECT 1 FROM share_members sm JOIN items i ON i.id = sm.item_id
              WHERE sm.share_id = shares.id AND sm.removed_at IS NULL
                AND i.owner_id = shares.owner_id AND i.deleted_at IS NULL
            )`,
          params: [now, id, ownerId],
        });
      }
      if (statements.length > 0) await this.sql.batch(statements);
      return this.getShareById(id);
    });
  }

  async listShares(ownerId: string, now: number, historyAfter: number): Promise<StoredShare[]> {
    const rows = await this.sql.all<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM shares
       WHERE owner_id = ? AND revoked_at IS NULL AND (expires_at > ? OR expires_at >= ?)
       ORDER BY CASE WHEN expires_at > ? THEN 0 ELSE 1 END, created_at DESC, id DESC`,
      [ownerId, now, historyAfter, now],
    );
    return this.sharesFromRows(rows);
  }

  async getShareByTokenHash(tokenHash: string): Promise<StoredShare | null> {
    const row = await this.sql.first<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM shares WHERE token_hash = ?`,
      [tokenHash],
    );
    return row ? (await this.sharesFromRows([row]))[0] || null : null;
  }

  async revokeShare(ownerId: string, id: string, now: number): Promise<StoredShare | null> {
    const result = await this.sql.run(
      "UPDATE shares SET revoked_at = ? WHERE owner_id = ? AND id = ? AND revoked_at IS NULL",
      [now, ownerId, id],
    );
    if (result.changes === 0) return null;
    return this.getShareById(id);
  }

  async recordShareAccess(id: string, now: number): Promise<void> {
    await this.sql.run(
      `UPDATE shares SET access_count = access_count + 1, last_accessed_at = ?
       WHERE id = ? AND revoked_at IS NULL AND expires_at > ?`,
      [now, id, now],
    );
  }

  async recordShareDownload(id: string, itemId: string, now: number): Promise<void> {
    const result = await this.sql.run(
      `UPDATE share_members SET download_count = download_count + 1
       WHERE share_id = ? AND item_id = ? AND removed_at IS NULL
         AND EXISTS (SELECT 1 FROM shares WHERE id = ? AND revoked_at IS NULL AND expires_at > ?)`,
      [id, itemId, id, now],
    );
    if (result.changes > 0) {
      await this.sql.run("UPDATE shares SET last_accessed_at = ? WHERE id = ?", [now, id]);
    }
  }

  async getShareAttempt(shareId: string, sourceHash: string): Promise<ShareAttemptRecord | null> {
    const row = await this.sql.first<{
      share_id: string;
      source_hash: string;
      failures: number;
      locked_until: number;
      updated_at: number;
    }>(
      `SELECT share_id, source_hash, failures, locked_until, updated_at
       FROM share_attempts WHERE share_id = ? AND source_hash = ?`,
      [shareId, sourceHash],
    );
    return row ? {
      shareId: row.share_id,
      sourceHash: row.source_hash,
      failures: row.failures,
      lockedUntil: row.locked_until,
      updatedAt: row.updated_at,
    } : null;
  }

  async recordShareFailure(shareId: string, sourceHash: string, now: number): Promise<ShareAttemptRecord> {
    return this.withOperationLock(
      `share-attempt:${shareId}:${sourceHash}`,
      () => this.recordShareFailureUnlocked(shareId, sourceHash, now),
    );
  }

  private async recordShareFailureUnlocked(
    shareId: string,
    sourceHash: string,
    now: number,
  ): Promise<ShareAttemptRecord> {
    const activeAfter = now - 15 * 60 * 1000;
    const lockUntil = now + 15 * 60 * 1000;
    await this.sql.batch([
      {
        sql: `INSERT OR IGNORE INTO share_attempts (
          share_id, source_hash, failures, locked_until, updated_at
        ) VALUES (?, ?, 0, 0, 0)`,
        params: [shareId, sourceHash],
      },
      {
        sql: `UPDATE share_attempts SET
          locked_until = CASE
            WHEN updated_at > ? AND failures >= 4
              THEN ? + (updated_at - updated_at)
            ELSE updated_at - updated_at
          END,
          failures = CASE WHEN updated_at > ? THEN failures + 1 ELSE 1 END,
          updated_at = ?
          WHERE share_id = ? AND source_hash = ?`,
        params: [activeAfter, lockUntil, activeAfter, now, shareId, sourceHash],
      },
    ]);
    const attempt = await this.getShareAttempt(shareId, sourceHash);
    if (!attempt) throw new Error("分享口令失败次数写入后无法读取");
    return attempt;
  }

  async saveShareAttempt(record: ShareAttemptRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO share_attempts (share_id, source_hash, failures, locked_until, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (share_id, source_hash) DO UPDATE SET
         failures = excluded.failures,
         locked_until = excluded.locked_until,
         updated_at = excluded.updated_at`,
      [record.shareId, record.sourceHash, record.failures, record.lockedUntil, record.updatedAt],
    );
  }

  async deleteShareAttempt(shareId: string, sourceHash: string): Promise<void> {
    await this.sql.run(
      "DELETE FROM share_attempts WHERE share_id = ? AND source_hash = ?",
      [shareId, sourceHash],
    );
  }

  async deleteExpiredShares(before: number, attemptsBefore: number): Promise<void> {
    await this.sql.batch([
      { sql: "DELETE FROM share_attempts WHERE updated_at <= ?", params: [attemptsBefore] },
      {
        sql: `DELETE FROM share_attempts WHERE share_id IN (
          SELECT id FROM shares
          WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
             OR (revoked_at IS NULL AND expires_at <= ?)
        )`,
        params: [before, before],
      },
      {
        sql: `DELETE FROM share_members WHERE share_id IN (
          SELECT id FROM shares
          WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
             OR (revoked_at IS NULL AND expires_at <= ?)
        )`,
        params: [before, before],
      },
      {
        sql: `DELETE FROM shares
          WHERE (revoked_at IS NOT NULL AND revoked_at <= ?)
             OR (revoked_at IS NULL AND expires_at <= ?)`,
        params: [before, before],
      },
    ]);
  }

  async getAuthSession(tokenHash: string, now: number): Promise<AuthSessionRecord | null> {
    const row = await this.sql.first<{ owner_id: string; email: string; expires_at: number }>(
      `SELECT owner_id, email, expires_at FROM local_sessions
       WHERE token_hash = ? AND expires_at > ?`,
      [tokenHash, now],
    );
    return row ? { ownerId: row.owner_id, email: row.email, expiresAt: row.expires_at } : null;
  }

  async createAuthSession(input: {
    id: string;
    tokenHash: string;
    ownerId: string;
    email: string;
    createdAt: number;
    expiresAt: number;
  }): Promise<void> {
    await this.sql.run(
      `INSERT INTO local_sessions (id, token_hash, owner_id, email, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.tokenHash, input.ownerId, input.email, input.createdAt, input.expiresAt],
    );
  }

  async deleteAuthSession(tokenHash: string): Promise<void> {
    await this.sql.run("DELETE FROM local_sessions WHERE token_hash = ?", [tokenHash]);
  }

  async createAuthChallenge(input: AuthChallengeRecord): Promise<void> {
    await this.sql.run(
      `INSERT INTO auth_challenges (id, email, code_hash, attempts, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [input.id, input.email, input.codeHash, input.attempts, input.createdAt, input.expiresAt],
    );
  }

  async replaceAuthChallenge(input: AuthChallengeRecord): Promise<void> {
    // 新验证码写入与旧验证码清理必须在同一事务中完成，避免发送失败后继续保留旧挑战。
    await this.sql.batch([
      {
        sql: "DELETE FROM auth_challenges WHERE email = ? OR expires_at <= ?",
        params: [input.email, input.createdAt],
      },
      {
        sql: `INSERT INTO auth_challenges (id, email, code_hash, attempts, created_at, expires_at)
              VALUES (?, ?, ?, ?, ?, ?)`,
        params: [input.id, input.email, input.codeHash, input.attempts, input.createdAt, input.expiresAt],
      },
    ]);
  }

  async getLatestAuthChallenge(email: string): Promise<AuthChallengeRecord | null> {
    const row = await this.sql.first<AuthChallengeRow>(
      `SELECT id, email, code_hash, attempts, created_at, expires_at
       FROM auth_challenges WHERE email = ? ORDER BY created_at DESC LIMIT 1`,
      [email],
    );
    return row ? authChallengeFromRow(row) : null;
  }

  async getAuthChallenge(id: string, email: string): Promise<AuthChallengeRecord | null> {
    const row = await this.sql.first<AuthChallengeRow>(
      `SELECT id, email, code_hash, attempts, created_at, expires_at
       FROM auth_challenges WHERE id = ? AND email = ?`,
      [id, email],
    );
    return row ? authChallengeFromRow(row) : null;
  }

  async incrementAuthChallengeAttempts(id: string, maxAttempts?: number): Promise<boolean> {
    // PostgreSQL 会按 attempts 的 int4 类型推断比较参数；无上限调用不能绑定超出 int4 范围的 Number.MAX_SAFE_INTEGER。
    const result = maxAttempts === undefined
      ? await this.sql.run("UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ?", [id])
      : await this.sql.run(
        "UPDATE auth_challenges SET attempts = attempts + 1 WHERE id = ? AND attempts < ?",
        [id, maxAttempts],
      );
    return result.changes > 0;
  }

  async deleteAuthChallenge(id: string): Promise<boolean> {
    const result = await this.sql.run("DELETE FROM auth_challenges WHERE id = ?", [id]);
    return result.changes > 0;
  }

  async isPortableTargetEmpty(): Promise<boolean> {
    const tables = [
      "items", "uploads", "shares", "share_members", "local_sessions", "auth_challenges", "share_attempts",
    ];
    for (const table of tables) {
      const row = await this.sql.first<{ count_value: number }>(`SELECT COUNT(*) AS count_value FROM ${table}`);
      if (Number(row?.count_value || 0) > 0) return false;
    }
    return true;
  }

  async listPortableItems(): Promise<StoredItem[]> {
    const rows = await this.sql.all<ItemRow>(
      `SELECT ${ITEM_COLUMNS} FROM items ORDER BY owner_id ASC, created_at ASC, id ASC`,
    );
    return rows.map(itemFromRow);
  }

  async listPortableShares(): Promise<StoredShare[]> {
    const rows = await this.sql.all<ShareRow>(
      `SELECT ${SHARE_COLUMNS} FROM shares ORDER BY created_at ASC, id ASC`,
    );
    return this.sharesFromRows(rows);
  }

  async listPortablePendingUploads(): Promise<UploadRecord[]> {
    const rows = await this.sql.all<UploadRow>(
      `SELECT ${UPLOAD_COLUMNS} FROM uploads
       WHERE status IN ('uploading', 'cancelling', 'expiring')
       ORDER BY created_at ASC, id ASC`,
    );
    return rows.map(uploadFromRow);
  }

  async discardPortableUpload(ownerId: string, id: string): Promise<void> {
    await this.sql.run("DELETE FROM uploads WHERE owner_id = ? AND id = ?", [ownerId, id]);
  }

  async importPortableItem(item: StoredItem): Promise<void> {
    await this.sql.run(
      `INSERT OR IGNORE INTO items (
        id, owner_id, type, content, title, object_key, original_name,
        display_name, mime_type, size_bytes, favorite, created_at, updated_at, deleted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        item.id, item.ownerId, item.type, item.content, item.title, item.objectKey,
        item.originalName, item.displayName, item.mimeType, item.sizeBytes,
        item.favorite ? 1 : 0, item.createdAt, item.updatedAt, item.deletedAt,
      ],
    );
  }

  async importPortableShare(share: StoredShare): Promise<void> {
    const legacyItemId = share.members[0]?.itemId;
    if (!legacyItemId) return;
    const statements: Array<{ sql: string; params?: SqlValue[] }> = [{
      sql:
      `INSERT OR IGNORE INTO shares (
        id, owner_id, name, item_id, token_hash, access_mode, code_hash, code_encrypted,
        created_at, expires_at, revoked_at, access_count, download_count, last_accessed_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      params: [
        share.id, share.ownerId, share.name, legacyItemId, share.tokenHash, share.accessMode,
        share.codeHash, share.codeEncrypted, share.createdAt, share.expiresAt, share.revokedAt,
        share.accessCount, share.downloadCount, share.lastAccessedAt,
      ],
    }];
    for (const member of share.members) {
      statements.push({
        sql: `INSERT OR IGNORE INTO share_members (
          share_id, item_id, position, added_at, removed_at, removal_reason, download_count
        ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
        params: [
          share.id, member.itemId, member.position, member.addedAt, member.removedAt,
          member.removalReason, member.downloadCount,
        ],
      });
    }
    await this.sql.batch(statements);
  }

  async preparePortableImport(migrationId: string, now: number, blobsEmpty: boolean): Promise<"new" | "resume" | "rejected"> {
    const state = await this.sql.first<{ id: string; status: string }>(
      "SELECT id, status FROM migration_state LIMIT 1",
    );
    if (state) return state.id === migrationId && state.status === "in_progress" ? "resume" : "rejected";
    if (!blobsEmpty || !(await this.isPortableTargetEmpty())) return "rejected";
    await this.sql.run(
      "INSERT INTO migration_state (id, status, created_at, updated_at) VALUES (?, 'in_progress', ?, ?)",
      [migrationId, now, now],
    );
    return "new";
  }

  async finishPortableImport(migrationId: string, now: number): Promise<void> {
    const result = await this.sql.run(
      `UPDATE migration_state SET status = 'complete', updated_at = ?
       WHERE id = ? AND status = 'in_progress'`,
      [now, migrationId],
    );
    if (result.changes === 0) throw new Error("迁移状态不存在或已结束");
  }

  async deleteExpiredSessions(now: number): Promise<void> {
    await this.sql.run("DELETE FROM local_sessions WHERE expires_at <= ?", [now]);
    await this.sql.run("DELETE FROM auth_challenges WHERE expires_at <= ?", [now]);
  }
}
