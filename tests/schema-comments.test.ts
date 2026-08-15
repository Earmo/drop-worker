import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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

test("PostgreSQL 基线为每张表和每个字段设置非空注释", async () => {
  const baseline = await readFile(new URL("../drizzle/postgres/0000_initial-baseline.sql", import.meta.url), "utf8");
  const comments = baseline;

  for (const table of tableDefinitions(baseline)) {
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

test("MySQL 基线为每张表和每个字段设置非空注释", async () => {
  const baseline = await readFile(new URL("../drizzle/mysql/0000_initial-baseline.sql", import.meta.url), "utf8");
  const comments = baseline;

  for (const table of tableDefinitions(baseline)) {
    const tableName = escaped(table.name);
    const statement = new RegExp("ALTER TABLE `" + tableName + "`([\\s\\S]*?);").exec(comments)?.[1];
    assert.ok(statement, `${table.name} 缺少 ALTER TABLE 注释语句`);
    assert.match(statement, /COMMENT = '[^']+'/);
    for (const column of table.columns) {
      assert.match(statement, new RegExp("MODIFY COLUMN `" + escaped(column) + "`[^\\n]+ COMMENT '[^']+'"));
    }
  }
});
