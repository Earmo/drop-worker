import { EmailOtpAuth } from "../../api/auth";
import { createAppContext } from "../../api/context";
import { createD1MetadataStore, R2BlobStore } from "../../api/stores/cloudflare";
import type { AppContext, AuthProvider, MetadataStore } from "../../api/platform";
import { createS3BlobStoreFromEnv, S3BlobStore } from "../../api/stores/s3";
import { WorkerSmtpMailSender } from "../auth/smtp";
import { R2DirectUploadService } from "../storage/r2-direct-uploads";
import { openWorkerRelationalMetadataStore } from "../storage/relational-metadata";
import { loadCloudflareRuntimeConfig } from "./config";

/** Worker 请求所拥有的服务与数据库连接；请求结束时必须关闭。 */
export type CloudflareRuntime = {
  services: AppContext;
  close(): Promise<void>;
};

/**
 * Cloudflare 组合根。D1 只创建轻量适配器；外部数据库按请求创建客户端，
 * 底层连接复用交给 Hyperdrive，并通过 close 明确限制客户端生命周期。
 */
export async function createCloudflareRuntime(env: Env): Promise<CloudflareRuntime> {
  const config = loadCloudflareRuntimeConfig(env);
  let metadata: MetadataStore;
  let closeMetadata: () => Promise<void>;
  if (config.databaseDriver === "sqlite") {
    if (!env.DB) throw new Error("SQLite 模式必须配置 DB D1 绑定");
    metadata = createD1MetadataStore(env.DB);
    closeMetadata = async () => undefined;
  } else {
    const relational = await openWorkerRelationalMetadataStore(config.databaseDriver, env.HYPERDRIVE);
    metadata = relational.store;
    closeMetadata = relational.close;
  }
  const emailAuth = config.authMode === "smtp-otp" && config.smtp && config.ownerEmail
    ? new EmailOtpAuth(
        metadata,
        {
          email: config.ownerEmail,
          from: { address: config.smtp.from, name: config.smtp.fromName },
          sessionSecret: config.authSessionSecret,
          secureCookie: true,
          // 保留 Worker 现有 owner ID 前缀，避免历史文件因切换认证实现而失去归属。
          ownerIdPrefix: "email",
        },
        new WorkerSmtpMailSender(config.smtp),
      )
    : null;
  let blobs: R2BlobStore | S3BlobStore;
  if (config.blobDriver === "r2") {
    if (!env.FILES) {
      await closeMetadata();
      throw new Error("Worker R2 模式必须配置 FILES 绑定");
    }
    blobs = new R2BlobStore(env.FILES);
  } else {
    try {
      // 与 Node.js 运行时共用 S3 adapter，但凭据来自 Worker Env 而不是 process.env。
      blobs = createS3BlobStoreFromEnv(env);
    } catch (error) {
      await closeMetadata();
      throw error;
    }
  }
  const auth: AuthProvider = emailAuth ?? {
    mode: "development",
    resolveIdentity: async (request) => {
      const hostname = new URL(request.url).hostname;
      // 开发身份只允许本机回环地址，避免免登录入口被部署到公网后意外生效。
      if (hostname !== "localhost" && hostname !== "127.0.0.1") return null;
      return {
        ownerId: "development:owner",
        email: config.ownerEmail || "local@drop-worker.invalid",
      };
    },
    handle: async () => null,
  };
  const services = createAppContext({
    metadata,
    blobs,
    directUploads: config.directUpload
      ? new R2DirectUploadService({
          accountId: config.directUpload.accountId,
          bucketName: config.directUpload.bucketName,
          accessKeyId: config.directUpload.accessKeyId,
          secretAccessKey: config.directUpload.secretAccessKey,
        })
      : undefined,
    publicFilesUrl: config.publicFilesUrl,
    quotaBytes: config.quotaBytes,
    auth,
    insecureHttp: false,
    sharing: {
      enabled: config.sharingEnabled,
      publicUrl: config.publicUrl,
      secret: config.authSessionSecret,
      resolveClientAddress: (request) => request.headers.get("cf-connecting-ip") || "unknown",
    },
  });
  return {
    services,
    close: async () => {
      if (blobs instanceof S3BlobStore) blobs.close();
      await closeMetadata();
    },
  };
}
