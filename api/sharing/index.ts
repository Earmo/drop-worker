/**
 * 分享领域：公开访问、属主管理和口令/签名辅助。
 * 公开路由与属主路由必须分开注册，以便登录中间件只保护后者。
 */
export * from "./helpers";
export { registerPublicShareRoutes, registerShareRoutes } from "./routes";
