// 本地 SQLite 和 Cloudflare D1 共用这组幂等建表语句；正式生产迁移文件仍由 Drizzle 管理。
export const schemaStatements = [
  // items 保存文本、链接和已完成文件的统一元数据；deleted_at 为 NULL 表示活动内容。
  `CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    type TEXT NOT NULL CHECK (type IN ('text', 'link', 'file')),
    content TEXT,
    title TEXT,
    object_key TEXT,
    original_name TEXT,
    display_name TEXT,
    mime_type TEXT,
    size_bytes INTEGER NOT NULL DEFAULT 0,
    favorite INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER
  )`,
  // 时间流、回收站、收藏和类型筛选都以 owner_id 为第一列，避免跨用户扫描。
  `CREATE INDEX IF NOT EXISTS idx_items_owner_created ON items(owner_id, created_at)`,
  `CREATE INDEX IF NOT EXISTS idx_items_owner_deleted ON items(owner_id, deleted_at)`,
  `CREATE INDEX IF NOT EXISTS idx_items_owner_favorite ON items(owner_id, favorite)`,
  `CREATE INDEX IF NOT EXISTS idx_items_owner_type ON items(owner_id, type)`,
  // uploads 保存 multipart 会话和已完成分片；parts_json 让断点续传可在不同存储适配器间共享。
  `CREATE TABLE IF NOT EXISTS uploads (
    id TEXT PRIMARY KEY,
    owner_id TEXT NOT NULL,
    object_key TEXT NOT NULL,
    provider_upload_id TEXT NOT NULL,
    file_name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    fingerprint TEXT NOT NULL,
    parts_json TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'uploading',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_uploads_owner_status ON uploads(owner_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_uploads_expires ON uploads(expires_at)`,
  // 本地和 Cloudflare 邮箱登录都使用同一会话表，token_hash 不保存浏览器 Cookie 原文。
  `CREATE TABLE IF NOT EXISTS local_sessions (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL UNIQUE,
    owner_id TEXT NOT NULL,
    email TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_local_sessions_expires ON local_sessions(expires_at)`,
  // auth_challenges 只保存验证码摘要、尝试次数和过期时间，不保存明文验证码。
  `CREATE TABLE IF NOT EXISTS auth_challenges (
    id TEXT PRIMARY KEY,
    email TEXT NOT NULL,
    code_hash TEXT NOT NULL,
    attempts INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_auth_challenges_expires ON auth_challenges(expires_at)`,
] as const;
