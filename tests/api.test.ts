import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { runCleanup } from "../apps/api/cleanup";
import { handleApiRequest } from "../apps/api/create-api";
import { LocalBlobStore, openLocalMetadataStore } from "../apps/api/stores/local";
import type { RuntimeServices } from "../apps/api/platform";
import { SqlMetadataStore, type SqlExecutor } from "../apps/api/stores/sql-metadata";
import { decryptShareCode, encryptShareCode, keyedDigest, tokenForShare } from "../apps/api/sharing";
import { createShareSchema } from "../packages/contracts";
import type {
  CreateShareResponse,
  DropItem,
  ListItemsResponse,
  ListSharesResponse,
  PublicShareContent,
  StorageSummary,
  UploadSession,
} from "../packages/contracts";

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
      sharing: {
        enabled: true,
        publicUrl: new URL("http://localhost"),
        secret: "test-share-secret-that-is-long-enough",
        resolveClientAddress: () => "127.0.0.1",
      },
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

test("Cloudflare 元数据存储拒绝在请求时隐式建表", async () => {
  let batchCalled = false;
  const sql: SqlExecutor = {
    tableExists: async () => false,
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

  const newerSchema = new SqlMetadataStore({
    ...sql,
    tableExists: async () => true,
    first: async <T>() => ({ version: 5 }) as T,
  }, false);
  await assert.rejects(newerSchema.ensureSchema(), /数据库架构尚未迁移/);
});

test("分享口令密文只可由同一部署和分享记录解密", async () => {
  const encrypted = await encryptShareCode("test-share-secret-that-is-long-enough", "share-a", "0042");
  assert.notEqual(encrypted, "0042");
  assert.equal(
    await decryptShareCode("test-share-secret-that-is-long-enough", "share-a", encrypted),
    "0042",
  );
  assert.equal(await decryptShareCode("different-share-secret-that-is-long-enough", "share-a", encrypted), null);
  assert.equal(await decryptShareCode("test-share-secret-that-is-long-enough", "share-b", encrypted), null);
  assert.equal(await decryptShareCode("test-share-secret-that-is-long-enough", "share-a", "invalid"), null);
});

test("本地 SQLite 会从架构 v3 升级并保留历史分享", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-schema-upgrade-"));
  const databasePath = join(root, "db.sqlite");
  const initial = openLocalMetadataStore(databasePath);
  await initial.store.ensureSchema();
  const item = await initial.store.createItem({ ownerId: "upgrade-owner", type: "text", content: "历史分享" });
  await initial.store.createShare({
    id: crypto.randomUUID(),
    ownerId: "upgrade-owner",
    itemId: item.id,
    tokenHash: "t".repeat(43),
    accessMode: "code",
    codeHash: "h".repeat(43),
    now: Date.now(),
    expiresAt: Date.now() + 86_400_000,
  });
  initial.close();

  const legacy = new DatabaseSync(databasePath);
  legacy.exec("ALTER TABLE shares DROP COLUMN code_encrypted");
  legacy.exec("UPDATE schema_version SET version = 3 WHERE id = 1");
  legacy.close();

  const upgraded = openLocalMetadataStore(databasePath);
  try {
    await upgraded.store.ensureSchema();
    const shares = await upgraded.store.listPortableShares();
    assert.equal(shares.length, 1);
    assert.equal(shares[0]?.codeHash, "h".repeat(43));
    assert.equal(shares[0]?.codeEncrypted, null);
  } finally {
    upgraded.close();
  }
  const verified = new DatabaseSync(databasePath);
  assert.equal((verified.prepare("SELECT version FROM schema_version WHERE id = 1").get() as { version: number }).version, 4);
  assert.ok(verified.prepare("SELECT name FROM pragma_table_info('shares') WHERE name = 'code_encrypted'").get());
  verified.close();
  await rm(root, { recursive: true, force: true });
});

test("就绪检查会探测数据库且不泄露失败细节", async () => {
  const current = await fixture();
  try {
    let checked = false;
    current.services.metadata.healthCheck = async () => {
      checked = true;
      throw new Error("postgresql://user:secret@example.invalid/private");
    };
    const live = await request(current.services, "/health/live");
    assert.equal(live.status, 200);
    const ready = await request(current.services, "/health/ready");
    assert.equal(ready.status, 503);
    assert.equal(checked, true);
    assert.deepEqual(await ready.json(), { status: "unavailable" });
  } finally {
    await current.close();
  }
});

test("分享期限契约保留四位口令前导零并拒绝自定义超长期限", () => {
  assert.equal(createShareSchema.parse({ accessMode: "public" }).expiresInSeconds, 7 * 24 * 60 * 60);
  for (const expiresInSeconds of [3_600, 86_400, 604_800, 2_592_000]) {
    assert.equal(createShareSchema.parse({ accessMode: "public", expiresInSeconds }).expiresInSeconds, expiresInSeconds);
  }
  assert.equal(createShareSchema.parse({ accessMode: "code", code: "0042" }).code, "0042");
  assert.equal(createShareSchema.safeParse({ accessMode: "public", expiresInSeconds: 7_200 }).success, false);
  assert.equal(createShareSchema.safeParse({ accessMode: "public", code: "0042" }).success, false);
  assert.equal(createShareSchema.safeParse({ accessMode: "code", code: "42" }).success, false);
});

test("文本、搜索、收藏和回收站形成完整生命周期", async () => {
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

test("图片下载请求强制使用附件响应而不是内联预览", async () => {
  const current = await fixture();
  try {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const upload = (await (await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "photo.png",
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        fingerprint: "photo.png:8:1234",
      }),
    })).json()) as UploadSession;
    await request(current.services, `/api/uploads/${upload.id}/parts/1`, {
      method: "PUT",
      body: bytes,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": String(bytes.byteLength),
      },
    });
    const item = (await (await request(current.services, `/api/uploads/${upload.id}/complete`, {
      method: "POST",
      body: "{}",
    })).json()) as DropItem;

    const preview = await request(current.services, `/api/files/${item.id}`);
    assert.match(preview.headers.get("content-disposition") || "", /^inline;/);

    const download = await request(current.services, `/api/files/${item.id}?download=1`);
    assert.match(download.headers.get("content-disposition") || "", /^attachment;/);
    assert.equal(download.headers.get("content-type"), "application/octet-stream");
    assert.deepEqual(new Uint8Array(await download.arrayBuffer()), bytes);
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

test("口令分享限制尝试并在回收站操作后永久失效", async () => {
  const current = await fixture();
  try {
    const item = (await (await request(current.services, "/api/items/text", {
      method: "POST",
      body: JSON.stringify({ content: "仅限接收者查看" }),
    })).json()) as DropItem;
    const createdResponse = await request(current.services, `/api/items/${item.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "code", code: "0042", expiresInSeconds: 86_400 }),
    });
    assert.equal(createdResponse.status, 201);
    const created = (await createdResponse.json()) as CreateShareResponse;
    const sharedUrl = new URL(created.shareUrl);
    const token = sharedUrl.pathname.split("/").at(-1)!;
    assert.equal(sharedUrl.hash, "#code=0042");
    assert.equal(created.share.shareUrl, new URL(`/s/${token}`, current.services.sharing.publicUrl).toString());
    assert.equal(created.share.code, "0042");
    const listed = (await (await request(current.services, "/api/shares")).json()) as ListSharesResponse;
    assert.equal(listed.shares[0]?.shareUrl, new URL(`/s/${token}`, current.services.sharing.publicUrl).toString());
    assert.equal(listed.shares[0]?.code, "0042");
    const stored = await current.services.metadata.getShareByTokenHash(
      await keyedDigest(current.services.sharing.secret, "share-token-hash", token),
    );
    assert.ok(stored?.codeEncrypted);
    assert.notEqual(stored.codeEncrypted, "0042");

    const protectedContent = await request(current.services, `/api/public/shares/${token}`);
    assert.equal(protectedContent.status, 401);
    assert.equal(protectedContent.headers.get("cache-control"), "private, no-store");
    assert.doesNotMatch(await protectedContent.text(), /仅限接收者查看/);

    const failed = await Promise.all(Array.from({ length: 5 }, () =>
      request(current.services, `/api/public/shares/${token}/verify`, {
        method: "POST",
        body: JSON.stringify({ code: "9999" }),
      }),
    ));
    assert.deepEqual(failed.map((response) => response.status).sort(), [401, 401, 401, 401, 429]);
    const locked = await request(current.services, `/api/public/shares/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ code: "0042" }),
    });
    assert.equal(locked.status, 429);

    current.services.sharing.resolveClientAddress = () => "127.0.0.2";
    const verified = await request(current.services, `/api/public/shares/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ code: "0042" }),
    });
    assert.equal(verified.status, 200);
    const setCookie = verified.headers.get("set-cookie") || "";
    assert.match(setCookie, /HttpOnly/i);
    assert.match(setCookie, /SameSite=Strict/i);
    assert.match(setCookie, new RegExp(`Path=/api/public/shares/${token}`));
    const maxAge = Number(/Max-Age=(\d+)/i.exec(setCookie)?.[1]);
    assert.ok(maxAge > 0 && maxAge <= 86_400);
    const cookie = setCookie.split(";")[0];
    assert.ok(cookie);
    const contentResponse = await request(current.services, `/api/public/shares/${token}`, {
      headers: { cookie },
    });
    assert.equal(contentResponse.status, 200);
    assert.equal(((await contentResponse.json()) as PublicShareContent).type, "text");

    current.services.sharing.resolveClientAddress = () => "127.0.0.3";
    const fourFailures = () => Promise.all(Array.from({ length: 4 }, () =>
      request(current.services, `/api/public/shares/${token}/verify`, {
        method: "POST",
        body: JSON.stringify({ code: "9999" }),
      }),
    ));
    assert.deepEqual((await fourFailures()).map((response) => response.status), [401, 401, 401, 401]);
    assert.equal((await request(current.services, `/api/public/shares/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ code: "0042" }),
    })).status, 200);
    assert.deepEqual((await fourFailures()).map((response) => response.status), [401, 401, 401, 401]);

    current.services.sharing.resolveClientAddress = () => "127.0.0.4";
    const expiredWindowSource = await keyedDigest(
      current.services.sharing.secret,
      "share-source",
      "127.0.0.4",
    );
    await current.services.metadata.saveShareAttempt({
      shareId: created.share.id,
      sourceHash: expiredWindowSource,
      failures: 4,
      lockedUntil: 0,
      updatedAt: Date.now() - 16 * 60 * 1000,
    });
    assert.equal((await request(current.services, `/api/public/shares/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ code: "9999" }),
    })).status, 401);

    await request(current.services, "/api/items/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [item.id], action: "trash" }),
    });
    assert.equal((await request(current.services, `/api/public/shares/${token}`, { headers: { cookie } })).status, 404);
    await request(current.services, "/api/items/bulk", {
      method: "POST",
      body: JSON.stringify({ ids: [item.id], action: "restore" }),
    });
    assert.equal((await request(current.services, `/api/public/shares/${token}`, { headers: { cookie } })).status, 404);
    const shares = (await (await request(current.services, "/api/shares")).json()) as ListSharesResponse;
    assert.equal(shares.shares[0]?.status, "revoked");
  } finally {
    await current.close();
  }
});

test("并发轮换只留下一个有效分享且过期读取不依赖清理任务", async () => {
  const current = await fixture();
  try {
    const item = (await (await request(current.services, "/api/items/text", {
      method: "POST",
      body: JSON.stringify({ content: "轮换测试" }),
    })).json()) as DropItem;
    const responses = await Promise.all([
      request(current.services, `/api/items/${item.id}/share`, {
        method: "POST",
        body: JSON.stringify({ accessMode: "public", expiresInSeconds: 3_600 }),
      }),
      request(current.services, `/api/items/${item.id}/share`, {
        method: "POST",
        body: JSON.stringify({ accessMode: "public", expiresInSeconds: 86_400 }),
      }),
    ]);
    const created = await Promise.all(responses.map(async (response) => {
      assert.equal(response.status, 201);
      return response.json() as Promise<CreateShareResponse>;
    }));
    const statuses = await Promise.all(created.map(({ shareUrl }) => {
      const token = new URL(shareUrl).pathname.split("/").at(-1)!;
      return request(current.services, `/api/public/shares/${token}`).then((response) => response.status);
    }));
    assert.deepEqual(statuses.sort(), [200, 404]);
    const listed = (await (await request(current.services, "/api/shares")).json()) as ListSharesResponse;
    assert.equal(listed.shares.filter((share) => share.status === "active").length, 1);
    assert.equal(listed.shares.find((share) => share.status === "active")?.code, null);

    const expiredId = crypto.randomUUID();
    const expiredToken = await tokenForShare(current.services.sharing.secret, expiredId);
    await current.services.metadata.createShare({
      id: expiredId,
      ownerId: "test-owner",
      itemId: item.id,
      tokenHash: await keyedDigest(current.services.sharing.secret, "share-token-hash", expiredToken),
      accessMode: "public",
      codeHash: null,
      now: Date.now() - 2_000,
      expiresAt: Date.now() - 1_000,
    });
    assert.equal((await request(current.services, `/api/public/shares/${expiredToken}`)).status, 404);

    const cleanupNow = Date.now();
    const staleId = crypto.randomUUID();
    const staleToken = await tokenForShare(current.services.sharing.secret, staleId);
    const staleTokenHash = await keyedDigest(
      current.services.sharing.secret,
      "share-token-hash",
      staleToken,
    );
    await current.services.metadata.createShare({
      id: staleId,
      ownerId: "test-owner",
      itemId: item.id,
      tokenHash: staleTokenHash,
      accessMode: "public",
      codeHash: null,
      now: cleanupNow - 32 * 24 * 60 * 60 * 1000,
      expiresAt: cleanupNow - 31 * 24 * 60 * 60 * 1000,
    });
    await current.services.metadata.saveShareAttempt({
      shareId: staleId,
      sourceHash: "stale-source-digest",
      failures: 1,
      lockedUntil: 0,
      updatedAt: cleanupNow - 31 * 24 * 60 * 60 * 1000,
    });
    await runCleanup(current.services, cleanupNow);
    assert.equal(await current.services.metadata.getShareByTokenHash(staleTokenHash), null);
    assert.equal(await current.services.metadata.getShareAttempt(staleId, "stale-source-digest"), null);
  } finally {
    await current.close();
  }
});

test("全局开关立即暂停分享且导出不包含访问秘密", async () => {
  const current = await fixture();
  try {
    const item = (await (await request(current.services, "/api/items/text", {
      method: "POST",
      body: JSON.stringify({ content: "导出安全测试" }),
    })).json()) as DropItem;
    const created = (await (await request(current.services, `/api/items/${item.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "code", code: "0042", expiresInSeconds: 3_600 }),
    })).json()) as CreateShareResponse;
    const token = new URL(created.shareUrl).pathname.split("/").at(-1)!;
    await request(current.services, `/api/public/shares/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ code: "9999" }),
    });

    current.services.sharing.enabled = false;
    assert.equal((await request(current.services, `/api/public/shares/${token}`)).status, 404);
    assert.equal((await request(current.services, `/api/items/${item.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "public", expiresInSeconds: 3_600 }),
    })).status, 403);
    current.services.sharing.enabled = true;
    assert.equal((await request(current.services, `/api/public/shares/${token}`)).status, 401);

    const exported = await (await request(current.services, "/api/export")).text();
    assert.match(exported, /"version": 2/);
    assert.match(exported, /"accessMode": "code"/);
    assert.doesNotMatch(exported, /tokenHash|codeHash|codeEncrypted|sourceHash|drop_share_access|#code=|0042/);
  } finally {
    await current.close();
  }
});

test("公开文件分享支持单区间下载并可立即撤销", async () => {
  const current = await fixture();
  try {
    const bytes = new TextEncoder().encode("0123456789");
    const upload = (await (await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "range.txt",
        mimeType: "text/plain",
        sizeBytes: bytes.byteLength,
        fingerprint: "range.txt:10:1",
      }),
    })).json()) as UploadSession;
    await request(current.services, `/api/uploads/${upload.id}/parts/1`, {
      method: "PUT",
      body: bytes,
      headers: { "content-length": String(bytes.byteLength), "content-type": "application/octet-stream" },
    });
    const item = (await (await request(current.services, `/api/uploads/${upload.id}/complete`, {
      method: "POST",
      body: "{}",
    })).json()) as DropItem;
    const created = (await (await request(current.services, `/api/items/${item.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "public", expiresInSeconds: 3_600 }),
    })).json()) as CreateShareResponse;
    const token = new URL(created.shareUrl).pathname.split("/").at(-1)!;
    const partial = await request(current.services, `/api/public/shares/${token}/download`, {
      headers: { range: "bytes=2-5" },
    });
    assert.equal(partial.status, 206);
    assert.equal(partial.headers.get("content-range"), "bytes 2-5/10");
    assert.equal(await partial.text(), "2345");
    assert.equal(partial.headers.get("content-disposition")?.startsWith("attachment"), true);
    assert.equal(partial.headers.get("x-content-type-options"), "nosniff");
    assert.equal(partial.headers.get("cache-control"), "private, no-store");
    const openEnded = await request(current.services, `/api/public/shares/${token}/download`, {
      headers: { range: "bytes=6-" },
    });
    assert.equal(await openEnded.text(), "6789");
    const suffix = await request(current.services, `/api/public/shares/${token}/download`, {
      headers: { range: "bytes=-3" },
    });
    assert.equal(await suffix.text(), "789");
    const head = await request(current.services, `/api/public/shares/${token}/download`, { method: "HEAD" });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), "10");
    assert.equal(await head.text(), "");
    const outOfRange = await request(current.services, `/api/public/shares/${token}/download`, {
      headers: { range: "bytes=99-" },
    });
    assert.equal(outOfRange.status, 416);
    assert.equal(outOfRange.headers.get("content-range"), "bytes */10");
    const rangedFromStart = await request(current.services, `/api/public/shares/${token}/download`, {
      headers: { range: "bytes=0-3" },
    });
    assert.equal(rangedFromStart.status, 206);
    const multiRange = await request(current.services, `/api/public/shares/${token}/download`, {
      headers: { range: "bytes=0-1,3-4" },
    });
    assert.equal(multiRange.status, 416);
    let shares = (await (await request(current.services, "/api/shares")).json()) as ListSharesResponse;
    assert.equal(shares.shares[0]?.downloadCount, 0);
    const complete = await request(current.services, `/api/public/shares/${token}/download`);
    assert.equal(complete.status, 200);
    assert.equal(await complete.text(), "0123456789");
    shares = (await (await request(current.services, "/api/shares")).json()) as ListSharesResponse;
    assert.equal(shares.shares[0]?.downloadCount, 1);
    assert.equal((await request(current.services, `/api/shares/${created.share.id}`, { method: "DELETE" })).status, 200);
    assert.equal((await request(current.services, `/api/public/shares/${token}/download`)).status, 404);
  } finally {
    await current.close();
  }
});

test("分享图片预览在验证后内联返回且不计为下载", async () => {
  const current = await fixture();
  try {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    const upload = (await (await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "preview.png",
        mimeType: "image/png",
        sizeBytes: bytes.byteLength,
        fingerprint: "preview.png:8:1",
      }),
    })).json()) as UploadSession;
    await request(current.services, `/api/uploads/${upload.id}/parts/1`, {
      method: "PUT",
      body: bytes,
      headers: { "content-length": String(bytes.byteLength), "content-type": "image/png" },
    });
    const item = (await (await request(current.services, `/api/uploads/${upload.id}/complete`, {
      method: "POST",
      body: "{}",
    })).json()) as DropItem;
    const created = (await (await request(current.services, `/api/items/${item.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "code", code: "0042", expiresInSeconds: 3_600 }),
    })).json()) as CreateShareResponse;
    const token = new URL(created.shareUrl).pathname.split("/").at(-1)!;
    const beforeVerification = await request(current.services, `/api/public/shares/${token}/preview`);
    assert.equal(beforeVerification.status, 401);
    assert.doesNotMatch(await beforeVerification.text(), /preview\.png/);

    const verified = await request(current.services, `/api/public/shares/${token}/verify`, {
      method: "POST",
      body: JSON.stringify({ code: "0042" }),
    });
    assert.equal(verified.status, 200);
    const cookie = verified.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie);

    const preview = await request(current.services, `/api/public/shares/${token}/preview`, {
      headers: { cookie },
    });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "image/png");
    assert.match(preview.headers.get("content-disposition") || "", /^inline;/);
    assert.equal(preview.headers.get("cache-control"), "private, no-store");
    assert.deepEqual(new Uint8Array(await preview.arrayBuffer()), bytes);
    let shares = (await (await request(current.services, "/api/shares")).json()) as ListSharesResponse;
    assert.equal(shares.shares[0]?.downloadCount, 0);

    const download = await request(current.services, `/api/public/shares/${token}/download`, { headers: { cookie } });
    assert.equal(download.status, 200);
    assert.match(download.headers.get("content-disposition") || "", /^attachment;/);
    shares = (await (await request(current.services, "/api/shares")).json()) as ListSharesResponse;
    assert.equal(shares.shares[0]?.downloadCount, 1);

    const svgBytes = new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>");
    const svgUpload = (await (await request(current.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "blocked.svg",
        mimeType: "image/svg+xml",
        sizeBytes: svgBytes.byteLength,
        fingerprint: `blocked.svg:${svgBytes.byteLength}:1`,
      }),
    })).json()) as UploadSession;
    await request(current.services, `/api/uploads/${svgUpload.id}/parts/1`, {
      method: "PUT",
      body: svgBytes,
      headers: { "content-length": String(svgBytes.byteLength), "content-type": "image/svg+xml" },
    });
    const svgItem = (await (await request(current.services, `/api/uploads/${svgUpload.id}/complete`, {
      method: "POST",
      body: "{}",
    })).json()) as DropItem;
    const svgShare = (await (await request(current.services, `/api/items/${svgItem.id}/share`, {
      method: "POST",
      body: JSON.stringify({ accessMode: "public", expiresInSeconds: 3_600 }),
    })).json()) as CreateShareResponse;
    const svgToken = new URL(svgShare.shareUrl).pathname.split("/").at(-1)!;
    assert.equal((await request(current.services, `/api/public/shares/${svgToken}/preview`)).status, 404);
    const svgDownload = await request(current.services, `/api/public/shares/${svgToken}/download`);
    assert.match(svgDownload.headers.get("content-disposition") || "", /^attachment;/);
  } finally {
    await current.close();
  }
});
