import handler from "vinext/server/app-router-entry";
import { handleApiRequest } from "../apps/api/create-api";
import { runCleanup } from "../apps/api/cleanup";
import { createCloudflareServices } from "./services";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // API 请求走统一 Hono 路由；其他请求交给 Vinext 的应用路由和静态资源处理。
      if (new URL(request.url).pathname.startsWith("/api/")) {
        return handleApiRequest(request, createCloudflareServices(env));
      }
      return handler.fetch(request, env, ctx);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: "worker request failed",
          path: new URL(request.url).pathname,
          error: error instanceof Error ? error.message : "unknown",
        }),
      );
      return Response.json({ error: "Internal server error" }, { status: 500 });
    }
  },
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    // Cron 触发器不能阻塞调度响应，清理任务交给 waitUntil 在后台完成。
    ctx.waitUntil(
      runCleanup(createCloudflareServices(env)).then((result) => {
        console.log(JSON.stringify({ message: "cleanup complete", ...result }));
      }),
    );
  },
};

export default worker satisfies ExportedHandler<Env>;
