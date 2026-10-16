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
  assert.doesNotMatch(app, /\/api\/export|导出数据清单/);
  assert.match(layout, /og\.png/);
  assert.doesNotMatch(`${page}${layout}${packageJson}`, /react-loading-skeleton|codex-preview/);
});

test("视图筛选切换会清理选择，并使用通用文件选择器", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.match(app, /const changeView = \(next: View\) => \{[\s\S]*?setSelected\(new Set\(\)\)/);
  assert.doesNotMatch(app, /function MobileNav/);
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

test("时间流顺序与输入框位置可以独立设置", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /type TimelineOrder = "newest-top" \| "newest-bottom"/);
  assert.match(app, /type ComposerPosition = "top" \| "bottom"/);
  assert.match(app, /localStorage\.setItem\("drop-worker\.timeline-order", next\)/);
  assert.match(app, /localStorage\.setItem\("drop-worker\.composer-position", next\)/);
  assert.match(app, /const timelineNewestAtBottom = timelineView && timelineOrder === "newest-bottom"/);
  assert.match(app, /const timelineComposerAtBottom = timelineView && composerPosition === "bottom"/);
  assert.match(app, /timelineNewestAtBottom \? \[\.\.\.visibleItems\]\.reverse\(\) : visibleItems/);
  assert.match(app, /!timelineComposerAtBottom && timelineComposer/);
  assert.match(app, /timelineComposerAtBottom && timelineComposer/);
  assert.match(app, /new IntersectionObserver/);
  assert.match(app, /scrollContainer\.scrollTop = anchor\.scrollTop \+ scrollContainer\.scrollHeight - anchor\.scrollHeight/);
  assert.match(app, /向上加载历史/);
  assert.match(app, /<Settings2 size=\{16\} \/> 设置/);
  assert.doesNotMatch(app, /时间流设置/);
  assert.match(css, /\.timeline-fixed-workspace/);
  assert.match(css, /\.composer-bottom-layout \.feed-scroll-layout/);
  assert.match(css, /\.composer-bottom-layout > \.composer/);
  assert.match(app, /feed\$\{timelineNewestAtBottom && !loading && visibleItems\.length === 0 \? " is-empty" : ""\}/);
  assert.match(css, /\.feed-region\.newest-bottom \.feed\.is-empty/);
});

test("四种时间流与输入框组合都使用固定工作区并只滚动列表", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /const timelineView = view === "timeline"/);
  assert.match(app, /timelineView \? " timeline-fixed-workspace" : ""/);
  assert.match(app, /timelineView \? " timeline-fixed-layout" : ""/);
  assert.match(app, /timelineView \? " timeline-feed-region" : ""/);
  assert.match(css, /\.timeline-fixed-workspace/);
  assert.match(css, /\.workspace-body\.timeline-fixed-layout/);
  assert.match(css, /\.timeline-fixed-layout \.timeline-feed-region/);
});

test("移动端去掉底栏，搜索、投递和卡片操作按需展开", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(app, /function MobileNav/);
  assert.doesNotMatch(css, /\.mobile-nav\b/);
  assert.match(app, /className="icon-button search-toggle"/);
  assert.match(app, /composerActive \? "" : " is-collapsed"/);
  assert.match(app, /className="item-menu-toggle"/);
  assert.match(app, /selected\.size < visibleItems\.length && \([\s\S]*?全选/);
  assert.match(app, /className="bulk-action-short"/);
  assert.match(app, /className="share-row-url"/);
  assert.match(css, /\.composer\.is-collapsed/);
  assert.match(css, /\.workspace-header\.is-searching/);
  assert.match(css, /\.bulk-bar \{\s*position: fixed/);
});

test("独立搜索按钮只在移动端显示，且不被通用图标按钮样式覆盖", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  const [desktopCss, mobileCss] = css.split("@media (max-width: 640px)");
  assert.match(desktopCss, /\.workspace-header \.search-toggle \{\s*display: none/);
  assert.match(mobileCss, /\.workspace-header \.search-toggle \{\s*display: inline-grid/);
  assert.match(mobileCss, /\.workspace-header\.is-searching \.search-toggle \{\s*display: none/);
});

test("复制口令分享链接时包含预填口令", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.match(app, /onCopy\(`\$\{share\.shareUrl\}\$\{share\.code \? `#code=\$\{share\.code\}` : ""\}`/);
  assert.match(app, /title=\{share\.code \? "复制分享链接和口令" : "复制分享链接"\}/);
});

test("文本正文使用可选择的文本元素，而不是按钮承载正文", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /<button className=\{`text-content/);
  assert.match(app, /className=\{`text-content[\s\S]*?role="button"/);
});

test("文本点击和键盘操作只展开，收起入口位于更多菜单", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(app, /setExpanded\(\(value\) => !value\)/);
  assert.match(app, /onClick=\{\(\) => setExpanded\(true\)\}/);
  assert.match(app, /event\.key === "Enter"[\s\S]*?setExpanded\(true\)/);
  assert.match(app, /className="item-actions-panel"[\s\S]*?setExpanded\(false\)[\s\S]*?收起文本/);
});

test("所有屏幕的条目编辑和分享都由更多菜单触发", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  const desktopCss = css.split("@media (max-width: 860px)")[0];
  assert.match(desktopCss, /\.item-actions-panel \{\s*display: none/);
  assert.match(desktopCss, /\.item-actions\.is-open \.item-actions-panel \{\s*display: flex/);
  assert.match(app, /className="item-actions-panel"[\s\S]*?aria-label="编辑"[\s\S]*?aria-label="分享"/);
  assert.match(app, /if \(editing\) editorRef\.current\?\.querySelector[\s\S]*?\.focus\(\)/);
  assert.match(app, /toolbar\?\.bottom \?\? bounds\?\.top/);
});

test("复制和收藏直接显示在条目右侧，不再出现在更多菜单内", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  const entry = app.slice(app.indexOf("function ItemEntry("));
  const [actions, menu] = entry.split('className="item-actions-panel"');
  assert.match(actions, /aria-label="复制"/);
  assert.match(actions, /aria-pressed=\{item.favorite\}/);
  assert.match(actions, /aria-label=\{item.favorite \? "取消收藏" : "收藏"\}/);
  assert.doesNotMatch(menu, /aria-label="复制"|aria-label=\{item.favorite/);
  assert.match(menu, /aria-label="编辑"/);
  assert.match(menu, /aria-label="分享"/);
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /grid-template-columns: 24px 34px minmax\(0, 1fr\) auto/);
});

test("手动刷新保留列表并反馈状态，过期分页不得混入新列表", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.match(app, /onClick=\{\(\) => void loadData\(true, true\)\}/);
  assert.match(app, /disabled=\{loading \|\| refreshing \|\| loadingMore\}/);
  assert.match(app, /aria-label="刷新列表"/);
  assert.match(app, /if \(notify\) showNotice\("列表已更新"\)/);
  assert.match(app, /const loadMore[\s\S]*?if \(current !== refreshVersion\.current\) return/);
});

test("图片复制使用带来源的访问地址，并报告剪贴板失败", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.match(app, /const isImage = item\.type === "file" && Boolean\(item\.mimeType\?\.startsWith\("image\/"\)\)/);
  assert.match(app, /new URL\(`\/api\/files\/\$\{item\.id\}`, window\.location\.origin\)\.href/);
  assert.match(app, /item\.type === "text" \|\| item\.type === "link" \|\| isImage/);
  assert.match(app, /复制失败/);
});

test("顶部和底部按钮滚动当前工作区并尊重减少动画设置", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(app, /aria-label="回到顶部"/);
  assert.match(app, /aria-label="回到底部"/);
  assert.match(app, /timelineView \? feedScrollRef\.current : document\.scrollingElement/);
  assert.match(app, /prefers-reduced-motion: reduce/);
  assert.match(css, /\.feed-scroll-layout/);
  assert.match(css, /\.scroll-navigation \{\s*display: flex/);
});

test("各尺寸滚动按钮均位于常驻工具栏，不为侧栏保留空位", async () => {
  const [app, css] = await Promise.all([
    readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
  ]);
  assert.match(css, /\.feed-scroll-layout \{\s*display: grid;\s*grid-template-columns: minmax\(0, 1fr\);/);
  assert.match(css, /\.workspace-heading \+ \.scroll-navigation \{\s*margin-left: auto/);
  assert.doesNotMatch(app + css, /mobile-scroll-navigation/);
  assert.equal(app.match(/&& scrollNavigation/g)?.length, 2);
  assert.doesNotMatch(app, /\{scrollNavigation\}/);
  assert.match(app, /!timelineView && scrollNavigation/);
  assert.match(app, /className="feed-toolbar-actions"[\s\S]*?timelineView && scrollNavigation/);
});

test("顶栏和正文共用响应式居中宽度", async () => {
  const css = await readFile(new URL("../app/globals.css", import.meta.url), "utf8");
  assert.match(css, /\.workspace-header \{[^}]*padding: 15px max\(var\(--workspace-gutter\), calc\(\(100% - var\(--workspace-content-width\)\) \/ 2\)\)/);
  assert.match(css, /\.workspace-body \{\s*width: min\(var\(--workspace-content-width\), calc\(100% - 2 \* var\(--workspace-gutter\)\)\)/);
});

test("分享图片预览仍复用受保护的分享路径", async () => {
  const [page, css, sharingRoutes] = await Promise.all([
    readFile(new URL("../app/s/share-page.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    readFile(new URL("../api/sharing/routes.ts", import.meta.url), "utf8"),
  ]);
  assert.match(page, /shared-image-preview/);
  assert.match(page, /\/preview/);
  assert.match(page, /referrerPolicy="no-referrer"/);
  assert.match(css, /\.shared-image-preview img/);
  assert.match(sharingRoutes, /\/api\/public\/shares\/:token\/preview/);
  assert.match(sharingRoutes, /hasShareCookie\(c\.req\.raw, share\.id/);
});

test("文件列表的下载按钮明确请求附件下载", async () => {
  const app = await readFile(new URL("../app/drop-app.tsx", import.meta.url), "utf8");
  assert.match(app, /className="download-button"[^>]*href=\{`\/api\/files\/\$\{item\.id\}\?download=1`\}/);
});
