import { errorResponse, type ApiApp } from "../http";

/**
 * 认证 HTTP 入口。
 *
 * 状态查询和认证动作必须在登录中间件之前注册，否则未登录用户无法探测会话或提交验证码。
 * 密码、OTP 或平台登录由 AuthProvider.handle 实现，这里只做协议适配。
 */
export function registerAuthRoutes(api: ApiApp): void {
  api.get("/api/auth/status", async (c) => {
    const identity = await c.env.services.auth.resolveIdentity(c.req.raw);
    return c.json({
      authenticated: Boolean(identity),
      mode: c.env.services.auth.mode,
      email: identity?.email ?? null,
      insecureHttp: c.env.services.insecureHttp,
    });
  });

  api.all("/api/auth/*", async (c) => {
    const response = await c.env.services.auth.handle(c.req.raw);
    return response ?? errorResponse(c.get("requestId"), "NOT_FOUND", "认证操作不存在", 404);
  });
}
