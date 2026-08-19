import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import test from "node:test";

type TableDefinition = {
  name: string;
  columns: string[];
};

/**
 * 从基线迁移提取表和字段，确保注释检查会自动覆盖后续新增的数据库对象。
 */
function tableDefinitions(sql: string): TableDefinition[] {
  return [...sql.matchAll(/CREATE TABLE ["`]([^"`]+)["`] \(([\s\S]*?)\n\);/g)].map((match) => ({
    name: match[1],
    columns: [...match[2].matchAll(/^\s*["`]([^"`]+)["`]\s+/gm)].map((column) => column[1]),
  }));
}

function escaped(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function migrationSql(dialect: "postgres" | "mysql"): Promise<{ definitions: TableDefinition[]; comments: string }> {
  const directory = new URL(`../drizzle/${dialect}/`, import.meta.url);
  const files = (await readdir(directory)).filter((file) => file.endsWith(".sql")).sort();
  const contents = await Promise.all(files.map((file) => readFile(new URL(file, directory), "utf8")));
  return { definitions: contents.flatMap(tableDefinitions), comments: contents.join("\n") };
}

test("PostgreSQL 迁移为每张表和每个字段设置非空注释", async () => {
  const { definitions, comments } = await migrationSql("postgres");

  for (const table of definitions) {
    const tableName = escaped(table.name);
    assert.match(comments, new RegExp(`COMMENT ON TABLE "${tableName}" IS '[^']+';`));
    for (const column of table.columns) {
      assert.match(
        comments,
        new RegExp(`COMMENT ON COLUMN "${tableName}"\\."${escaped(column)}" IS '[^']+';`),
      );
    }
  }
});

test("MySQL 迁移为每张表和每个字段设置非空注释", async () => {
  const { definitions, comments } = await migrationSql("mysql");

  for (const table of definitions) {
    const tableName = escaped(table.name);
    const statement = new RegExp("ALTER TABLE `" + tableName + "`([\\s\\S]*?);").exec(comments)?.[1];
    assert.ok(statement, `${table.name} 缺少 ALTER TABLE 注释语句`);
    assert.match(statement, /COMMENT = '[^']+'/);
    for (const column of table.columns) {
      assert.match(statement, new RegExp("MODIFY COLUMN `" + escaped(column) + "`[^\\n]+ COMMENT '[^']+'"));
    }
  }
});
