import { createConnection, type ResultSetHeader } from "mysql2/promise";
import { Client, types as postgresTypes } from "pg";
import {
  createRelationalMetadataStore,
  type ExternalDatabaseDriver,
  type RelationalBatch,
  type RelationalQuery,
} from "../../api/stores/relational-executor";
import type { SqlMetadataStore } from "../../api/stores/sql-metadata";

/** Worker 通过 Hyperdrive 连接数据库时所需的只读绑定字段。 */
export type WorkerHyperdriveBinding = Pick<
  Hyperdrive,
  "connectionString" | "host" | "port" | "user" | "password" | "database"
>;

/** MySQL Worker 客户端的安全连接参数；disableEval 是 mysql2 在 Workers 中的兼容要求。 */
export type WorkerMySqlConnectionOptions = {
  host: string;
  port: number;
  user: string;
  password: string;
  database: string;
  disableEval: true;
  supportBigNumbers: true;
  bigNumberStrings: false;
};

type WorkerRelationalClient = {
  query: RelationalQuery;
  batch: RelationalBatch;
  close(): Promise<void>;
};

/**
 * 可注入的 Worker 数据库客户端工厂。生产实现使用 pg/mysql2，测试可提供无网络替身。
 */
export type WorkerRelationalClientFactory = {
  openPostgres(connectionString: string): Promise<WorkerRelationalClient>;
  openMySql(options: WorkerMySqlConnectionOptions): Promise<WorkerRelationalClient>;
};

/** 已连接的 Worker 元数据存储；请求结束时调用方必须执行 close。 */
export type OpenWorkerRelationalStore = {
  store: SqlMetadataStore;
  close(): Promise<void>;
};

async function openPostgresClient(connectionString: string): Promise<WorkerRelationalClient> {
  postgresTypes.setTypeParser(postgresTypes.builtins.INT8, Number);
  const client = new Client({ connectionString });
  try {
    await client.connect();
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  const query: RelationalQuery = async (sql, params = []) => {
    const result = await client.query<Record<string, unknown>>(sql, params);
    return { rows: result.rows, changes: result.rowCount ?? 0 };
  };
  const batch: RelationalBatch = async (statements) => {
    try {
      await client.query("BEGIN");
      const results: Array<{ changes: number }> = [];
      for (const statement of statements) {
        const result = await client.query(statement.sql, statement.params || []);
        results.push({ changes: result.rowCount ?? 0 });
      }
      await client.query("COMMIT");
      return results;
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  };
  return { query, batch, close: () => client.end() };
}

async function openMySqlClient(options: WorkerMySqlConnectionOptions): Promise<WorkerRelationalClient> {
  const connection = await createConnection(options);
  const query: RelationalQuery = async (sql, params = []) => {
    const [result] = await connection.query(sql, params);
    return {
      rows: Array.isArray(result) ? result as Array<Record<string, unknown>> : [],
      changes: (result as ResultSetHeader).affectedRows ?? 0,
    };
  };
  const batch: RelationalBatch = async (statements) => {
    try {
      await connection.beginTransaction();
      const results: Array<{ changes: number }> = [];
      for (const statement of statements) {
        const [result] = await connection.query(statement.sql, statement.params || []);
        results.push({ changes: (result as ResultSetHeader).affectedRows ?? 0 });
      }
      await connection.commit();
      return results;
    } catch (error) {
      await connection.rollback();
      throw error;
    }
  };
  return { query, batch, close: () => connection.end() };
}

const defaultClientFactory: WorkerRelationalClientFactory = {
  openPostgres: openPostgresClient,
  openMySql: openMySqlClient,
};

function validateHyperdriveBinding(binding: WorkerHyperdriveBinding | undefined): WorkerHyperdriveBinding {
  if (!binding) throw new Error("MySQL/PostgreSQL 模式必须配置 HYPERDRIVE 绑定");
  if (
    !binding.connectionString
    || !binding.host
    || !binding.user
    || !binding.database
    || !Number.isInteger(binding.port)
    || binding.port <= 0
  ) {
    throw new Error("HYPERDRIVE 绑定缺少有效的数据库连接信息");
  }
  return binding;
}

/**
 * 为一个 Worker 请求打开 MySQL 或 PostgreSQL 元数据连接。
 * Hyperdrive 负责底层连接池，应用连接只活到当前请求结束，避免跨隔离实例共享可变客户端。
 */
export async function openWorkerRelationalMetadataStore(
  driver: ExternalDatabaseDriver,
  hyperdrive: WorkerHyperdriveBinding | undefined,
  factory: WorkerRelationalClientFactory = defaultClientFactory,
): Promise<OpenWorkerRelationalStore> {
  const binding = validateHyperdriveBinding(hyperdrive);
  const client = driver === "postgres"
    ? await factory.openPostgres(binding.connectionString)
    : await factory.openMySql({
        host: binding.host,
        port: binding.port,
        user: binding.user,
        password: binding.password,
        database: binding.database,
        // mysql2 默认会生成函数；Workers 禁止 eval，因此必须切换到解释执行路径。
        disableEval: true,
        supportBigNumbers: true,
        bigNumberStrings: false,
      });
  try {
    if (driver === "postgres") {
      const version = await client.query("SHOW server_version_num");
      if (Number(version.rows[0]?.server_version_num || 0) < 140_000) {
        throw new Error("PostgreSQL 版本必须为 14 或更高");
      }
    } else {
      const versionResult = await client.query("SELECT VERSION() AS version");
      const version = String(versionResult.rows[0]?.version || "");
      const major = Number(/^([0-9]+)/.exec(version)?.[1] || 0);
      if (major < 8 || /mariadb/i.test(version)) {
        throw new Error("数据库必须为 MySQL 8.0 或更高，当前不支持 MariaDB");
      }
    }
  } catch (error) {
    await client.close().catch(() => undefined);
    throw error;
  }
  return {
    store: createRelationalMetadataStore(driver, client.query, client.batch),
    close: client.close,
  };
}
