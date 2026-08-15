import { Hono } from "hono";
import { registerAuthRoutes } from "./auth";
import { registerCleanupRoutes } from "./cleanup";
import { errorResponse, installIdentityMiddleware, installRequestMiddleware, type ApiEnv } from "./http";
import { registerItemRoutes } from "./items";
import type { AppContext } from "./platform";
import { registerPublicShareRoutes, registerShareRoutes } from "./sharing";
import { registerUploadRoutes } from "./uploads";

/**
 * API 组合根：按领域注册路由，本身不包含业务分支。
 *
 * 注册顺序是负载边界：先装请求追踪，再注册未登录可访问的健康检查、认证和公开分享，
 * 然后才安装登录中间件。后注册的 `/api/*` 身份校验不会回溯到先注册的公开路由。
 */
const api = new Hono<ApiEnv>();
installRequestMiddleware(api);

api.get("/health/live", (c) => c.json({ status: "ok" }));
api.get("/health/ready", async (c) => {
  try {
    await c.env.services.metadata.lifecycle.healthCheck();
    await c.env.services.metadata.lifecycle.ensureSchema();
    await c.env.services.metadata.lifecycle.ensureApplicationReady();
    await c.env.services.blobs.healthCheck();
    return c.json({ status: "ready" });
  } catch {
    return c.json({ status: "unavailable" }, 503);
  }
});
api.get("/api/health", (c) =>
  c.json({ status: "ok", name: "drop-worker", time: new Date().toISOString() }),
);

registerAuthRoutes(api);
registerPublicShareRoutes(api);
installIdentityMiddleware(api);
registerItemRoutes(api);
registerShareRoutes(api);
registerUploadRoutes(api);
registerCleanupRoutes(api);

api.notFound((c) => errorResponse(c.get("requestId") || crypto.randomUUID(), "NOT_FOUND", "接口不存在", 404));

api.onError((error, c) => {
  const requestId = c.get("requestId") || crypto.randomUUID();
  console.error(
    JSON.stringify({
      message: "request failed",
      requestId,
      path: new URL(c.req.url).pathname,
      error: error instanceof Error ? error.message : "unknown",
    }),
  );
  return errorResponse(requestId, "INTERNAL_ERROR", "服务暂时不可用", 500);
});

export function handleApiRequest(request: Request, services: AppContext): Promise<Response> {
  return Promise.resolve(api.fetch(request, { services }));
}
