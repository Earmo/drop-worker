import {
  bulkActionSchema,
  createLinkSchema,
  createTextSchema,
  listItemsQuerySchema,
  updateItemSchema,
} from "../../packages/contracts";
import { errorResponse, parseJson, type ApiApp } from "../http";
import { createExportBundle } from "./export";
import { registerItemFileRoutes } from "./files";

/**
 * 条目元数据、批量回收站/删除与导出。
 *
 * 永久删除分两步：先标记删除中，再删对象，最后删元数据。对象存储失败时由清理任务重试。
 * 导出附带分享摘要，但不包含分享口令或内部 objectKey。
 */
export function registerItemRoutes(api: ApiApp): void {
  api.get("/api/items", async (c) => {
    const parsed = listItemsQuerySchema.safeParse(c.req.query());
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_QUERY", "筛选条件无效", 400);
    }
    const value = parsed.data;
    const result = await c.env.services.metadata.items.listItems(c.get("identity").ownerId, {
      type: value.type,
      query: value.q,
      favorites: value.favorites === undefined ? undefined : value.favorites === "true",
      trash: value.trash === "true",
      sort: value.sort,
      cursor: value.cursor,
      limit: value.limit,
    });
    return c.json(result);
  });

  api.post("/api/items/text", async (c) => {
    const parsed = createTextSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_TEXT", "文本不能为空且不能超过 64 KB", 400);
    }
    const item = await c.env.services.metadata.items.createItem({
      ownerId: c.get("identity").ownerId,
      type: "text",
      content: parsed.data.content,
    });
    return c.json(item, 201);
  });

  api.post("/api/items/link", async (c) => {
    const parsed = createLinkSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_LINK", "请输入有效的网址", 400);
    }
    const url = new URL(parsed.data.url);
    const item = await c.env.services.metadata.items.createItem({
      ownerId: c.get("identity").ownerId,
      type: "link",
      content: url.toString(),
      title: parsed.data.title || url.hostname,
    });
    return c.json(item, 201);
  });

  api.patch("/api/items/:id", async (c) => {
    const parsed = updateItemSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_UPDATE", "修改内容无效", 400);
    }
    const item = await c.env.services.metadata.items.getItem(c.get("identity").ownerId, c.req.param("id"));
    if (!item) return errorResponse(c.get("requestId"), "NOT_FOUND", "条目不存在", 404);
    if (item.type === "file" && (parsed.data.content !== undefined || parsed.data.title !== undefined)) {
      return errorResponse(c.get("requestId"), "INVALID_UPDATE", "文件只能修改显示名称和收藏状态", 400);
    }
    const updated = await c.env.services.metadata.items.updateItem(
      c.get("identity").ownerId,
      item.id,
      parsed.data,
    );
    return c.json(updated);
  });

  api.post("/api/items/bulk", async (c) => {
    const parsed = bulkActionSchema.safeParse(await parseJson(c.req.raw));
    if (!parsed.success) {
      return errorResponse(c.get("requestId"), "INVALID_BULK_ACTION", "批量操作无效", 400);
    }
    const ownerId = c.get("identity").ownerId;
    if (parsed.data.action === "trash") {
      const changed = await c.env.services.metadata.items.setDeleted(ownerId, parsed.data.ids, Date.now());
      return c.json({ changed });
    }
    if (parsed.data.action === "restore") {
      const changed = await c.env.services.metadata.items.setDeleted(ownerId, parsed.data.ids, null);
      return c.json({ changed });
    }
    // 永久删除分两步完成：先在数据库中标记“删除中”，再删除对象，最后删除元数据。
    let changed = 0;
    for (const id of parsed.data.ids) {
      const item = await c.env.services.metadata.items.beginPurge(ownerId, id);
      if (!item) continue;
      if (item.objectKey) await c.env.services.blobs.delete(item.objectKey);
      if (await c.env.services.metadata.items.permanentlyDelete(ownerId, id)) changed += 1;
    }
    return c.json({ changed });
  });

  api.get("/api/export", async (c) => {
    const ownerId = c.get("identity").ownerId;
    const now = Date.now();
    const [items, storedShares] = await Promise.all([
      c.env.services.metadata.items.listAllForExport(ownerId),
      c.env.services.metadata.shares.listShares(ownerId, now, now - 30 * 24 * 60 * 60 * 1000),
    ]);
    const bundle = createExportBundle(items, storedShares, now, c.env.services.sharing.publicUrl);
    return new Response(JSON.stringify(bundle, null, 2), {
      headers: {
        "content-type": "application/json; charset=utf-8",
        "content-disposition": `attachment; filename="drop-worker-${new Date().toISOString().slice(0, 10)}.json"`,
        "cache-control": "private, no-store",
      },
    });
  });

  registerItemFileRoutes(api);
}
