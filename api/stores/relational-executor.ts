import type { DatabaseDriver } from "../runtime-config";
import { SqlMetadataStore, type SqlExecutor, type SqlValue } from "./sql-metadata";

/** 需要客户端连接的外部关系型数据库驱动。 */
export type ExternalDatabaseDriver = Exclude<DatabaseDriver, "sqlite">;

/**
 * 数据库客户端查询后的平台无关结果。rows 用于读取，changes 用于写操作计数。
 */
export type RelationalQueryResult = {
  rows: Array<Record<string, unknown>>;
  changes: number;
};

/** 由 Node 连接池或 Worker 单请求连接提供的最小查询能力。 */
export type RelationalQuery = (
  sql: string,
  params?: SqlValue[],
) => Promise<RelationalQueryResult>;

/**
 * 在一个数据库事务中顺序执行语句；失败时实现方必须回滚全部语句。
 */
export type RelationalBatch = (
  statements: Array<{ sql: string; params?: SqlValue[] }>,
) => Promise<Array<{ changes: number }>>;

/**
 * 把应用内部使用的 SQLite 风格 SQL 改写成目标数据库方言。
 * 参数值始终由客户端绑定，只有固定语法和占位符会被转换。
 */
export function relationalSql(driver: ExternalDatabaseDriver, sql: string): string {
  if (driver === "mysql") {
    let statement = sql.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT IGNORE INTO");
    if (/ON\s+CONFLICT\s*\(share_id,\s*source_hash\)/i.test(statement)) {
      statement = statement.replace(
        /ON\s+CONFLICT\s*\(share_id,\s*source_hash\)\s+DO\s+UPDATE\s+SET[\s\S]*$/i,
        `ON DUPLICATE KEY UPDATE
          failures = VALUES(failures),
          locked_until = VALUES(locked_until),
          updated_at = VALUES(updated_at)`,
      );
    }
    return statement;
  }

  let statement = sql;
  let ignoreConflict = false;
  if (/INSERT\s+OR\s+IGNORE\s+INTO/i.test(statement)) {
    statement = statement.replace(/INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO");
    ignoreConflict = true;
  }
  let index = 0;
  statement = statement.replace(/\?/g, () => `$${++index}`);
  if (ignoreConflict) statement = `${statement.trim()} ON CONFLICT DO NOTHING`;
  return statement;
}

class RelationalExecutor implements SqlExecutor {
  constructor(
    private readonly driver: ExternalDatabaseDriver,
    private readonly query: RelationalQuery,
    private readonly runBatch: RelationalBatch,
  ) {}

  async tableExists(name: string): Promise<boolean> {
    if (this.driver === "postgres") {
      const result = await this.query(
        `SELECT EXISTS (
          SELECT 1 FROM information_schema.tables
          WHERE table_schema = current_schema() AND table_name = $1
        ) AS exists`,
        [name],
      );
      return result.rows[0]?.exists === true;
    }
    const result = await this.query(
      `SELECT 1 AS present FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
      [name],
    );
    return result.rows.length > 0;
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return (await this.query(relationalSql(this.driver, sql), params)).rows as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const result = await this.query(relationalSql(this.driver, sql), params);
    return { changes: result.changes };
  }

  async batch(
    statements: Array<{ sql: string; params?: SqlValue[] }>,
  ): Promise<Array<{ changes: number }>> {
    return this.runBatch(statements.map((statement) => ({
      sql: relationalSql(this.driver, statement.sql),
      params: statement.params,
    })));
  }
}

/**
 * 用具体客户端提供的查询和事务函数创建应用元数据存储。
 * 外部数据库永不自动执行 DDL，调用方必须先应用正式迁移。
 */
export function createRelationalMetadataStore(
  driver: ExternalDatabaseDriver,
  query: RelationalQuery,
  batch: RelationalBatch,
): SqlMetadataStore {
  return new SqlMetadataStore(new RelationalExecutor(driver, query, batch), false);
}
