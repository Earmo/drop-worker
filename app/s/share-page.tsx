"use client";

import {
  ArrowDownToLine,
  Check,
  Copy,
  Download,
  File,
  KeyRound,
  LoaderCircle,
  ShieldCheck,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type { ApiError, PublicShareContent } from "../../packages/contracts";
import { formatBytes, formatTime } from "../client/format";

type ViewState =
  | { kind: "loading" }
  | { kind: "verify" }
  | { kind: "content"; content: PublicShareContent }
  | { kind: "missing" };

async function errorCode(response: Response): Promise<string | null> {
  try {
    return ((await response.json()) as ApiError).error?.code || null;
  } catch {
    return null;
  }
}

export function PublicSharePage({ token }: { token: string }) {
  const [state, setState] = useState<ViewState>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const textContent = state.kind === "content" && state.content.type === "text"
    ? state.content.content
    : "";

  const loadContent = useCallback(async () => {
    const response = await fetch(`/api/public/shares/${encodeURIComponent(token)}`, {
      headers: { accept: "application/json" },
      cache: "no-store",
    });
    if (response.ok) {
      setState({ kind: "content", content: (await response.json()) as PublicShareContent });
      return;
    }
    const code = await errorCode(response);
    setState(code === "SHARE_VERIFICATION_REQUIRED" ? { kind: "verify" } : { kind: "missing" });
  }, [token]);

  useEffect(() => {
    const fragment = new URLSearchParams(window.location.hash.slice(1));
    const linkedCode = fragment.get("code");
    if (window.location.hash) {
      window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}`);
    }
    queueMicrotask(() => {
      if (linkedCode && /^\d{4}$/.test(linkedCode)) setCode(linkedCode);
      void loadContent();
    });
  }, [loadContent]);

  const verify = async () => {
    if (!/^\d{4}$/.test(code) || busy) return;
    setBusy(true);
    setMessage(null);
    try {
      const response = await fetch(`/api/public/shares/${encodeURIComponent(token)}/verify`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      });
      if (!response.ok) {
        const payload = (await response.json()) as ApiError;
        setMessage(payload.error?.message || "无法确认访问");
        return;
      }
      await loadContent();
    } catch {
      setMessage("网络连接失败，请稍后重试");
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="public-share-shell">
      <header className="public-share-header">
        {/* Vinext 的 Link 预取在动态分享路由会触发 RSC 运行时异常。 */}
        {/* eslint-disable-next-line @next/next/no-html-link-for-pages */}
        <a href="/" className="brand-lockup" aria-label="Drop Worker">
          <span className="brand-mark"><ArrowDownToLine size={20} /></span>
          <div><strong>Drop Worker</strong><small>temporary relay</small></div>
        </a>
        <span className="share-security"><ShieldCheck size={15} /> 临时分享</span>
      </header>

      <section className={`public-share-stage state-${state.kind}`} aria-live="polite">
        {state.kind === "loading" && (
          <div className="share-loading"><LoaderCircle className="spin" size={22} /> 正在检查分享</div>
        )}

        {state.kind === "verify" && (
          <div className="share-verify">
            <span className="share-stage-icon"><KeyRound size={25} /></span>
            <p className="share-kicker">确认访问</p>
            <h1>输入四位口令</h1>
            <p>发送者要求确认后才能查看分享内容。</p>
            <input
              value={code}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 4))}
              onKeyDown={(event) => {
                if (event.key === "Enter") void verify();
              }}
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{4}"
              maxLength={4}
              aria-label="四位访问口令"
            />
            {message && <div className="share-error" role="alert">{message}</div>}
            <button className="share-primary" onClick={() => void verify()} disabled={busy || code.length !== 4}>
              {busy ? <LoaderCircle className="spin" size={17} /> : <Check size={17} />}
              确认访问
            </button>
          </div>
        )}

        {state.kind === "missing" && (
          <div className="share-missing">
            <p className="share-kicker">链接不可用</p>
            <h1>分享已失效</h1>
            <p>链接可能已过期、被撤销，或关联内容已经删除。</p>
          </div>
        )}

        {state.kind === "content" && state.content.type === "text" && (
          <div className="shared-text-view">
            <div className="shared-content-heading">
              <div><p className="share-kicker">共享文本</p><h1>来自 Drop Worker</h1></div>
              <button
                className="icon-button"
                onClick={() => {
                  void navigator.clipboard.writeText(textContent).then(() => {
                    setCopied(true);
                    window.setTimeout(() => setCopied(false), 1400);
                  });
                }}
                aria-label="复制文本"
                title="复制文本"
              >{copied ? <Check size={17} /> : <Copy size={17} />}</button>
            </div>
            <pre>{state.content.content}</pre>
            <footer>更新于 {formatTime(state.content.updatedAt)} · 到期于 {formatTime(state.content.expiresAt)}</footer>
          </div>
        )}

        {state.kind === "content" && state.content.type === "file" && (
          <div className="shared-file-view">
            <span className="share-stage-icon"><File size={25} /></span>
            <p className="share-kicker">共享文件</p>
            <h1>{state.content.fileName}</h1>
            <p>{formatBytes(state.content.sizeBytes)} · {state.content.mimeType}</p>
            <a className="share-primary" href={`/api/public/shares/${encodeURIComponent(token)}/download`}>
              <Download size={18} /> 下载文件
            </a>
            <footer>更新于 {formatTime(state.content.updatedAt)} · 到期于 {formatTime(state.content.expiresAt)}</footer>
          </div>
        )}
      </section>
    </main>
  );
}
