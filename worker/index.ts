import handler from "vinext/server/app-router-entry";
import { handleApiRequest } from "../api/create-api";
import { runCleanup } from "../api/cleanup";
import { createCloudflareRuntime } from "./runtime/services";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
      // API 请求走统一 Hono 路由；其他请求交给 Vinext 的应用路由和静态资源处理。
      const pathname = new URL(request.url).pathname;
      if (pathname.startsWith("/api/") || pathname.startsWith("/health/")) {
        const runtime = await createCloudflareRuntime(env);
        try {
          return await handleApiRequest(request, runtime.services);
        } finally {
          await runtime.close();
        }
      }
      const response = await handler.fetch(request, env, ctx);
      if (!pathname.startsWith("/s/")) return response;
      const headers = new Headers(response.headers);
      headers.set("cache-control", "private, no-store");
      headers.set("x-robots-tag", "noindex, nofollow, noarchive");
      return new Response(response.body, {
        status: response.status,
        statusText: response.statusText,
        headers,
      });
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
      (async () => {
        const runtime = await createCloudflareRuntime(env);
        try {
          const result = await runCleanup(runtime.services);
          console.log(JSON.stringify({ message: "cleanup complete", ...result }));
        } finally {
          await runtime.close();
        }
      })(),
    );
  },
};

export default worker satisfies ExportedHandler<Env>;
