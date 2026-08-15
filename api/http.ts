import { Hono } from "hono";
import type { ApiError } from "../packages/contracts";
import type { AppContext, Identity } from "./platform";

/**
 * API 运行时环境的唯一接口。
 * 路由只依赖 services，不直接知道 D1、SQLite、R2 或本地文件系统的实现。
 */
export type ApiEnv = {
  Bindings: { services: AppContext };
  Variables: { identity: Identity; requestId: string };
};

export type ApiApp = Hono<ApiEnv>;

export function errorResponse(
  requestId: string,
  code: string,
  message: string,
  status: 400 | 401 | 403 | 404 | 409 | 413 | 429 | 500,
): Response {
  return Response.json(
    { error: { code, message, requestId } } satisfies ApiError,
    { status },
  );
}

export async function parseJson(request: Request): Promise<unknown> {
  // 元数据请求必须有明确上限；文件正文使用 multipart 分片路由，不经过这里。
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (contentLength > 128 * 1024) throw new Error("JSON 请求过大");
  return request.json();
}

/**
 * 注册所有不依赖登录身份的请求处理：请求追踪和写请求的同源校验。
 * 该函数只安装中间件，不创建 Hono 实例，方便 Worker 和本地 Node 入口复用同一套路由。
 */
export function installRequestMiddleware(api: ApiApp): void {
  api.use("/api/*", async (c, next) => {
    const requestId = crypto.randomUUID();
    c.set("requestId", requestId);
    c.header("x-request-id", requestId);

    const method = c.req.method.toUpperCase();
    if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
      const origin = c.req.header("origin");
      if (origin && origin !== new URL(c.req.url).origin) {
        return errorResponse(requestId, "INVALID_ORIGIN", "请求来源不受信任", 403);
      }
    }
    await next();
  });
}

/**
 * 注册登录态中间件。认证适配器只返回可信 Identity，业务路由永远从上下文读取 ownerId。
 */
export function installIdentityMiddleware(api: ApiApp): void {
  api.use("/api/*", async (c, next) => {
    const identity = await c.env.services.auth.resolveIdentity(c.req.raw);
    if (!identity) {
      return errorResponse(c.get("requestId"), "UNAUTHENTICATED", "请先登录", 401);
    }
    c.set("identity", identity);
    await c.env.services.metadata.lifecycle.ensureSchema();
    await next();
  });
}
