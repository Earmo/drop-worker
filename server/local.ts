import "dotenv/config";
import { createReadStream } from "node:fs";
import { access, mkdir, stat } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { Readable } from "node:stream";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { handleApiRequest } from "../apps/api/create-api";
import { runCleanup } from "../apps/api/cleanup";
import { LocalBlobStore, openLocalMetadataStore } from "../apps/api/stores/local";
import { addLocalAuthToServices, LocalAuth, localAuthConfigFromEnv } from "./local-auth";

const root = process.cwd();
// 本地实例把数据库、对象和未完成上传统一放在 DATA_DIR，便于 Docker 卷或手工备份整体迁移。
const dataRoot = resolve(root, process.env.DATA_DIR || "./data");
const databasePath = resolve(dataRoot, "drop-worker.sqlite");
const distRoot = resolve(root, "dist");
const clientRoot = resolve(distRoot, "client");
const serverEntry = resolve(distRoot, "server", "index.js");
await access(serverEntry).catch(() => {
  throw new Error("缺少生产构建，请先运行 npm run build");
});
await mkdir(dataRoot, { recursive: true });

// 启动顺序：打开数据库并建表 -> 准备对象目录 -> 校验认证配置 -> 组装运行时服务。
const metadata = openLocalMetadataStore(databasePath);
await metadata.store.ensureSchema();
const blobs = new LocalBlobStore(dataRoot);
await blobs.prepare();
const authConfig = localAuthConfigFromEnv();
const auth = new LocalAuth(databasePath, authConfig);
const quotaBytes = Number(process.env.MAX_STORAGE_BYTES || 10 * 1024 * 1024 * 1024);
const services = addLocalAuthToServices(
  {
    metadata: metadata.store,
    blobs,
    quotaBytes: Number.isFinite(quotaBytes) && quotaBytes > 0 ? quotaBytes : 10 * 1024 * 1024 * 1024,
  },
  auth,
  authConfig,
);

const builtModule = await import(pathToFileURL(serverEntry).href);
const builtWorker = builtModule.default as {
  fetch(
    request: Request,
    env: { ASSETS: { fetch(request: Request): Promise<Response> } },
    ctx: { waitUntil(promise: Promise<unknown>): void; passThroughOnException(): void },
  ): Promise<Response>;
};

async function fetchAsset(request: Request): Promise<Response> {
  // 先限制路径在 dist/client 内，再读取文件；不能让 URL 路径穿越到构建目录之外。
  const url = new URL(request.url);
  const relativePath = decodeURIComponent(url.pathname).replace(/^\/+/, "");
  const candidate = resolve(clientRoot, relativePath || "index.html");
  if (candidate !== clientRoot && !candidate.startsWith(`${clientRoot}${sep}`)) {
    return new Response("Not found", { status: 404 });
  }
  let info;
  try {
    info = await stat(candidate);
  } catch {
    return new Response("Not found", { status: 404 });
  }
  if (!info.isFile()) return new Response("Not found", { status: 404 });
  const extension = candidate.split(".").pop()?.toLocaleLowerCase();
  const contentTypes: Record<string, string> = {
    css: "text/css; charset=utf-8",
    js: "text/javascript; charset=utf-8",
    mjs: "text/javascript; charset=utf-8",
    json: "application/json; charset=utf-8",
    png: "image/png",
    webp: "image/webp",
    svg: "image/svg+xml",
    ico: "image/x-icon",
    woff2: "font/woff2",
    webmanifest: "application/manifest+json",
  };
  return new Response(Readable.toWeb(createReadStream(candidate)) as ReadableStream<Uint8Array>, {
    headers: {
      "content-type": contentTypes[extension || ""] || "application/octet-stream",
      "content-length": String(info.size),
    },
  });
}

const app = new Hono();
app.all("/api/*", (c) => handleApiRequest(c.req.raw, services));
app.all("*", async (c) => {
  // 静态资源命中时直接返回；未命中再交给 Vinext SSR，使页面路由和 API 仍由构建产物处理。
  const response = await fetchAsset(c.req.raw);
  if (response.status !== 404) return response;
  const ctx = {
    waitUntil(promise: Promise<unknown>) {
      void promise.catch((error: unknown) => console.error(error));
    },
    passThroughOnException() {},
  };
  return builtWorker.fetch(c.req.raw, { ASSETS: { fetch: fetchAsset } }, ctx);
});

await runCleanup(services);
// 本地进程模拟 Cloudflare Cron：启动时先清理一次，之后每小时重试过期上传和回收站。
const cleanupTimer = setInterval(() => {
  void runCleanup(services).catch((error) => {
    console.error(JSON.stringify({ message: "cleanup failed", error: error instanceof Error ? error.message : "unknown" }));
  });
}, 60 * 60 * 1000);
cleanupTimer.unref();

const port = Number(process.env.PORT || 3000);
const hostname = process.env.HOST || "0.0.0.0";
const server = serve({ fetch: app.fetch, port, hostname }, (info) => {
  console.log(`drop-worker 已启动：http://${info.address}:${info.port}`);
  if (services.insecureHttp) console.warn("警告：当前以不安全 HTTP 模式运行，请勿暴露到公网。");
});

function shutdown(): void {
  // 先停止新一轮定时清理，再关闭 HTTP、认证数据库和元数据数据库，避免留下半写入状态。
  clearInterval(cleanupTimer);
  server.close(() => {
    auth.close();
    metadata.close();
    process.exit(0);
  });
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
