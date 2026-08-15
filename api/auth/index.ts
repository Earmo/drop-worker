/**
 * 认证领域：共享协议辅助与未登录即可访问的 HTTP 入口。
 * 运行时适配器仍放在 server/auth 与 worker/auth，避免把平台差异泄漏进路由。
 */
export * from "./shared";
export { registerAuthRoutes } from "./routes";
