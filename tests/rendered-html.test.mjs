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

test("服务端输出 Drop Worker 应用外壳", async () => {
  const response = await render();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);
  const html = await response.text();
  assert.match(html, /<title>Drop Worker<\/title>/i);
  assert.match(html, /manifest\.webmanifest/);
  assert.match(html, /Drop Worker/);
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

test("视图筛选切换会清理选择，并使用通用文件选择器", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.match(app, /const changeView = \(next: View\) => \{[\s\S]*?setSelected\(new Set\(\)\)/);
  assert.match(app, /<MobileNav view=\{view\} onView=\{changeView\} \/>/);
  assert.doesNotMatch(app, /<MobileNav view=\{view\} onView=\{setView\} \/>/);
  assert.match(app, /setType\(value\);\s*setSelected\(new Set\(\)\)/);
  assert.match(app, /type="file"[\s\S]*?accept="\*\/\*"/g);
  assert.equal((app.match(/accept="\*\/\*"/g) || []).length, 2);
});

test("文本正文使用可选择的文本元素，而不是按钮承载正文", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /<button className=\{`text-content/);
  assert.match(app, /className=\{`text-content[\s\S]*?role="button"/);
});
