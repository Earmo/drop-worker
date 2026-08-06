import { createRemoteJWKSet, jwtVerify } from "jose";
import { createD1MetadataStore, R2BlobStore } from "../apps/api/stores/cloudflare";
import type { Identity, RuntimeServices } from "../apps/api/platform";
import { CloudflareEmailAuth } from "./email-auth";

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function resolveAccessIdentity(request: Request, env: Env): Promise<Identity | null> {
  // Sites 身份由平台注入可信请求头；优先使用它，不必再解析 Access JWT。
  const sitesUserId = request.headers.get("oai-authenticated-user-id");
  const sitesEmail = request.headers.get("oai-authenticated-user-email");
  if (sitesUserId && sitesEmail) {
    return { ownerId: `sites:${sitesUserId}`, email: sitesEmail };
  }

  const accessToken = request.headers.get("cf-access-jwt-assertion");
  if (accessToken && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    try {
      // JWKS 从团队域名的固定证书端点获取，jwtVerify 同时校验 issuer、audience 和签名。
      const teamDomain = new URL(env.CF_ACCESS_TEAM_DOMAIN);
      const jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
      const { payload } = await jwtVerify(accessToken, jwks, {
        audience: env.CF_ACCESS_AUD,
        issuer: teamDomain.origin,
      });
      const email = typeof payload.email === "string" ? payload.email : null;
      const subject = typeof payload.sub === "string" ? payload.sub : null;
      if (!email || !subject) return null;
      // 即使 Access 应用允许多个用户，应用层仍只接受配置的个人邮箱。
      if (env.OWNER_EMAIL && normalizedEmail(email) !== normalizedEmail(env.OWNER_EMAIL)) return null;
      return { ownerId: `access:${subject}`, email };
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "access token verification failed",
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return null;
    }
  }

  const hostname = new URL(request.url).hostname;
  // development 模式只在本机回环地址提供固定身份，避免误把开发后门暴露到公网。
  if (env.AUTH_MODE === "development" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return {
      ownerId: "development:owner",
      email: env.OWNER_EMAIL || "local@drop-worker.invalid",
    };
  }
  return null;
}

export function createCloudflareServices(env: Env): RuntimeServices {
  // 每次组装的只是轻量适配器；真正的状态仍保存在 D1/R2，不依赖 Worker 全局可变状态。
  const quota = Number(env.MAX_STORAGE_BYTES || 10 * 1024 * 1024 * 1024);
  const emailAuth = env.AUTH_MODE === "smtp-otp" ? new CloudflareEmailAuth(env) : null;
  return {
    metadata: createD1MetadataStore(env.DB),
    blobs: new R2BlobStore(env.FILES),
    quotaBytes: Number.isFinite(quota) && quota > 0 ? quota : 10 * 1024 * 1024 * 1024,
    authMode: emailAuth
      ? "smtp-otp"
      : env.AUTH_MODE === "development"
        ? "development"
        : "platform",
    insecureHttp: false,
    resolveIdentity: (request) => emailAuth
      ? emailAuth.resolveIdentity(request)
      : resolveAccessIdentity(request, env),
    handleAuthRequest: emailAuth ? (request) => emailAuth.handle(request) : undefined,
  };
}
