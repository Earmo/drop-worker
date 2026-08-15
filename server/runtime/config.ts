import { resolve } from "node:path";
import {
  DEFAULT_QUOTA_BYTES,
  parseBlobDriver,
  parseDatabaseDriver,
  positiveInteger,
  type BlobDriver,
  type DatabaseDriver,
} from "../../api/runtime-config";
import { localAuthConfigFromEnv, type LocalAuthConfig } from "../auth/local-auth";

export type NodeDatabaseDriver = DatabaseDriver;
export type NodeBlobDriver = BlobDriver;

export type NodeRuntimeConfig = {
  dataRoot: string;
  databaseDriver: NodeDatabaseDriver;
  blobDriver: NodeBlobDriver;
  quotaBytes: number;
  sharingEnabled: boolean;
  trustProxy?: string;
  host: string;
  port: number;
  auth: LocalAuthConfig;
};

function databaseDriverFromEnv(): NodeDatabaseDriver {
  return parseDatabaseDriver(process.env.DATABASE_DRIVER);
}

function blobDriverFromEnv(): NodeBlobDriver {
  return parseBlobDriver(process.env.BLOB_DRIVER);
}

function portFromEnv(): number {
  const port = positiveInteger("PORT", process.env.PORT, 3000);
  if (port > 65_535) throw new Error("PORT 超出有效范围");
  return port;
}

/**
 * Node.js 运行时的唯一配置入口。具体 adapter 接收已经选择的驱动，
 * 认证、配额和监听参数不会在请求处理中再次读取环境变量。
 */
export function loadNodeRuntimeConfig(): NodeRuntimeConfig {
  const auth = localAuthConfigFromEnv();
  const dataRoot = resolve(process.cwd(), process.env.DATA_DIR || "./data");
  const quotaBytes = positiveInteger("MAX_STORAGE_BYTES", process.env.MAX_STORAGE_BYTES, DEFAULT_QUOTA_BYTES);
  return {
    dataRoot,
    databaseDriver: databaseDriverFromEnv(),
    blobDriver: blobDriverFromEnv(),
    quotaBytes,
    sharingEnabled: process.env.SHARING_ENABLED !== "false",
    trustProxy: process.env.TRUST_PROXY,
    host: process.env.HOST || "0.0.0.0",
    port: portFromEnv(),
    auth,
  };
}
