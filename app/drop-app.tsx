"use client";

import {
  ArchiveRestore,
  ArrowDownToLine,
  Check,
  CheckSquare2,
  Clipboard,
  Copy,
  Download,
  ExternalLink,
  File,
  FileText,
  FolderUp,
  HardDrive,
  Image as ImageIcon,
  Link2,
  LoaderCircle,
  LogOut,
  Menu,
  Moon,
  Paperclip,
  Pencil,
  RotateCcw,
  Search,
  Send,
  Share2,
  ShieldCheck,
  Sparkles,
  Star,
  Sun,
  Trash2,
  X,
} from "lucide-react";
import Image from "next/image";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AuthStatus,
  CreateShareResponse,
  DropItem,
  ItemType,
  ListItemsResponse,
  ListSharesResponse,
  ShareSummary,
  StorageSummary,
  UploadPartUrl,
  UploadSessionResponse,
} from "../packages/contracts";
import { api, withRetry } from "./client/api";
import { formatBytes, formatTime, typeLabel } from "./client/format";
import {
  fileFingerprint,
  PART_SIZE,
  readSavedUploads,
  saveUploads,
  type UploadTask,
  UPLOAD_CONCURRENCY,
} from "./client/uploads";

type View = "timeline" | "favorites" | "shares" | "cleanup" | "trash";
type Theme = "system" | "light" | "dark";
function TypeIcon({ type }: { type: ItemType }) {
  if (type === "text") return <FileText size={17} />;
  if (type === "link") return <Link2 size={17} />;
  return <File size={17} />;
}

export function DropApp() {
  const [auth, setAuth] = useState<AuthStatus | null>(null);
  const [view, setView] = useState<View>("timeline");
  const [items, setItems] = useState<DropItem[]>([]);
  const [nextCursor, setNextCursor] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [storage, setStorage] = useState<StorageSummary | null>(null);
  const [query, setQuery] = useState("");
  const [type, setType] = useState<ItemType | "all">("all");
  const [loading, setLoading] = useState(true);
  const [notice, setNotice] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [pendingFiles, setPendingFiles] = useState<File[]>([]);
  const [uploads, setUploads] = useState<UploadTask[]>([]);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [theme, setTheme] = useState<Theme>("system");
  const [clock, setClock] = useState(0);
  const [cleanupAge, setCleanupAge] = useState("all");
  const [cleanupSize, setCleanupSize] = useState("all");
  const [sharedDraft, setSharedDraft] = useState("");
  const [shares, setShares] = useState<ShareSummary[]>([]);
  const [shareTarget, setShareTarget] = useState<DropItem | null>(null);
  const refreshVersion = useRef(0);

  useEffect(() => {
    // 首屏只做一次浏览器侧初始化：主题、断点续传队列、分享参数和 Service Worker。
    const storedTheme = (localStorage.getItem("drop-worker.theme") as Theme | null) || "system";
    document.documentElement.dataset.theme = storedTheme;
    queueMicrotask(() => {
      setTheme(storedTheme);
      setUploads(readSavedUploads().map((task) => ({ ...task, status: "paused" })));
      const parameters = new URLSearchParams(window.location.search);
      if (parameters.get("share") === "1") {
        const value = [parameters.get("title"), parameters.get("text"), parameters.get("url")]
          .filter(Boolean)
          .join("\n");
        setSharedDraft(value);
        window.history.replaceState({}, "", window.location.pathname);
      }
    });
    if ("serviceWorker" in navigator) {
      void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
    }
  }, []);

  useEffect(() => {
    saveUploads(uploads);
  }, [uploads]);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 3200);
  }, []);

  const loadAuth = useCallback(async () => {
    try {
      const status = await api<AuthStatus>("/api/auth/status");
      setAuth(status);
      return status;
    } catch {
      const status: AuthStatus = {
        authenticated: false,
        mode: "platform",
        email: null,
        insecureHttp: false,
      };
      setAuth(status);
      return status;
    }
  }, []);

  const listParams = useCallback((cursor = 0) => {
    const params = new URLSearchParams({
      trash: String(view === "trash"),
      sort: view === "cleanup" ? "largest" : "latest",
      limit: "100",
      cursor: String(cursor),
    });
    if (view === "favorites") params.set("favorites", "true");
    if (view === "cleanup") params.set("favorites", "false");
    if (type !== "all") params.set("type", type);
    if (query.trim()) params.set("q", query.trim());
    return params;
  }, [query, type, view]);

  const loadData = useCallback(
    async (quiet = false, preserveLoaded = quiet) => {
      if (!auth?.authenticated) return;
      const current = ++refreshVersion.current;
      if (!quiet) setLoading(true);
      try {
        // 列表和存储摘要并行加载；current 防止较慢的旧请求覆盖用户刚切换筛选条件后的新结果。
        const [list, summary, shareList] = await Promise.all([
          api<ListItemsResponse>(`/api/items?${listParams()}`),
          api<StorageSummary>("/api/storage"),
          api<ListSharesResponse>("/api/shares"),
        ]);
        if (current !== refreshVersion.current) return;
        if (preserveLoaded) {
          // 后台轮询只把新数据置于顶部，保留用户已经滚动加载的旧页，避免页面跳动。
          setItems((previous) => {
            const fresh = new Set(list.items.map((item) => item.id));
            return [...list.items, ...previous.filter((item) => !fresh.has(item.id))];
          });
        } else {
          setItems(list.items);
          setNextCursor(list.nextCursor);
        }
        setStorage(summary);
        setShares(shareList.shares);
        setClock(Date.now());
      } catch (error) {
        if (!quiet) showNotice(error instanceof Error ? error.message : "加载失败");
      } finally {
        if (!quiet && current === refreshVersion.current) setLoading(false);
      }
    },
    [auth?.authenticated, listParams, showNotice],
  );

  const loadMore = async () => {
    if (nextCursor === null || loadingMore) return;
    setLoadingMore(true);
    try {
      // 使用服务端返回的 offset cursor 追加下一页，并按 id 去重，兼容轮询和翻页同时发生。
      const list = await api<ListItemsResponse>(`/api/items?${listParams(nextCursor)}`);
      setItems((previous) => {
        const existing = new Set(previous.map((item) => item.id));
        return [...previous, ...list.items.filter((item) => !existing.has(item.id))];
      });
      setNextCursor(list.nextCursor);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "加载更多失败");
    } finally {
      setLoadingMore(false);
    }
  };

  useEffect(() => {
    // 认证状态变化后异步加载，避免在 render 阶段触发请求；清理 timer 防止卸载后更新状态。
    const timer = window.setTimeout(() => {
      void loadAuth().finally(() => setLoading(false));
    }, 0);
    return () => window.clearTimeout(timer);
  }, [loadAuth]);

  useEffect(() => {
    if (!auth?.authenticated) return;
    const timer = window.setTimeout(() => void loadData(), 220);
    return () => window.clearTimeout(timer);
  }, [auth?.authenticated, loadData]);

  useEffect(() => {
    // 已登录时每 5 秒静默刷新，保持跨设备投递的时间流近实时，同时不打断用户当前视图。
    if (!auth?.authenticated) return;
    const timer = window.setInterval(() => void loadData(true), 5000);
    return () => window.clearInterval(timer);
  }, [auth?.authenticated, loadData]);

  const changeTheme = (next: Theme) => {
    setTheme(next);
    localStorage.setItem("drop-worker.theme", next);
    document.documentElement.dataset.theme = next;
  };

  const changeView = (next: View) => {
    setView(next);
    setSelected(new Set());
    setSidebarOpen(false);
  };

  const runItemAction = async (
    ids: string[],
    action: "trash" | "restore" | "purge",
  ) => {
    // 收藏项需要二次确认，永久删除需要明确确认；服务端仍会按 ownerId 再做权限和状态校验。
    if (action === "trash" && items.some((item) => ids.includes(item.id) && item.favorite)) {
      if (!window.confirm("所选内容包含收藏项，仍要移入回收站吗？")) return;
    }
    if (action === "purge" && !window.confirm(`永久删除选中的 ${ids.length} 项？此操作无法撤销。`)) return;
    try {
      await api<{ changed: number }>("/api/items/bulk", {
        method: "POST",
        body: JSON.stringify({ ids, action }),
      });
      setSelected(new Set());
      showNotice(action === "restore" ? "已恢复" : action === "purge" ? "已永久删除" : "已移入回收站");
      await loadData(true, false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "操作失败");
    }
  };

  const updateItem = async (id: string, changes: Record<string, unknown>) => {
    try {
      await api<DropItem>(`/api/items/${id}`, {
        method: "PATCH",
        body: JSON.stringify(changes),
      });
      await loadData(true, false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "保存失败");
      throw error;
    }
  };

  const createEntry = async (value: string) => {
    const content = value.trim();
    if (!content) return;
    const isLink = /^https?:\/\/\S+$/i.test(content);
    await api<DropItem>(isLink ? "/api/items/link" : "/api/items/text", {
      method: "POST",
      body: JSON.stringify(isLink ? { url: content } : { content }),
    });
  };

  const uploadFile = async (file: File, existing?: UploadTask) => {
    const fingerprint = fileFingerprint(file);
    let session: UploadSessionResponse;
    try {
      // 有 existing 时先读取服务端任务，否则创建新 multipart 会话；两条路径最后汇合到同一上传循环。
      if (existing) {
        session = await api<UploadSessionResponse>(`/api/uploads/${existing.id}`);
      } else {
        session = await api<UploadSessionResponse>("/api/uploads", {
          method: "POST",
          body: JSON.stringify({
            fileName: file.name,
            mimeType: file.type || "application/octet-stream",
            sizeBytes: file.size,
            fingerprint,
          }),
        });
      }
      if (session.fingerprint !== fingerprint || session.sizeBytes !== file.size) {
        throw new Error("所选文件与待续传任务不匹配");
      }
      setUploads((current) => [
        ...current.filter((task) => task.id !== session.id),
        {
          id: session.id,
          fileName: file.name,
          sizeBytes: file.size,
          fingerprint,
          progress: session.parts.reduce((total, part) => total + part.sizeBytes, 0) / file.size,
          status: "uploading",
        },
      ]);
      const completedParts = new Map(session.parts.map((part) => [part.partNumber, part]));
      // 已开始的代理上传可能来自旧版 8 MiB 分片；从首个非末片恢复原大小，避免升级后错位。
      const legacyPartSize = session.parts.find((part) => part.sizeBytes < file.size)?.sizeBytes;
      const partSize = session.uploadMode === "direct" ? PART_SIZE : legacyPartSize || PART_SIZE;
      const partCount = Math.ceil(file.size / partSize);
      const pendingPartNumbers = Array.from({ length: partCount }, (_, index) => index + 1)
        .filter((partNumber) => !completedParts.has(partNumber));
      let transferredBytes = session.parts.reduce((total, part) => total + part.sizeBytes, 0);
      const updateProgress = (uploaded = transferredBytes) => {
        setUploads((current) =>
          current.map((task) =>
            task.id === session.id ? { ...task, progress: uploaded / file.size, status: "uploading" } : task,
          ),
        );
      };
      if (session.uploadMode === "direct") {
        // 一批只申请四个短期 URL；分片并发直达 R2，完成后再用一个 API 请求批量确认 ETag。
        for (let offset = 0; offset < pendingPartNumbers.length; offset += UPLOAD_CONCURRENCY) {
          const partNumbers = pendingPartNumbers.slice(offset, offset + UPLOAD_CONCURRENCY);
          const { urls } = await api<{ urls: UploadPartUrl[] }>(`/api/uploads/${session.id}/part-urls`, {
            method: "POST",
            body: JSON.stringify({ partNumbers }),
          });
          const urlByPart = new Map(urls.map((value) => [value.partNumber, value.url]));
          const parts = await Promise.all(partNumbers.map(async (partNumber) => {
            const url = urlByPart.get(partNumber);
            if (!url) throw new Error("服务端未返回完整的分片上传地址");
            const start = (partNumber - 1) * partSize;
            const chunk = file.slice(start, Math.min(file.size, start + partSize));
            const response = await withRetry(async () => {
              const result = await fetch(url, { method: "PUT", body: chunk });
              if (!result.ok) throw new Error(`R2 分片上传失败 (${result.status})`);
              return result;
            });
            const etag = response.headers.get("etag");
            if (!etag) throw new Error("R2 未返回分片 ETag，请检查存储桶 CORS 配置");
            transferredBytes += chunk.size;
            updateProgress();
            return { partNumber, etag };
          }));
          session = await withRetry(() => api<UploadSessionResponse>(`/api/uploads/${session.id}/parts/confirm`, {
            method: "POST",
            body: JSON.stringify({ parts }),
          }));
          transferredBytes = session.parts.reduce((total, part) => total + part.sizeBytes, 0);
          updateProgress();
        }
      } else {
        // 本地文件系统和通用 S3 继续走应用代理，保持既有部署零配置可用。
        for (const partNumber of pendingPartNumbers) {
          const start = (partNumber - 1) * partSize;
          const chunk = file.slice(start, Math.min(file.size, start + partSize));
          session = await withRetry(() =>
            api<UploadSessionResponse>(`/api/uploads/${session.id}/parts/${partNumber}`, {
              method: "PUT",
              body: chunk,
              headers: { "content-type": "application/octet-stream" },
            }),
          );
          transferredBytes = session.parts.reduce((total, part) => total + part.sizeBytes, 0);
          updateProgress();
        }
      }
      // 所有分片都确认后才调用 complete；完成失败会保留任务状态，下一次可以继续重试。
      await api<DropItem>(`/api/uploads/${session.id}/complete`, { method: "POST", body: "{}" });
      setUploads((current) => current.filter((task) => task.id !== session.id));
      showNotice(`${file.name} 已上传`);
      await loadData(true, false);
    } catch (error) {
      const message = error instanceof Error ? error.message : "上传失败";
      setUploads((current) =>
        current.map((task) =>
          task.fingerprint === fingerprint ? { ...task, status: "failed", message } : task,
        ),
      );
      showNotice(message);
    }
  };

  const submitComposer = async (text: string, resetText: () => void) => {
    try {
      // 文本/链接先创建元数据，随后按选择顺序上传文件；任一失败都会保留对应上传任务。
      if (text.trim()) await createEntry(text);
      for (const file of pendingFiles) await uploadFile(file);
      resetText();
      setPendingFiles([]);
      await loadData(true, false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "投递失败");
    }
  };

  const resumeUpload = async (task: UploadTask, file: File) => {
    if (fileFingerprint(file) !== task.fingerprint) {
      showNotice("请选择原文件继续上传");
      return;
    }
    await uploadFile(file, task);
  };

  const cancelUpload = async (task: UploadTask) => {
    try {
      await api<{ cancelled: boolean }>(`/api/uploads/${task.id}`, { method: "DELETE" });
    } catch {
      // The task may already be expired; removing the local reminder is still safe.
    }
    setUploads((current) => current.filter((value) => value.id !== task.id));
  };

  const emptyTrash = async () => {
    if (!window.confirm("清空回收站中的全部内容？此操作无法撤销。")) return;
    try {
      // 先分页收集完整回收站，再按 API 的 100 条上限分批永久删除，避免遗漏超过第一页的内容。
      const ids: string[] = [];
      let cursor: number | null = 0;
      while (cursor !== null) {
        const page: ListItemsResponse = await api<ListItemsResponse>(
          `/api/items?trash=true&sort=latest&limit=100&cursor=${cursor}`,
        );
        ids.push(...page.items.map((item) => item.id));
        cursor = page.nextCursor;
      }
      for (let offset = 0; offset < ids.length; offset += 100) {
        await api("/api/items/bulk", {
          method: "POST",
          body: JSON.stringify({ ids: ids.slice(offset, offset + 100), action: "purge" }),
        });
      }
      setSelected(new Set());
      showNotice(ids.length ? `已永久删除 ${ids.length} 项` : "回收站已经为空");
      await loadData(true, false);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : "清空回收站失败");
    }
  };

  const visibleItems = useMemo(() => {
    // 存储清理视图在服务端“最大文件”排序结果上追加年龄和大小的本地筛选。
    if (view !== "cleanup") return items;
    const ageDays = cleanupAge === "all" ? null : Number(cleanupAge);
    const minimumBytes = cleanupSize === "all" ? 0 : Number(cleanupSize) * 1024 * 1024;
    return items.filter((item) => {
      const oldEnough = ageDays === null || item.createdAt <= clock - ageDays * 86_400_000;
      const largeEnough = item.type !== "file" ? minimumBytes === 0 : item.sizeBytes >= minimumBytes;
      return oldEnough && largeEnough;
    });
  }, [cleanupAge, cleanupSize, clock, items, view]);

  const duplicateIds = useMemo(() => {
    // 疑似重复只用于提示，不自动删除：文件名和大小相同不代表内容一定相同。
    const groups = new Map<string, string[]>();
    for (const item of items) {
      if (item.type !== "file") continue;
      const key = `${(item.originalName || item.displayName || "").toLocaleLowerCase()}:${item.sizeBytes}`;
      groups.set(key, [...(groups.get(key) || []), item.id]);
    }
    return new Set([...groups.values()].filter((group) => group.length > 1).flat());
  }, [items]);

  const activeSharesByItem = useMemo(
    () => new Map(shares.filter((share) => share.status === "active").map((share) => [share.itemId, share])),
    [shares],
  );

  const selectedBytes = visibleItems
    .filter((item) => selected.has(item.id) && item.type === "file")
    .reduce((total, item) => total + item.sizeBytes, 0);

  if (!auth || !auth.authenticated) {
    return <LoginScreen auth={auth} onAuthenticated={async () => setAuth(await loadAuth())} />;
  }

  const viewTitle =
    view === "timeline"
      ? "时间流"
      : view === "favorites"
        ? "收藏"
        : view === "shares"
          ? "分享"
          : view === "cleanup"
            ? "存储清理"
            : "回收站";

  return (
    <div className="app-shell">
      <Sidebar
        view={view}
        onView={changeView}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        auth={auth}
        storage={storage}
        theme={theme}
        onTheme={changeTheme}
        onLogout={async () => {
          await api("/api/auth/logout", { method: "POST", body: "{}" }).catch(() => undefined);
          setAuth(await loadAuth());
        }}
      />

      <main className="workspace">
        <header className="workspace-header">
          <button className="icon-button mobile-menu" onClick={() => setSidebarOpen(true)} aria-label="打开导航">
            <Menu size={19} />
          </button>
          <div>
            <p className="workspace-eyebrow">{auth.email}</p>
            <h1>{viewTitle}</h1>
          </div>
          {view !== "shares" && <div className="search-field">
            <Search size={17} />
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="搜索内容、链接或文件名"
              aria-label="搜索"
            />
            {query && (
              <button onClick={() => setQuery("")} aria-label="清除搜索">
                <X size={15} />
              </button>
            )}
          </div>}
        </header>

        {auth.insecureHttp && (
          <div className="security-warning" role="alert">
            当前使用不安全的 HTTP 连接。请勿通过公网访问。
          </div>
        )}

        <section className="workspace-body">
          {view === "timeline" && (
            <Composer
              key={sharedDraft}
              initialText={sharedDraft}
              pendingFiles={pendingFiles}
              onFiles={setPendingFiles}
              onSubmit={submitComposer}
            />
          )}

          {uploads.length > 0 && (
            <UploadQueue tasks={uploads} onResume={resumeUpload} onCancel={cancelUpload} />
          )}

          {view === "cleanup" && storage && (
            <>
              <CleanupSummary storage={storage} />
              <div className="cleanup-filters">
                <label>
                  时间
                  <select value={cleanupAge} onChange={(event) => setCleanupAge(event.target.value)}>
                    <option value="all">不限</option>
                    <option value="30">30 天前</option>
                    <option value="90">90 天前</option>
                    <option value="365">1 年前</option>
                  </select>
                </label>
                <label>
                  大小
                  <select value={cleanupSize} onChange={(event) => setCleanupSize(event.target.value)}>
                    <option value="all">不限</option>
                    <option value="1">大于 1 MB</option>
                    <option value="10">大于 10 MB</option>
                    <option value="100">大于 100 MB</option>
                  </select>
                </label>
              </div>
            </>
          )}

          {view === "shares" && (
            <ShareManager
              shares={shares}
              onCopy={(value, kind) => void navigator.clipboard.writeText(value).then(() => showNotice(`分享${kind}已复制`))}
              onRevoke={async (share) => {
                if (!window.confirm(`撤销“${share.itemLabel}”的分享？旧链接将立即失效。`)) return;
                await api(`/api/shares/${share.id}`, { method: "DELETE" });
                showNotice("分享已撤销");
                await loadData(true, false);
              }}
            />
          )}

          {view !== "shares" && <><div className="feed-toolbar">
            <div className="segmented" aria-label="类型筛选">
              {(["all", "text", "link", "file"] as const).map((value) => (
                <button
                  key={value}
                  className={type === value ? "active" : ""}
                  onClick={() => {
                    setType(value);
                    setSelected(new Set());
                  }}
                >
                  {value === "all" ? "全部" : typeLabel(value)}
                </button>
              ))}
            </div>
            <div className="feed-toolbar-actions">
              {visibleItems.length > 0 && (
                <button onClick={() => setSelected(new Set(visibleItems.map((item) => item.id)))}>
                  <CheckSquare2 size={14} /> 全选
                </button>
              )}
              {view === "trash" && (
                <button className="danger" onClick={() => void emptyTrash()}>
                  <Trash2 size={14} /> 清空回收站
                </button>
              )}
              <span className="result-count">{visibleItems.length} 项</span>
            </div>
          </div>

          {selected.size > 0 && (
            <div className="bulk-bar">
              <CheckSquare2 size={17} />
              <strong>已选 {selected.size} 项{selectedBytes > 0 ? ` · 可释放 ${formatBytes(selectedBytes)}` : ""}</strong>
              <div className="bulk-actions">
                {view === "trash" ? (
                  <>
                    <button onClick={() => void runItemAction([...selected], "restore")}>
                      <RotateCcw size={15} /> 恢复
                    </button>
                    <button className="danger" onClick={() => void runItemAction([...selected], "purge")}>
                      <Trash2 size={15} /> 永久删除
                    </button>
                  </>
                ) : (
                  <button className="danger" onClick={() => void runItemAction([...selected], "trash")}>
                    <Trash2 size={15} /> 移入回收站
                  </button>
                )}
                <button className="icon-button" onClick={() => setSelected(new Set())} aria-label="取消选择">
                  <X size={15} />
                </button>
              </div>
            </div>
          )}

          <section className="feed" aria-busy={loading}>
            {loading ? (
              <FeedLoading />
            ) : visibleItems.length === 0 ? (
              <EmptyState view={view} query={query} />
            ) : (
              visibleItems.map((item) => (
                <ItemEntry
                  key={item.id}
                  item={item}
                  now={clock}
                  selected={selected.has(item.id)}
                  trash={view === "trash"}
                  suspectedDuplicate={duplicateIds.has(item.id)}
                  activeShare={activeSharesByItem.get(item.id) || null}
                  onSelect={(checked) =>
                    setSelected((current) => {
                      const next = new Set(current);
                      if (checked) next.add(item.id);
                      else next.delete(item.id);
                      return next;
                    })
                  }
                  onUpdate={updateItem}
                  onTrash={() => void runItemAction([item.id], "trash")}
                  onRestore={() => void runItemAction([item.id], "restore")}
                  onPurge={() => void runItemAction([item.id], "purge")}
                  onShare={() => setShareTarget(item)}
                  onNotice={showNotice}
                />
              ))
            )}
          </section>
          {nextCursor !== null && !loading && (
            <div className="load-more-row">
              <button onClick={() => void loadMore()} disabled={loadingMore}>
                {loadingMore ? <LoaderCircle className="spin" size={16} /> : <ArchiveRestore size={16} />}
                {loadingMore ? "正在加载" : "加载更多"}
              </button>
            </div>
          )}</>}
        </section>
      </main>

      {notice && <div className="toast" role="status">{notice}</div>}
      {shareTarget && (
        <ShareDialog
          item={shareTarget}
          existing={activeSharesByItem.get(shareTarget.id) || null}
          onClose={() => setShareTarget(null)}
          onCreated={async () => {
            await loadData(true, false);
          }}
        />
      )}
      <MobileNav view={view} onView={changeView} />
    </div>
  );
}

function Sidebar({
  view,
  onView,
  open,
  onClose,
  auth,
  storage,
  theme,
  onTheme,
  onLogout,
}: {
  view: View;
  onView(view: View): void;
  open: boolean;
  onClose(): void;
  auth: AuthStatus;
  storage: StorageSummary | null;
  theme: Theme;
  onTheme(theme: Theme): void;
  onLogout(): void;
}) {
  const nav = [
    { value: "timeline" as const, label: "时间流", icon: ArchiveRestore },
    { value: "favorites" as const, label: "收藏", icon: Star },
    { value: "shares" as const, label: "分享", icon: Share2 },
    { value: "cleanup" as const, label: "存储清理", icon: HardDrive },
    { value: "trash" as const, label: "回收站", icon: Trash2 },
  ];
  return (
    <>
      {open && <button className="sidebar-scrim" onClick={onClose} aria-label="关闭导航" />}
      <aside className={`sidebar ${open ? "open" : ""}`}>
        <div className="brand-lockup">
          <span className="brand-mark"><ArrowDownToLine size={20} /></span>
          <div><strong>Drop Worker</strong><small>private relay</small></div>
        </div>
        <nav className="primary-nav">
          {nav.map(({ value, label, icon: Icon }) => (
            <button key={value} className={view === value ? "active" : ""} onClick={() => onView(value)}>
              <Icon size={17} /> <span>{label}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-spacer" />
        {storage && <CompactStorage storage={storage} />}
        <div className="sidebar-tools">
          <a href="/api/export" className="sidebar-action"><Download size={16} /> 导出元数据</a>
          <div className="theme-switch" aria-label="主题">
            <button className={theme === "light" ? "active" : ""} onClick={() => onTheme("light")} aria-label="浅色">
              <Sun size={15} />
            </button>
            <button className={theme === "system" ? "active" : ""} onClick={() => onTheme("system")} aria-label="跟随系统">
              <Sparkles size={15} />
            </button>
            <button className={theme === "dark" ? "active" : ""} onClick={() => onTheme("dark")} aria-label="深色">
              <Moon size={15} />
            </button>
          </div>
          {auth.mode !== "platform" && (
            <button className="sidebar-action" onClick={onLogout}><LogOut size={16} /> 退出登录</button>
          )}
        </div>
      </aside>
    </>
  );
}

function Composer({
  initialText,
  pendingFiles,
  onFiles,
  onSubmit,
}: {
  initialText: string;
  pendingFiles: File[];
  onFiles(files: File[]): void;
  onSubmit(text: string, resetText: () => void): Promise<void>;
}) {
  const [text, setText] = useState(initialText);
  const [sending, setSending] = useState(false);
  const [draggingFiles, setDraggingFiles] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const addFiles = (files: File[]) => {
    // 拖拽、粘贴和文件选择器共用入口；这里只过滤单文件上限，最终仍由 API 再次校验。
    const valid = files.filter((file) => file.size <= 500 * 1024 * 1024);
    onFiles([...pendingFiles, ...valid]);
  };
  const submit = async () => {
    // 发送期间锁定按钮，避免重复创建文本条目或重复启动同一批上传。
    if ((!text.trim() && pendingFiles.length === 0) || sending) return;
    setSending(true);
    await onSubmit(text, () => setText(""));
    setSending(false);
  };
  return (
    <section
      className={`composer${draggingFiles ? " is-dragging" : ""}`}
      aria-label="投递输入区域"
      onDragEnter={(event) => {
        if (sending || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current += 1;
        setDraggingFiles(true);
      }}
      onDragOver={(event) => {
        if (sending || !event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDraggingFiles(false);
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes("Files")) return;
        event.preventDefault();
        dragDepth.current = 0;
        setDraggingFiles(false);
        if (sending) return;
        addFiles(Array.from(event.dataTransfer.files));
      }}
    >
      {draggingFiles && (
        <div className="composer-drop-overlay" role="status">
          <FolderUp size={24} />
          <strong>松开以添加文件</strong>
          <span>可同时添加多个文件</span>
        </div>
      )}
      <textarea
        value={text}
        onChange={(event) => setText(event.target.value)}
        onPaste={(event) => {
          const files = Array.from(event.clipboardData.files);
          if (files.length) addFiles(files);
        }}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            void submit();
          }
        }}
        placeholder="写下内容或粘贴链接"
        maxLength={65_536}
        aria-label="投递内容"
      />
      {pendingFiles.length > 0 && (
        <div className="pending-files">
          {pendingFiles.map((file, index) => (
            <span key={`${file.name}-${file.lastModified}-${index}`}>
              <Paperclip size={13} /> {file.name} <small>{formatBytes(file.size)}</small>
              <button
                onClick={() => onFiles(pendingFiles.filter((_, candidate) => candidate !== index))}
                aria-label={`移除 ${file.name}`}
              ><X size={13} /></button>
            </span>
          ))}
        </div>
      )}
      <div className="composer-footer">
        <div>
          <button
            className="icon-button"
            onClick={() => fileInput.current?.click()}
            disabled={sending}
            aria-label="选择文件"
            title="选择文件"
          >
            <Paperclip size={18} />
          </button>
          <input
            ref={fileInput}
            type="file"
            multiple
            accept="*/*"
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files || []));
              event.target.value = "";
            }}
          />
          <span className="composer-limit">单文件最大 500 MB</span>
        </div>
        <button className="send-button" onClick={() => void submit()} disabled={sending || (!text.trim() && !pendingFiles.length)}>
          {sending ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}
          投递
        </button>
      </div>
    </section>
  );
}

function UploadQueue({
  tasks,
  onResume,
  onCancel,
}: {
  tasks: UploadTask[];
  onResume(task: UploadTask, file: File): Promise<void>;
  onCancel(task: UploadTask): Promise<void>;
}) {
  return (
    <section className="upload-queue" aria-label="上传任务">
      {tasks.map((task) => (
        <div className="upload-task" key={task.id}>
          <div className="upload-icon"><FolderUp size={18} /></div>
          <div className="upload-main">
            <div className="upload-title"><strong>{task.fileName}</strong><span>{Math.round(task.progress * 100)}%</span></div>
            <div className="progress-track"><span style={{ width: `${task.progress * 100}%` }} /></div>
            <small>{task.status === "paused" ? "待续传" : task.status === "failed" ? task.message : formatBytes(task.sizeBytes)}</small>
          </div>
          {(task.status === "paused" || task.status === "failed") && (
            <label className="resume-button">
              <RotateCcw size={15} /> 选择原文件
              <input
                type="file"
                accept="*/*"
                hidden
                onChange={(event) => {
                  const file = event.target.files?.[0];
                  if (file) void onResume(task, file);
                }}
              />
            </label>
          )}
          <button className="icon-button" onClick={() => void onCancel(task)} aria-label={`取消 ${task.fileName}`}>
            <X size={16} />
          </button>
        </div>
      ))}
    </section>
  );
}

function ShareManager({
  shares,
  onCopy,
  onRevoke,
}: {
  shares: ShareSummary[];
  onCopy(value: string, kind: "链接" | "口令" | "链接和口令"): void;
  onRevoke(share: ShareSummary): Promise<void>;
}) {
  const activeCount = shares.filter((share) => share.status === "active").length;
  return (
    <section className="share-manager" aria-label="分享管理">
      <div className="share-manager-heading">
        <div><p>外部访问</p><h2>{activeCount} 个有效分享</h2></div>
        <span><ShieldCheck size={16} /> 历史保留 30 天</span>
      </div>
      {shares.length === 0 ? (
        <div className="empty-state share-empty">
          <Share2 size={24} />
          <strong>还没有分享</strong>
          <span>在文本或文件条目上点击分享按钮</span>
        </div>
      ) : (
        <div className="share-list">
          {shares.map((share) => (
            <article className={`share-row status-${share.status}`} key={share.id}>
              <span className="share-row-icon">{share.itemType === "file" ? <File size={18} /> : <FileText size={18} />}</span>
              <div className="share-row-main">
                <div className="share-row-title"><strong>{share.itemLabel}</strong><span>{share.status === "active" ? "有效" : share.status === "expired" ? "已过期" : "已撤销"}</span></div>
                <div className="share-row-meta">
                  <span>{share.accessMode === "public" ? "公开访问" : "口令确认"}</span>
                  <span>到期 {formatTime(share.expiresAt)}</span>
                  <span>访问 {share.accessCount} · 下载 {share.downloadCount}</span>
                  {share.lastAccessedAt && <span>最近 {formatTime(share.lastAccessedAt)}</span>}
                </div>
                {share.status === "active" && share.shareUrl && (
                  <div className="share-row-url">
                    <input readOnly value={share.shareUrl} aria-label={`${share.itemLabel}分享链接`} />
                    <button
                      onClick={() => onCopy(`${share.shareUrl}${share.code ? `#code=${share.code}` : ""}`, share.code ? "链接和口令" : "链接")}
                      title={share.code ? "复制分享链接和口令" : "复制分享链接"}
                      aria-label={share.code ? "复制分享链接和口令" : "复制分享链接"}
                    ><Copy size={15} /></button>
                  </div>
                )}
              </div>
              <div className="share-row-actions">
                {share.status === "active" && share.accessMode === "code" && (
                  share.code ? (
                    <div className="share-code-value" aria-label={`访问口令 ${share.code}`}>
                      <span>口令</span><strong>{share.code}</strong>
                      <button onClick={() => onCopy(share.code!, "口令")} title="复制访问口令" aria-label="复制访问口令"><Copy size={14} /></button>
                    </div>
                  ) : <span className="share-once-note">历史口令不可恢复</span>
                )}
                {share.status === "active" && (
                  <button className="danger" onClick={() => void onRevoke(share)} title="撤销分享" aria-label="撤销分享"><X size={16} /></button>
                )}
              </div>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function ShareDialog({
  item,
  existing,
  onClose,
  onCreated,
}: {
  item: DropItem;
  existing: ShareSummary | null;
  onClose(): void;
  onCreated(): Promise<void>;
}) {
  const [accessMode, setAccessMode] = useState<"public" | "code">("code");
  const [expiresInSeconds, setExpiresInSeconds] = useState(7 * 24 * 60 * 60);
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreateShareResponse | null>(null);
  const [copied, setCopied] = useState(false);

  const create = async () => {
    if (busy || (accessMode === "code" && code.length > 0 && code.length !== 4)) return;
    setBusy(true);
    setError(null);
    try {
      const response = await api<CreateShareResponse>(`/api/items/${item.id}/share`, {
        method: "POST",
        body: JSON.stringify({
          accessMode,
          expiresInSeconds,
          ...(accessMode === "code" && code ? { code } : {}),
        }),
      });
      setResult(response);
      await onCreated();
    } catch (candidate) {
      setError(candidate instanceof Error ? candidate.message : "创建分享失败");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="dialog-backdrop" role="presentation" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section className="share-dialog" role="dialog" aria-modal="true" aria-labelledby="share-dialog-title">
        <header>
          <div><p>临时分享</p><h2 id="share-dialog-title">{item.type === "file" ? item.displayName || item.originalName : "共享文本"}</h2></div>
          <button className="icon-button" onClick={onClose} aria-label="关闭"><X size={17} /></button>
        </header>
        {result ? (
          <div className="share-created">
            <span className="share-created-icon"><Check size={22} /></span>
            <div><h3>分享已创建</h3><p>{result.share.accessMode === "code" ? "完整链接包含预填口令，分享标签页也会持续显示口令。" : "链接在到期或撤销前可访问。"}</p></div>
            <div className="share-url-field"><input readOnly value={result.shareUrl} aria-label="分享链接" /><button onClick={() => {
              void navigator.clipboard.writeText(result.shareUrl).then(() => setCopied(true));
            }}>{copied ? <Check size={16} /> : <Copy size={16} />}{copied ? "已复制" : "复制"}</button></div>
            <button className="dialog-done" onClick={onClose}>完成</button>
          </div>
        ) : (
          <div className="share-dialog-body">
            {existing && <div className="share-replace-warning">重新创建会立即撤销当前有效链接。</div>}
            <fieldset>
              <legend>访问方式</legend>
              <div className="share-mode-control">
                <button className={accessMode === "public" ? "active" : ""} onClick={() => setAccessMode("public")}><Share2 size={16} /> 公开</button>
                <button className={accessMode === "code" ? "active" : ""} onClick={() => setAccessMode("code")}><ShieldCheck size={16} /> 四位口令</button>
              </div>
            </fieldset>
            {accessMode === "code" && (
              <label className="share-code-field">四位口令
                <input
                  value={code}
                  onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
                  inputMode="numeric"
                  pattern="[0-9]{4}"
                  maxLength={4}
                  placeholder="留空则自动生成"
                  autoComplete="off"
                />
              </label>
            )}
            <label className="share-expiry-field">有效期
              <select value={expiresInSeconds} onChange={(event) => setExpiresInSeconds(Number(event.target.value))}>
                <option value={60 * 60}>1 小时</option>
                <option value={24 * 60 * 60}>1 天</option>
                <option value={7 * 24 * 60 * 60}>7 天</option>
                <option value={30 * 24 * 60 * 60}>30 天</option>
              </select>
            </label>
            {error && <div className="form-error" role="alert">{error}</div>}
            <div className="share-dialog-actions"><button onClick={onClose}>取消</button><button className="share-create-button" onClick={() => void create()} disabled={busy}>{busy ? <LoaderCircle className="spin" size={16} /> : <Share2 size={16} />} 创建分享</button></div>
          </div>
        )}
      </section>
    </div>
  );
}

function ItemEntry({
  item,
  now,
  selected,
  trash,
  suspectedDuplicate,
  activeShare,
  onSelect,
  onUpdate,
  onTrash,
  onRestore,
  onPurge,
  onShare,
  onNotice,
}: {
  item: DropItem;
  now: number;
  selected: boolean;
  trash: boolean;
  suspectedDuplicate: boolean;
  activeShare: ShareSummary | null;
  onSelect(value: boolean): void;
  onUpdate(id: string, changes: Record<string, unknown>): Promise<void>;
  onTrash(): void;
  onRestore(): void;
  onPurge(): void;
  onShare(): void;
  onNotice(message: string): void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(item.type === "file" ? item.displayName || "" : item.type === "link" ? item.title || "" : item.content || "");
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const save = async () => {
    // 三种条目共享编辑入口，但可编辑字段不同：文件改显示名，链接改标题，文本改正文。
    const changes = item.type === "file" ? { displayName: draft } : item.type === "link" ? { title: draft } : { content: draft };
    await onUpdate(item.id, changes);
    setEditing(false);
  };
  const copy = async () => {
    await navigator.clipboard.writeText(item.content || item.displayName || item.originalName || "");
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1400);
  };
  return (
    <article className={`feed-item ${selected ? "selected" : ""} ${trash ? "trashed" : ""}`}>
      <label className="select-box">
        <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} />
        <span><Check size={13} /></span>
      </label>
      <div className={`item-type type-${item.type}`}><TypeIcon type={item.type} /></div>
      <div className="item-content">
        <div className="item-meta">
          <span>{typeLabel(item.type)}</span><span>·</span><time>{formatTime(item.createdAt)}</time>
          {item.updatedAt > item.createdAt + 1000 && <span>已编辑</span>}
          {suspectedDuplicate && <span className="duplicate-tag">疑似重复</span>}
          {activeShare && <span className="share-active-tag"><Share2 size={11} /> 分享中</span>}
          {trash && item.deletedAt && <span>剩余 {Math.max(0, 30 - Math.floor((now - item.deletedAt) / 86_400_000))} 天</span>}
        </div>
        {editing ? (
          <div className="inline-editor">
            {item.type === "text" ? (
              <textarea value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={65_536} />
            ) : (
              <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={255} />
            )}
            <div><button onClick={() => void save()}>保存</button><button onClick={() => setEditing(false)}>取消</button></div>
          </div>
        ) : item.type === "text" ? (
          <div
            className={`text-content ${expanded ? "expanded" : ""}`}
            role="button"
            tabIndex={0}
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                setExpanded((value) => !value);
              }
            }}
          >
            {item.content}
          </div>
        ) : item.type === "link" ? (
          <div className="link-content">
            <strong>{item.title}</strong>
            <a href={item.content || "#"} target="_blank" rel="noopener noreferrer">
              <span>{item.content}</span><ExternalLink size={14} />
            </a>
          </div>
        ) : (
          <div className="file-content">
            {item.mimeType?.startsWith("image/") && item.mimeType !== "image/svg+xml" ? (
              <a className="image-preview" href={`/api/files/${item.id}`} target="_blank" rel="noopener noreferrer">
                <Image
                  src={`/api/files/${item.id}`}
                  alt={item.displayName || item.originalName || "图片"}
                  width={44}
                  height={44}
                  unoptimized
                />
              </a>
            ) : (
              <div className="file-glyph"><ImageIcon size={21} /></div>
            )}
            <div><strong>{item.displayName || item.originalName}</strong><span>{formatBytes(item.sizeBytes)} · {item.mimeType || "文件"}</span></div>
            <a className="download-button" href={`/api/files/${item.id}?download=1`} download aria-label={`下载 ${item.displayName || item.originalName}`}>
              <Download size={17} />
            </a>
          </div>
        )}
      </div>
      <div className="item-actions">
        {!trash && (
          <button
            className={item.favorite ? "active favorite" : ""}
            onClick={() => void onUpdate(item.id, { favorite: !item.favorite })}
            aria-label={item.favorite ? "取消收藏" : "收藏"}
            title={item.favorite ? "取消收藏" : "收藏"}
          ><Star size={16} fill={item.favorite ? "currentColor" : "none"} /></button>
        )}
        {!trash && <button onClick={() => setEditing(true)} aria-label="编辑" title="编辑"><Pencil size={16} /></button>}
        {!trash && (item.type === "text" || item.type === "file") && (
          <button className={activeShare ? "active-share" : ""} onClick={onShare} aria-label="分享" title="分享">
            <Share2 size={16} />
          </button>
        )}
        {(item.type === "text" || item.type === "link") && !trash && (
          <button onClick={() => void copy().then(() => onNotice("已复制"))} aria-label="复制" title="复制">
            {copied ? <Check size={16} /> : <Copy size={16} />}
          </button>
        )}
        {trash ? (
          <>
            <button onClick={onRestore} aria-label="恢复" title="恢复"><RotateCcw size={16} /></button>
            <button className="danger" onClick={onPurge} aria-label="永久删除" title="永久删除"><Trash2 size={16} /></button>
          </>
        ) : (
          <button className="danger" onClick={onTrash} aria-label="移入回收站" title="移入回收站"><Trash2 size={16} /></button>
        )}
      </div>
    </article>
  );
}

function CleanupSummary({ storage }: { storage: StorageSummary }) {
  const trashBytes = storage.byType.trash;
  const largest = storage.largestFile;
  const oldest = storage.oldestItem;
  const counts = storage.itemCounts;
  const totalItems = counts.text + counts.link + counts.file;
  const segments = [
    { label: "文本", count: counts.text, color: "var(--accent)" },
    { label: "链接", count: counts.link, color: "var(--blue)" },
    { label: "文件", count: counts.file, color: "var(--green)" },
  ];
  return (
    <>
      <section className="cleanup-summary">
      <div><small>当前占用</small><strong>{formatBytes(storage.usedBytes)}</strong><span>配额 {formatBytes(storage.quotaBytes)}</span></div>
      <div><small>回收站</small><strong>{formatBytes(trashBytes)}</strong><span>永久删除后释放</span></div>
        <div><small>最大文件</small><strong className="truncate">{largest?.displayName || "无"}</strong><span>{largest ? formatBytes(largest.sizeBytes) : "—"}</span></div>
        <div><small>最早内容</small><strong className="truncate">{oldest?.displayName || "无"}</strong><span>{oldest ? `${typeLabel(oldest.type)} · ${formatTime(oldest.createdAt)}` : "—"}</span></div>
      </section>
      <section className="type-breakdown" aria-label="内容构成">
        <div className="type-breakdown-heading"><strong>内容构成</strong><span>{totalItems} 项 · 回收站 {counts.trash} 项</span></div>
        <div className="type-breakdown-track">
          {segments.map((segment) => (
            <span key={segment.label} style={{ width: `${totalItems ? (segment.count / totalItems) * 100 : 0}%`, background: segment.color }} />
          ))}
        </div>
        <div className="type-breakdown-legend">
          {segments.map((segment) => <span key={segment.label}><i style={{ background: segment.color }} />{segment.label} {segment.count}</span>)}
        </div>
      </section>
    </>
  );
}

function CompactStorage({ storage }: { storage: StorageSummary }) {
  const total = storage.usedBytes + storage.reservedBytes;
  const percent = Math.min(100, (total / storage.quotaBytes) * 100);
  const warning = percent >= storage.warningThreshold * 100;
  return (
    <div className={`compact-storage ${warning ? "warning" : ""}`}>
      <div><span>{warning ? "需要清理" : "存储"}</span><strong>{Math.round(percent)}%</strong></div>
      <div className="storage-track"><span style={{ width: `${percent}%` }} /></div>
      <small>{formatBytes(total)} / {formatBytes(storage.quotaBytes)}</small>
    </div>
  );
}

function LoginScreen({ auth, onAuthenticated }: { auth: AuthStatus | null; onAuthenticated(): Promise<void> }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [challengeId, setChallengeId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (!auth) return;
    setBusy(true);
    setError(null);
    try {
      // 登录状态机：密码模式直接登录；OTP 模式第一次发送验证码，第二次提交验证码；平台模式刷新身份。
      if (auth.mode === "password") {
        await api("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
        await onAuthenticated();
      } else if (auth.mode === "smtp-otp" && !challengeId) {
        const result = await api<{ challengeId: string }>("/api/auth/request-otp", {
          method: "POST",
          body: JSON.stringify({ email }),
        });
        setChallengeId(result.challengeId);
      } else if (auth.mode === "smtp-otp") {
        await api("/api/auth/verify-otp", {
          method: "POST",
          body: JSON.stringify({ email, challengeId, code }),
        });
        await onAuthenticated();
      } else {
        window.location.reload();
      }
    } catch (candidate) {
      setError(candidate instanceof Error ? candidate.message : "登录失败");
    } finally {
      setBusy(false);
    }
  };
  return (
    <main className="login-shell">
      <section className="login-panel">
        <div className="brand-lockup login-brand">
          <span className="brand-mark"><ArrowDownToLine size={21} /></span>
          <div><strong>Drop Worker</strong><small>private relay</small></div>
        </div>
        <div className="login-heading"><h1>登录你的投递箱</h1><p>仅允许已配置的个人身份访问。</p></div>
        {!auth ? (
          <div className="login-loading"><LoaderCircle className="spin" size={20} /> 正在检查访问状态</div>
        ) : auth.mode === "platform" ? (
          <button className="primary-login" onClick={() => window.location.reload()}><RotateCcw size={17} /> 重新验证身份</button>
        ) : (
          <form
            className="login-form"
            onSubmit={(event) => {
              event.preventDefault();
              void submit();
            }}
          >
            <label>邮箱<input type="email" value={email} onChange={(event) => setEmail(event.target.value)} autoComplete="email" /></label>
            {auth.mode === "password" ? (
              <label>密码<input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" /></label>
            ) : challengeId ? (
              <label>验证码<input inputMode="numeric" value={code} onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))} autoComplete="one-time-code" /></label>
            ) : null}
            {error && <p className="form-error">{error}</p>}
            <button className="primary-login" type="submit" disabled={busy}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <ArrowDownToLine size={17} />}
              {auth.mode === "smtp-otp" && !challengeId ? "发送验证码" : "登录"}
            </button>
          </form>
        )}
        {auth?.insecureHttp && <p className="login-warning">当前连接未使用 HTTPS。</p>}
      </section>
      <aside className="login-aside"><span>text</span><span>links</span><span>files</span><strong>你的内容，<br />留在你的边界内。</strong></aside>
    </main>
  );
}

function FeedLoading() {
  return <>{[0, 1, 2].map((value) => <div className="feed-skeleton" key={value}><span /><div><i /><i /></div></div>)}</>;
}

function EmptyState({ view, query }: { view: View; query: string }) {
  return (
    <div className="empty-state">
      {query ? <Search size={24} /> : view === "trash" ? <Trash2 size={24} /> : <Clipboard size={24} />}
      <strong>{query ? "没有匹配结果" : view === "trash" ? "回收站为空" : "还没有内容"}</strong>
      <span>{query ? "尝试更换关键词或类型" : view === "trash" ? "删除的内容会在这里保留 30 天" : "从投递栏开始"}</span>
    </div>
  );
}

function MobileNav({ view, onView }: { view: View; onView(view: View): void }) {
  const values = [
    { value: "timeline" as const, icon: ArchiveRestore, label: "时间流" },
    { value: "favorites" as const, icon: Star, label: "收藏" },
    { value: "shares" as const, icon: Share2, label: "分享" },
  ];
  return <nav className="mobile-nav">{values.map(({ value, icon: Icon, label }) => <button key={value} className={view === value ? "active" : ""} onClick={() => onView(value)}><Icon size={18} /><span>{label}</span></button>)}</nav>;
}
