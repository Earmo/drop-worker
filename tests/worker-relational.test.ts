import assert from "node:assert/strict";
import test from "node:test";
import { relationalSql } from "../api/stores/relational-executor";
import {
  openWorkerRelationalMetadataStore,
  type WorkerMySqlConnectionOptions,
  type WorkerRelationalClientFactory,
} from "../worker/storage/relational-metadata";

function fakeClient(version: string | number, closed: { count: number }) {
  return {
    query: async (sql: string) => {
      if (sql === "SHOW server_version_num") {
        return { rows: [{ server_version_num: version }], changes: 0 };
      }
      if (sql === "SELECT VERSION() AS version") {
        return { rows: [{ version }], changes: 0 };
      }
      return { rows: [{ healthy: 1 }], changes: 0 };
    },
    batch: async (statements: Array<{ sql: string }>) => statements.map(() => ({ changes: 0 })),
    close: async () => {
      closed.count += 1;
    },
  };
}

const hyperdrive = {
  connectionString: "postgresql://hyperdrive.internal/dropworker",
  host: "hyperdrive.internal",
  port: 3306,
  user: "dropworker",
  password: "binding-password",
  database: "dropworker",
};

test("Worker PostgreSQL 使用 Hyperdrive 连接字符串并按请求关闭客户端", async () => {
  const closed = { count: 0 };
  let receivedConnectionString = "";
  const factory: WorkerRelationalClientFactory = {
    openPostgres: async (connectionString) => {
      receivedConnectionString = connectionString;
      return fakeClient(140_000, closed);
    },
    openMySql: async () => {
      throw new Error("不应创建 MySQL 客户端");
    },
  };

  const opened = await openWorkerRelationalMetadataStore("postgres", hyperdrive, factory);
  assert.equal(receivedConnectionString, hyperdrive.connectionString);
  await assert.doesNotReject(opened.store.healthCheck());
  await opened.close();
  assert.equal(closed.count, 1);
});

test("Worker MySQL 强制使用 mysql2 的无 eval 模式", async () => {
  const closed = { count: 0 };
  let receivedOptions: WorkerMySqlConnectionOptions | undefined;
  const factory: WorkerRelationalClientFactory = {
    openPostgres: async () => {
      throw new Error("不应创建 PostgreSQL 客户端");
    },
    openMySql: async (options) => {
      receivedOptions = options;
      return fakeClient("8.4.0", closed);
    },
  };

  const opened = await openWorkerRelationalMetadataStore("mysql", hyperdrive, factory);
  assert.deepEqual(receivedOptions, {
    host: hyperdrive.host,
    port: hyperdrive.port,
    user: hyperdrive.user,
    password: hyperdrive.password,
    database: hyperdrive.database,
    disableEval: true,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  await opened.close();
  assert.equal(closed.count, 1);
});

test("Worker 外部数据库拒绝缺失绑定和不受支持的服务端版本", async () => {
  await assert.rejects(
    openWorkerRelationalMetadataStore("postgres", undefined),
    /HYPERDRIVE/,
  );

  const closed = { count: 0 };
  const factory: WorkerRelationalClientFactory = {
    openPostgres: async () => fakeClient(130_000, closed),
    openMySql: async () => fakeClient("10.11.0-MariaDB", closed),
  };
  await assert.rejects(
    openWorkerRelationalMetadataStore("postgres", hyperdrive, factory),
    /PostgreSQL 版本必须为 14/,
  );
  await assert.rejects(
    openWorkerRelationalMetadataStore("mysql", hyperdrive, factory),
    /当前不支持 MariaDB/,
  );
  assert.equal(closed.count, 2);
});

test("Node 与 Worker 共用关系型 SQL 方言转换", () => {
  assert.equal(
    relationalSql("postgres", "SELECT * FROM items WHERE owner_id = ? AND id = ?"),
    "SELECT * FROM items WHERE owner_id = $1 AND id = $2",
  );
  assert.equal(
    relationalSql("mysql", "INSERT OR IGNORE INTO schema_version (id) VALUES (?)"),
    "INSERT IGNORE INTO schema_version (id) VALUES (?)",
  );
});
