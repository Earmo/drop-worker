import handler from "vinext/server/app-router-entry";
import { handleApiRequest } from "../apps/api/create-api";
import { runCleanup } from "../apps/api/cleanup";
import { createCloudflareServices } from "./services";

const worker = {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    try {
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
    ctx.waitUntil(
      runCleanup(createCloudflareServices(env)).then((result) => {
        console.log(JSON.stringify({ message: "cleanup complete", ...result }));
      }),
    );
  },
};

export default worker satisfies ExportedHandler<Env>;
