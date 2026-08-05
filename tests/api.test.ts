import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runCleanup } from "../apps/api/cleanup";
import { handleApiRequest } from "../apps/api/create-api";
import { LocalBlobStore, openLocalMetadataStore } from "../apps/api/stores/local";
import type { RuntimeServices } from "../apps/api/platform";
import { SqlMetadataStore, type SqlExecutor } from "../apps/api/stores/sql-metadata";
import type { DropItem, ListItemsResponse, StorageSummary, UploadSession } from "../packages/contracts";

async function fixture(quotaBytes = 10 * 1024 * 1024): Promise<{
  services: RuntimeServices;
  close(): Promise<void>;
}> {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-api-"));
  const metadata = openLocalMetadataStore(join(root, "db.sqlite"));
  await metadata.store.ensureSchema();
  const blobs = new LocalBlobStore(root);
  await blobs.prepare();
  return {
    services: {
      metadata: metadata.store,
      blobs,
      quotaBytes,
      authMode: "development",
      insecureHttp: false,
      resolveIdentity: async () => ({ ownerId: "test-owner", email: "owner@example.com" }),
    },
    close: async () => {
      metadata.close();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function request(
  services: RuntimeServices,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const body = init?.body;
  const headers = new Headers(init?.headers);
  if (typeof body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return handleApiRequest(new Request(`http://localhost${path}`, { ...init, headers }), services);
}

test("文本、搜索、收藏和回收站形成完整生命周期", async () => {
test("Cloudflare 元数据存储拒绝在请求时隐式建表", async () => {
  let batchCalled = false;
  const sql: SqlExecutor = {
    all: async <T>() => [] as T[],
    first: async <T>() => null as T | null,
    run: async () => ({ changes: 0 }),
    batch: async () => {
      batchCalled = true;
      return [];
    },
  };
  const metadata = new SqlMetadataStore(sql, false);
  await assert.rejects(metadata.ensureSchema(), /数据库架构尚未迁移/);
  assert.equal(batchCalled, false);
});

  const current = await fixture();
  try {
    const createdResponse = await request(current.services, "/api/items/text", {
      method: "POST",
      body: JSON.stringify({ content: "跨设备测试内容" }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as DropItem;

    const searchResponse = await request(current.services, "/api/items?q=跨设备&limit=20");
    const search = (await searchResponse.json()) as ListItemsResponse;
    assert.equal(search.items.length, 1);
    assert.equal(search.items[0]?.id, created.id);

    const favoriteResponse = await request(current.services, `/api/items/${created.id}`, {
      method: "PATCH",
      body: JSON.stringify({ favorite: true }),
    });
    assert.equal(favoriteResponse.status, 200);
    assert.equal(((await favoriteResponse.json()) as DropItem).favorite, true);

    const trashResponse = await request(current.services, "/api/items/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [created.id], action: "trash" }),
    });
    assert.equal(trashResponse.status, 200);
    const trash = (await (await request(current.services, "/api/items?trash=true")).json()) as ListItemsResponse;
    assert.equal(trash.items.length, 1);

    await request(current.services, "/api/items/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [created.id], action: "restore" }),
    });
    const restored = (await (await request(current.services, "/api/items?trash=false")).json()) as ListItemsResponse;
    assert.equal(restored.items[0]?.deletedAt, null);
  } finally {
    await current.close();
  }
});

test("分片上传可以恢复、完成并下载原始字节", async () => {
  const current = await fixture();
  try {
    const bytes = new TextEncoder().encode("hello drop-worker");
    const createResponse = await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "hello.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength,
        fingerprint: "hello.txt:17:1234",
      }),
    });
    assert.equal(createResponse.status, 201);
    const session = (await createResponse.json()) as UploadSession;

    const partResponse = await request(current.services, `/api/uploads/${session.id}/parts/1`, {
      method: "PUT",
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
      },
    });
    assert.equal(partResponse.status, 200);
    const resumed = (await (await request(current.services, `/api/uploads/${session.id}`)).json()) as UploadSession;
    assert.equal(resumed.parts.length, 1);

    const completeResponse = await request(current.services, `/api/uploads/${session.id}/complete`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(completeResponse.status, 201);
    const item = (await completeResponse.json()) as DropItem;
    const repeatedComplete = await request(current.services, `/api/uploads/${session.id}/complete`, {
      method: "POST",
      body: "{}",
    });
    assert.equal(repeatedComplete.status, 200);
    assert.equal(((await repeatedComplete.json()) as DropItem).id, item.id);
    const download = await request(current.services, `/api/files/${item.id}`);
    assert.equal(download.status, 200);
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);

    const storage = (await (await request(current.services, "/api/storage")).json()) as StorageSummary;
    assert.equal(storage.usedBytes, bytes.byteLength);
    assert.equal(storage.reservedBytes, 0);
  } finally {
    await current.close();
  }
});

test("硬配额阻止新文件但不阻止文本", async () => {
  const current = await fixture(4);
  try {
    const upload = await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "too-large.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 5,
        fingerprint: "too-large:5:1",
      }),
    });
    assert.equal(upload.status, 409);
    const text = await request(current.services, "/api/items/text", {
      method: "POST",
      body: JSON.stringify({ content: "仍然可用" }),
    });
    assert.equal(text.status, 201);
  } finally {
    await current.close();
  }
});

test("并发上传会在数据库内原子预留配额", async () => {
  const current = await fixture(5);
  try {
    const create = (fingerprint: string) => request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: `${fingerprint}.bin`,
        mimeType: "application/octet-stream",
        sizeBytes: 4,
        fingerprint,
      }),
    });
    const responses = await Promise.all([create("concurrent-a"), create("concurrent-b")]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [201, 409]);
    const storage = (await (await request(current.services, "/api/storage")).json()) as StorageSummary;
    assert.equal(storage.reservedBytes, 4);
  } finally {
    await current.close();
  }
});

test("上传取消失败会保留预留空间并由清理任务重试", async () => {
  const current = await fixture(5);
  try {
    const upload = (await (await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "cancel-retry.bin",
        mimeType: "application/octet-stream",
        sizeBytes: 4,
        fingerprint: "cancel-retry:4:1",
      }),
    })).json()) as UploadSession;
    const abortMultipart = current.services.blobs.abortMultipart.bind(current.services.blobs);
    current.services.blobs.abortMultipart = async () => {
      throw new Error("模拟分片存储暂时不可用");
    };

    const failedCancel = await request(current.services, `/api/uploads/${upload.id}`, { method: "DELETE" });
    assert.equal(failedCancel.status, 500);
    const retained = (await (await request(current.services, "/api/storage")).json()) as StorageSummary;
    assert.equal(retained.reservedBytes, 4);
    assert.equal((await current.services.metadata.getUpload("test-owner", upload.id))?.status, "cancelling");

    current.services.blobs.abortMultipart = abortMultipart;
    const cleanup = await runCleanup(current.services, Date.now());
    assert.equal(cleanup.expiredUploads, 0);
    const released = (await (await request(current.services, "/api/storage")).json()) as StorageSummary;
    assert.equal(released.reservedBytes, 0);
    assert.equal((await current.services.metadata.getUpload("test-owner", upload.id))?.status, "cancelled");
  } finally {
    await current.close();
  }
});

test("时间流可以按游标读取超过一页的历史内容", async () => {
  const current = await fixture();
  try {
    for (let index = 0; index < 105; index += 1) {
      await current.services.metadata.createItem({
        ownerId: "test-owner",
        type: "text",
        content: `分页内容 ${index}`,
      });
    }
    const first = (await (await request(current.services, "/api/items?limit=100")).json()) as ListItemsResponse;
    assert.equal(first.items.length, 100);
    assert.equal(first.nextCursor, 100);
    const second = (await (await request(current.services, "/api/items?limit=100&cursor=100")).json()) as ListItemsResponse;
    assert.equal(second.items.length, 5);
    assert.equal(second.nextCursor, null);
  } finally {
    await current.close();
  }
});

test("永久删除失败会保留配额并由清理任务安全重试", async () => {
  const current = await fixture();
  try {
    const bytes = new Uint8Array([42]);
    const upload = (await (await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "retry.bin",
        mimeType: "application/octet-stream",
        sizeBytes: bytes.byteLength,
        fingerprint: "retry:1:1",
      }),
    })).json()) as UploadSession;
    await request(current.services, `/api/uploads/${upload.id}/parts/1`, {
      method: "PUT",
      body: bytes,
      headers: { "content-length": "1", "content-type": "application/octet-stream" },
    });
    const item = (await (await request(current.services, `/api/uploads/${upload.id}/complete`, {
      method: "POST",
      body: "{}",
    })).json()) as DropItem;
    await request(current.services, "/api/items/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [item.id], action: "trash" }),
    });

    const deleteBlob = current.services.blobs.delete.bind(current.services.blobs);
    current.services.blobs.delete = async () => {
      throw new Error("模拟对象存储暂时不可用");
    };
    const failedPurge = await request(current.services, "/api/items/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [item.id], action: "purge" }),
    });
    assert.equal(failedPurge.status, 500);
    const hiddenTrash = (await (await request(current.services, "/api/items?trash=true")).json()) as ListItemsResponse;
    assert.equal(hiddenTrash.items.length, 0);
    const retained = (await (await request(current.services, "/api/storage")).json()) as StorageSummary;
    assert.equal(retained.usedBytes, 1);

    current.services.blobs.delete = deleteBlob;
    const cleanup = await runCleanup(current.services, Date.now());
    assert.equal(cleanup.purgedItems, 1);
    const released = (await (await request(current.services, "/api/storage")).json()) as StorageSummary;
    assert.equal(released.usedBytes, 0);
  } finally {
    await current.close();
  }
});
