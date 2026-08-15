import type { ApiApp } from "../http";

/**
 * 属主可见的配额摘要。后台清理任务见 runCleanup，不走这条 HTTP 路径。
 */
export function registerCleanupRoutes(api: ApiApp): void {
  api.get("/api/storage", async (c) => {
    const result = await c.env.services.metadata.items.storageSummary(
      c.get("identity").ownerId,
      c.env.services.quotaBytes,
    );
    return c.json(result);
  });
}
