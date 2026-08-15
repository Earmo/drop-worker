import { EmailOtpAuth } from "../../api/auth";
import { createAppContext } from "../../api/context";
import { createD1MetadataStore, R2BlobStore } from "../../api/stores/cloudflare";
import type { AppContext, AuthProvider } from "../../api/platform";
import { WorkerSmtpMailSender } from "../auth/smtp";
import { R2DirectUploadService } from "../storage/r2-direct-uploads";
import { loadCloudflareRuntimeConfig } from "./config";

export function createCloudflareServices(env: Env): AppContext {
  // 每次组装的只是轻量适配器；真正的状态仍保存在 D1/R2，不依赖 Worker 全局可变状态。
  const config = loadCloudflareRuntimeConfig(env);
  const metadata = createD1MetadataStore(env.DB);
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
  const blobs = new R2BlobStore(env.FILES);
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
  return createAppContext({
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
}
