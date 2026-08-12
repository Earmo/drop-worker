import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

async function render(path = "/") {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);
  return worker.fetch(
    new Request(`http://localhost${path}`, { headers: { accept: "text/html" } }),
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

test("公开分享页面禁止缓存和搜索引擎收录", async () => {
  const response = await render(`/s/${"a".repeat(43)}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  assert.equal(response.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
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

test("输入区域支持拖入多个文件并提供明确的投放状态", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /onDragEnter=/);
  assert.match(app, /onDragLeave=/);
  assert.match(app, /onDrop=/);
  assert.match(app, /dataTransfer\.types\.includes\("Files"\)/);
  assert.match(app, /addFiles\(Array\.from\(event\.dataTransfer\.files\)\)/);
  assert.match(app, /松开以添加文件/);
  assert.match(css, /\.composer\.is-dragging/);
  assert.match(css, /\.composer-drop-overlay/);
});

test("移动端只显示三项底部导航并持续展示有效分享链接", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const mobileNav = app.slice(app.indexOf("function MobileNav"));
  assert.match(mobileNav, /timeline/);
  assert.match(mobileNav, /favorites/);
  assert.match(mobileNav, /shares/);
  assert.doesNotMatch(mobileNav, /cleanup|trash/);
  assert.match(app, /className="share-row-url"/);
  assert.match(css, /grid-template-columns: repeat\(3, 1fr\)/);
});

test("文本正文使用可选择的文本元素，而不是按钮承载正文", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /<button className=\{`text-content/);
  assert.match(app, /className=\{`text-content[\s\S]*?role="button"/);
});

test("分享图片预览仍复用受保护的分享路径", async () => {
  const [page, css, api] = await Promise.all([
    readFile(new URL("../app/s/share-page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../apps/api/create-api.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /shared-image-preview/);
  assert.match(page, /\/preview/);
  assert.match(page, /referrerPolicy="no-referrer"/);
  assert.match(css, /\.shared-image-preview img/);
  assert.match(api, /\/api\/public\/shares\/:token\/preview/);
  assert.match(api, /hasShareCookie\(c\.req\.raw, share\.id/);
});
