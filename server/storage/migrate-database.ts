import { createConnection } from "mysql2/promise";
import { Client } from "pg";
import { drizzle as mysqlDrizzle } from "drizzle-orm/mysql2";
import { migrate as migrateMySql } from "drizzle-orm/mysql2/migrator";
import { drizzle as postgresDrizzle } from "drizzle-orm/node-postgres";
import { migrate as migratePostgres } from "drizzle-orm/node-postgres/migrator";
import {
  relationalDatabaseUrl,
  relationalTlsOptions,
  type RelationalDriver,
} from "../../api/stores/relational";
import { parseDatabaseDriver } from "../../api/runtime-config";

function configuredDriver(): RelationalDriver {
  return parseDatabaseDriver(process.env.DATABASE_DRIVER);
}

export async function migrateConfiguredDatabase(): Promise<void> {
  const driver = configuredDriver();
  if (driver === "sqlite") {
    console.log("SQLite 在本地启动时应用幂等架构；无需单独迁移命令。");
    return;
  }
  const url = relationalDatabaseUrl(driver);
  const ssl = await relationalTlsOptions(url);
  if (driver === "postgres") {
    const client = new Client({ connectionString: url.toString(), ssl });
    await client.connect();
    try {
      await migratePostgres(postgresDrizzle(client), { migrationsFolder: "./drizzle/postgres" });
    } finally {
      await client.end();
    }
    console.log("PostgreSQL 架构迁移完成。");
    return;
  }

  const connection = await createConnection({
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database: decodeURIComponent(url.pathname.replace(/^\//, "")),
    ssl: ssl || undefined,
    supportBigNumbers: true,
    bigNumberStrings: false,
  });
  try {
    await migrateMySql(mysqlDrizzle(connection), { migrationsFolder: "./drizzle/mysql" });
  } finally {
    await connection.end();
  }
  console.log("MySQL 架构迁移完成。");
}
