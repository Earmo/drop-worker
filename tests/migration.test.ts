import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAppContext } from "../api/context";
import { handleApiRequest } from "../api/create-api";
import type { AppContext } from "../api/platform";
import { LocalBlobStore, openLocalMetadataStore } from "../api/stores/local";
import type { ListItemsResponse, UploadSession } from "../packages/contracts";
import { remoteBackup, remoteRestore } from "../server/admin";

async function servicesAt(root: string): Promise<{ services: AppContext; close(): void }> {
  await mkdir(root, { recursive: true });
  const metadata = openLocalMetadataStore(join(root, "db.sqlite"));
  await metadata.store.ensureSchema();
  const blobs = new LocalBlobStore(root);
  await blobs.prepare();
  return {
    services: createAppContext({
      metadata: metadata.store,
      blobs,
      quotaBytes: 10 * 1024 * 1024,
      auth: {
        mode: "development",
        resolveIdentity: async () => ({ ownerId: "portable-owner", email: "owner@example.com" }),
        handle: async () => null,
      },
      insecureHttp: false,
      sharing: {
        enabled: true,
        publicUrl: new URL("http://drop-worker.test"),
        secret: "test-share-secret-that-is-long-enough",
        resolveClientAddress: () => "127.0.0.1",
      },
    }),
    close: metadata.close,
  };
}

async function call(services: AppContext, path: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers);
  if (typeof init?.body === "string" && !headers.has("content-type")) headers.set("content-type", "application/json");
  return handleApiRequest(new Request(`http://drop-worker.test${path}`, { ...init, headers }), services);
}

test("可移植备份在两个部署实例之间完整往返", async () => {
  const root = await mkdtemp(join(tmpdir(), "drop-worker-migration-"));
  const source = await servicesAt(join(root, "source"));
  const target = await servicesAt(join(root, "target"));
  const backup = join(root, "backup");
  const originalFetch = globalThis.fetch;
  const originalBaseUrl = process.env.DROP_WORKER_BASE_URL;
  let active = source.services;
  globalThis.fetch = async (input, init) => {
    const incoming = input instanceof Request ? input : new Request(input, init);
    const url = new URL(incoming.url);
    return handleApiRequest(new Request(`http://drop-worker.test${url.pathname}${url.search}`, incoming), active);
  };
  process.env.DROP_WORKER_BASE_URL = "http://drop-worker.test";
  try {
    await call(source.services, "/api/items/text", {
      method: "POST",
      body: JSON.stringify({ content: "portable text" }),
    });
    const file = new TextEncoder().encode("portable file");
    const upload = (await (await call(source.services, "/api/uploads", {
      method: "POST",
      body: JSON.stringify({
        fileName: "portable.txt",
        mimeType: "text/plain",
        sizeBytes: file.byteLength,
        fingerprint: "portable:13:1",
      }),
    })).json()) as UploadSession;
    await call(source.services, `/api/uploads/${upload.id}/parts/1`, {
      method: "PUT",
      body: file,
      headers: { "content-length": String(file.byteLength), "content-type": "application/octet-stream" },
    });
    await call(source.services, `/api/uploads/${upload.id}/complete`, { method: "POST", body: "{}" });

    await remoteBackup(backup);
    active = target.services;
    await remoteRestore(backup);

    const list = (await (await call(target.services, "/api/items?limit=10")).json()) as ListItemsResponse;
    assert.equal(list.items.length, 2);
    assert.ok(list.items.some((item) => item.content === "portable text"));
    const restoredFile = list.items.find((item) => item.type === "file");
    assert.ok(restoredFile);
    const downloaded = await call(target.services, `/api/files/${restoredFile.id}`);
    assert.equal(await downloaded.text(), "portable file");
  } finally {
    globalThis.fetch = originalFetch;
    if (originalBaseUrl === undefined) delete process.env.DROP_WORKER_BASE_URL;
    else process.env.DROP_WORKER_BASE_URL = originalBaseUrl;
    source.close();
    target.close();
    await rm(root, { recursive: true, force: true });
  }
});
