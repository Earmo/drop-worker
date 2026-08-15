import { readFile } from "node:fs/promises";
import { isIP } from "node:net";
import { createPool as createMySqlPool, type Pool as MySqlPool, type ResultSetHeader } from "mysql2/promise";
import { Pool as PostgresPool, types as postgresTypes, type PoolClient } from "pg";
import { SqlMetadataStore, type SqlExecutor, type SqlValue } from "./sql-metadata";
import { openLocalMetadataStore } from "./local";
import { parseDatabaseDriver, type DatabaseDriver } from "../runtime-config";

export type RelationalDriver = DatabaseDriver;

export type OpenRelationalStore = {
  driver: RelationalDriver;
  store: SqlMetadataStore;
  close(): Promise<void>;
};

function loopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1";
}

export async function relationalTlsOptions(url: URL): Promise<false | { rejectUnauthorized: true; ca?: string }> {
  if (loopbackHost(url.hostname)) return false;
  if (process.env.DATABASE_ALLOW_INSECURE === "true") {
    console.warn("警告：外部数据库连接已显式允许明文传输。");
    return false;
  }
  const caPath = process.env.DATABASE_CA_FILE?.trim();
  return {
    rejectUnauthorized: true,
    ...(caPath ? { ca: await readFile(caPath, "utf8") } : {}),
  };
}

export function relationalPoolSize(): number {
  const value = Number(process.env.DATABASE_POOL_SIZE || 10);
  if (!Number.isInteger(value) || value < 1 || value > 50) {
    throw new Error("DATABASE_POOL_SIZE 必须是 1 到 50 的整数");
  }
  return value;
}

function postgresSql(sql: string): string {
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

function mysqlSql(sql: string): string {
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

class PostgresExecutor implements SqlExecutor {
  constructor(private readonly pool: PostgresPool) {}

  async tableExists(name: string): Promise<boolean> {
    const result = await this.pool.query<{ exists: boolean }>(
      `SELECT EXISTS (
        SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = $1
      ) AS exists`,
      [name],
    );
    return result.rows[0]?.exists === true;
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    return (await this.pool.query<T & Record<string, unknown>>(postgresSql(sql), params)).rows as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const result = await this.pool.query(postgresSql(sql), params);
    return { changes: result.rowCount ?? 0 };
  }

  async batch(statements: Array<{ sql: string; params?: SqlValue[] }>): Promise<Array<{ changes: number }>> {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const results = await runPostgresBatch(client, statements);
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
}

async function runPostgresBatch(
  client: PoolClient,
  statements: Array<{ sql: string; params?: SqlValue[] }>,
): Promise<Array<{ changes: number }>> {
  const results: Array<{ changes: number }> = [];
  for (const statement of statements) {
    const result = await client.query(postgresSql(statement.sql), statement.params || []);
    results.push({ changes: result.rowCount ?? 0 });
  }
  return results;
}

class MySqlExecutor implements SqlExecutor {
  constructor(private readonly pool: MySqlPool) {}

  async tableExists(name: string): Promise<boolean> {
    const [rows] = await this.pool.query(
      `SELECT 1 AS present FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = ? LIMIT 1`,
      [name],
    );
    return Array.isArray(rows) && rows.length > 0;
  }

  async all<T>(sql: string, params: SqlValue[] = []): Promise<T[]> {
    const [rows] = await this.pool.query(mysqlSql(sql), params);
    return rows as T[];
  }

  async first<T>(sql: string, params: SqlValue[] = []): Promise<T | null> {
    return (await this.all<T>(sql, params))[0] ?? null;
  }

  async run(sql: string, params: SqlValue[] = []): Promise<{ changes: number }> {
    const [result] = await this.pool.query(mysqlSql(sql), params);
    return { changes: (result as ResultSetHeader).affectedRows ?? 0 };
  }

  async batch(statements: Array<{ sql: string; params?: SqlValue[] }>): Promise<Array<{ changes: number }>> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const results: Array<{ changes: number }> = [];
      for (const statement of statements) {
        const [result] = await connection.query(mysqlSql(statement.sql), statement.params || []);
        results.push({ changes: (result as ResultSetHeader).affectedRows ?? 0 });
      }
      await connection.commit();
      return results;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }
  }
}

export function relationalDatabaseUrl(expected: RelationalDriver): URL {
  const value = process.env.DATABASE_URL?.trim();
  if (!value) throw new Error(`${expected} 模式缺少 DATABASE_URL`);
  const url = new URL(value);
  const allowed = expected === "mysql" ? ["mysql:"] : ["postgres:", "postgresql:"];
  if (!allowed.includes(url.protocol)) throw new Error(`DATABASE_URL 与 DATABASE_DRIVER=${expected} 不匹配`);
  if (!url.hostname || (!isIP(url.hostname) && !/^[a-z0-9.-]+$/i.test(url.hostname))) {
    throw new Error("DATABASE_URL 主机名无效");
  }
  return url;
}

async function openPostgres(): Promise<OpenRelationalStore> {
  const url = relationalDatabaseUrl("postgres");
  postgresTypes.setTypeParser(postgresTypes.builtins.INT8, Number);
  const pool = new PostgresPool({
    connectionString: url.toString(),
    max: relationalPoolSize(),
    ssl: await relationalTlsOptions(url),
  });
  const version = await pool.query<{ server_version_num: string }>("SHOW server_version_num");
  if (Number(version.rows[0]?.server_version_num || 0) < 140_000) {
    await pool.end();
    throw new Error("PostgreSQL 版本必须为 14 或更高");
  }
  return {
    driver: "postgres",
    store: new SqlMetadataStore(new PostgresExecutor(pool), false),
    close: () => pool.end(),
  };
}

async function openMySql(): Promise<OpenRelationalStore> {
  const url = relationalDatabaseUrl("mysql");
  const tls = await relationalTlsOptions(url);
  const pool = createMySqlPool({
    uri: url.toString(),
    connectionLimit: relationalPoolSize(),
    supportBigNumbers: true,
    bigNumberStrings: false,
    ssl: tls || undefined,
  });
  const [rows] = await pool.query("SELECT VERSION() AS version");
  const version = Array.isArray(rows) ? String((rows[0] as { version?: unknown } | undefined)?.version || "") : "";
  const major = Number(/^([0-9]+)/.exec(version)?.[1] || 0);
  if (major < 8 || /mariadb/i.test(version)) {
    await pool.end();
    throw new Error("数据库必须为 MySQL 8.0 或更高，当前不支持 MariaDB");
  }
  return {
    driver: "mysql",
    store: new SqlMetadataStore(new MySqlExecutor(pool), false),
    close: () => pool.end(),
  };
}

export async function openRelationalMetadataStore(
  databasePath: string,
  configuredDriver?: "sqlite" | "mysql" | "postgres",
): Promise<OpenRelationalStore> {
  const driver = parseDatabaseDriver(configuredDriver || process.env.DATABASE_DRIVER);
  if (driver === "sqlite") {
    const sqlite = openLocalMetadataStore(databasePath);
    return {
      driver: "sqlite",
      store: sqlite.store,
      close: async () => sqlite.close(),
    };
  }
  if (driver === "postgres") return openPostgres();
  return openMySql();
}
