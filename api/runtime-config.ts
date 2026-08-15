/** 应用运行时之间共享的、与平台无关的配置解析规则。 */
export const DEFAULT_QUOTA_BYTES = 10 * 1024 * 1024 * 1024;

export type DatabaseDriver = "sqlite" | "mysql" | "postgres";
export type BlobDriver = "local" | "s3";

export function positiveInteger(name: string, value: string | undefined, fallback: number): number {
  const parsed = value === undefined || value.trim() === "" ? fallback : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} 必须是正整数`);
  return parsed;
}

export function parseDatabaseDriver(value: string | undefined): DatabaseDriver {
  const normalized = (value || "sqlite").trim().toLocaleLowerCase();
  if (normalized === "sqlite" || normalized === "mysql" || normalized === "postgres") return normalized;
  throw new Error("DATABASE_DRIVER 必须是 sqlite、mysql 或 postgres");
}

export function parseBlobDriver(value: string | undefined): BlobDriver {
  const normalized = (value || "local").trim().toLocaleLowerCase();
  if (normalized === "local" || normalized === "s3") return normalized;
  throw new Error("BLOB_DRIVER 必须是 local 或 s3");
}
