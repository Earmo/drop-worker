import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request("http://localhost/", { headers: { accept: "text/html" } }),
    { ASSETS: { fetch: async () => new Response("Not found", { status: 404 }) } },
    { waitUntil() {}, passThroughOnException() {} },
  );
}

test("服务端输出 drop-worker 应用外壳", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>drop-worker<\/title>/i);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /drop-worker/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape|react-loading-skeleton/i);
});

test("成品源码包含核心工作区且不再引用预览骨架", async () => {
  const [page, app, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);
  assert.match(page, /<DropApp \/>/);
  assert.match(app, /时间流/);
  assert.match(app, /存储清理/);
  assert.match(app, /回收站/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(`${page}${layout}${packageJson}`, /_sites-preview|react-loading-skeleton|codex-preview/);
});
