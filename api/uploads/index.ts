/**
 * 上传领域：直传/代理传输适配与分片会话 HTTP 接口。
 * 清理过期上传不在这里做，避免把定时任务和用户请求缠在一起。
 */
export * from "./transport";
export { registerUploadRoutes } from "./routes";
