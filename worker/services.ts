import { createRemoteJWKSet, jwtVerify } from "jose";
import { createD1MetadataStore, R2BlobStore } from "../apps/api/stores/cloudflare";
import type { Identity, RuntimeServices } from "../apps/api/platform";

function normalizedEmail(value: string): string {
  return value.trim().toLocaleLowerCase();
}

async function resolveAccessIdentity(request: Request, env: Env): Promise<Identity | null> {
  const sitesUserId = request.headers.get("oai-authenticated-user-id");
  const sitesEmail = request.headers.get("oai-authenticated-user-email");
  if (sitesUserId && sitesEmail) {
    return { ownerId: `sites:${sitesUserId}`, email: sitesEmail };
  }

  const accessToken = request.headers.get("cf-access-jwt-assertion");
  if (accessToken && env.CF_ACCESS_TEAM_DOMAIN && env.CF_ACCESS_AUD) {
    try {
      const teamDomain = new URL(env.CF_ACCESS_TEAM_DOMAIN);
      const jwks = createRemoteJWKSet(new URL("/cdn-cgi/access/certs", teamDomain));
      const { payload } = await jwtVerify(accessToken, jwks, {
        audience: env.CF_ACCESS_AUD,
        issuer: teamDomain.origin,
      });
      const email = typeof payload.email === "string" ? payload.email : null;
      const subject = typeof payload.sub === "string" ? payload.sub : null;
      if (!email || !subject) return null;
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
  if (env.AUTH_MODE === "development" && (hostname === "localhost" || hostname === "127.0.0.1")) {
    return {
      ownerId: "development:owner",
      email: env.OWNER_EMAIL || "local@drop-worker.invalid",
    };
  }
  return null;
}

export function createCloudflareServices(env: Env): RuntimeServices {
  const quota = Number(env.MAX_STORAGE_BYTES || 10 * 1024 * 1024 * 1024);
  return {
    metadata: createD1MetadataStore(env.DB),
    blobs: new R2BlobStore(env.FILES),
    quotaBytes: Number.isFinite(quota) && quota > 0 ? quota : 10 * 1024 * 1024 * 1024,
    authMode: env.AUTH_MODE === "development" ? "development" : "platform",
    insecureHttp: false,
    resolveIdentity: (request) => resolveAccessIdentity(request, env),
  };
}
