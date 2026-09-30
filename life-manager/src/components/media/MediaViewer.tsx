import { useCallback, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";
import { baseName, blobUrl, extOf, formatBytes, KIND_GROUPS, KIND_ICONS, KIND_LABELS, kindOf, readMediaBytes, type MediaFile } from "../../lib/media";
import { LANG_NAMES } from "../../lib/highlight";
import { isEscape } from "../../lib/keys";
import { usePortalHost } from "../../hooks/usePortalHost";
import { ImageView } from "./ImageView";
import { AudioView } from "./AudioView";
import { ModelView } from "./ModelView";
import { CodeView, CsvView, HtmlView, MarkdownView } from "./TextViews";

interface MediaViewerProps {
  files: MediaFile[];
  /** はじめに開くファイル（files の中の番号） */
  start: number;
  /** 一覧の見出し（「#11 の成果物」など） */
  title?: string;
  onClose: () => void;
  /** そのファイルの、そのコミットでの差分（コードの「このコミットの変更」）。なければ出さない */
  loadPatch?: (file: MediaFile) => Promise<string | null>;
}

type Loaded = { bytes?: ArrayBuffer; error?: string };

const keyOf = (f: MediaFile) => `${f.source.kind === "local" ? "local" : f.source.sha}|${f.path}`;

/** 作業フォルダの中のファイルの場所（Windows の区切り） */
function joinPath(folder: string, file: string): string {
  return `${folder.replace(/[\\/]+$/, "")}\\${file.replace(/\//g, "\\")}`;
}

function VideoView({ bytes, path }: { bytes: ArrayBuffer; path: string }) {
  const url = useMemo(() => blobUrl(bytes, path), [bytes, path]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="mv-main full">
      <div className="mv-stage bg-dark mv-video-stage">
        <video className="mv-video" src={url} controls loop />
      </div>
    </div>
  );
}

function PdfView({ bytes, path }: { bytes: ArrayBuffer; path: string }) {
  const url = useMemo(() => blobUrl(bytes, path), [bytes, path]);
  useEffect(() => () => URL.revokeObjectURL(url), [url]);
  return (
    <div className="mv-main full">
      <iframe className="mv-pdf" title="PDF" src={url} />
    </div>
  );
}

/**
 * メディアビューワー（成果物・コミットのファイル・作業フォルダのファイルを、アプリの中で見る）。
 * 左に一覧（種類ごと。← → で次のファイル）、右に中身: 画像（スプライトシートの再生）・音・動画・3D・コード・テキスト・表・HTML・PDF。
 * 中身は、この PC の作業フォルダ・この PC の git・GitHub の順に読む
 */
export function MediaViewer({ files, start, title, onClose, loadPatch }: MediaViewerProps) {
  const host = usePortalHost();
  const [index, setIndex] = useState(() => Math.max(0, Math.min(start, files.length - 1)));
  const [loaded, setLoaded] = useState<Record<string, Loaded>>({});
  const [info, setInfo] = useState<Record<string, string>>({});
  const file = files[index];
  const key = file ? keyOf(file) : "";
  const kind = file ? kindOf(file.path) : "other";
  const removed = file?.status === "removed";

  // 一覧の並び（種類ごと）。← → はこの並びで動く
  const order = useMemo(() => {
    const out: number[] = [];
    for (const g of KIND_GROUPS) files.forEach((f, i) => g.kinds.includes(kindOf(f.path)) && out.push(i));
    return out;
  }, [files]);

  useEffect(() => {
    if (!file || removed || loaded[key]) return;
    let alive = true;
    readMediaBytes(file)
      .then((bytes) => alive && setLoaded((m) => ({ ...m, [key]: { bytes } })))
      .catch((e) => alive && setLoaded((m) => ({ ...m, [key]: { error: String(e) } })));
    return () => {
      alive = false;
    };
  }, [file, key, removed, loaded]);

  const move = useCallback(
    (step: number) => {
      const at = order.indexOf(index);
      const next = order[(at + step + order.length) % order.length];
      if (next !== undefined) setIndex(next);
    },
    [order, index],
  );

  // ← → で次のファイル・Esc で閉じる（下の画面には渡さない）
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const t = e.target as HTMLElement | null;
      const typing = !!t?.closest("input, textarea, select, [contenteditable='true']");
      if (isEscape(e)) {
        e.stopPropagation();
        e.preventDefault();
        onClose();
      } else if (!typing && (e.key === "ArrowLeft" || e.key === "ArrowRight") && !e.ctrlKey && !e.altKey) {
        e.stopPropagation();
        e.preventDefault();
        move(e.key === "ArrowRight" ? 1 : -1);
      }
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [move, onClose]);

  const setFileInfo = useCallback((text: string) => setInfo((m) => (m[key] === text ? m : { ...m, [key]: text })), [key]);
  const folder = file?.source.folder;
  const patchLoader = useMemo(() => (file && loadPatch && file.source.kind === "commit" ? () => loadPatch(file) : undefined), [file, loadPatch]);

  if (!host || !file) return null;
  const now = loaded[key];
  const ext = extOf(file.path);
  const dir = file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/") + 1) : "";

  let content;
  if (removed) {
    content = <div className="mv-main full"><p className="mv-note center">このコミットで消えたファイルです（消す前の中身は、ひとつ前のコミットにあります）</p></div>;
  } else if (!now) {
    content = <div className="mv-main full"><p className="mv-note center"><i className="spinner" aria-hidden="true" /> 読み込んでいます…</p></div>;
  } else if (now.error) {
    content = <div className="mv-main full"><p className="mv-note center error">{now.error.replace(/^git [^\n]*\n/, "")}</p></div>;
  } else if (now.bytes) {
    const b = now.bytes;
    const p = file.path;
    content =
      kind === "image" ? <ImageView key={key} bytes={b} path={p} onInfo={setFileInfo} />
      : kind === "audio" ? <AudioView key={key} bytes={b} path={p} onInfo={setFileInfo} />
      : kind === "video" ? <VideoView key={key} bytes={b} path={p} />
      : kind === "model" ? <ModelView key={key} bytes={b} path={p} onInfo={setFileInfo} />
      : kind === "markdown" ? <MarkdownView key={key} bytes={b} />
      : kind === "csv" ? <CsvView key={key} bytes={b} path={p} onInfo={setFileInfo} />
      : kind === "html" ? <HtmlView key={key} bytes={b} onOpenOutside={folder ? () => void openPath(joinPath(folder, p)) : undefined} />
      : kind === "pdf" ? <PdfView key={key} bytes={b} path={p} />
      : kind === "code" || kind === "text" ? <CodeView key={key} bytes={b} path={p} loadPatch={patchLoader} onInfo={setFileInfo} />
      : (
        <div className="mv-main full">
          <div className="mv-note center">
            この形式（.{ext || "?"}）は、ここでは見られません。
            {folder && <div className="mv-row center"><button type="button" className="btn-sm" onClick={() => void openPath(joinPath(folder, p))}>外部のアプリで開く</button></div>}
          </div>
        </div>
      );
  }

  const label = kind === "code" ? LANG_NAMES[ext] ?? ext.toUpperCase() : `${KIND_LABELS[kind]}${ext ? ` ${ext.toUpperCase()}` : ""}`;

  return createPortal(
    <div className="mv-back" onClick={onClose}>
      <div className="mv" role="dialog" aria-modal="true" aria-label={`${baseName(file.path)} を見る`} onClick={(e) => e.stopPropagation()}>
        <div className="mv-head">
          <span className="mv-icon" aria-hidden="true">{KIND_ICONS[kind]}</span>
          <span className="mv-path">
            <b>{baseName(file.path)}</b>
            {dir && <small>{dir}</small>}
          </span>
          <span className="mv-badge k">{label}</span>
          {(info[key] || now?.bytes) && <span className="mv-badge">{[info[key], now?.bytes ? formatBytes(now.bytes.byteLength) : ""].filter(Boolean).join(" ・ ")}</span>}
          {file.status && file.status !== "modified" && <span className={`mv-badge st-${file.status}`}>{file.status === "added" ? "足した" : file.status === "removed" ? "消した" : "名前を変えた"}</span>}
          <span className="grow" />
          {file.commitLabel && <span className="mv-commit" title={file.commitLabel}>{file.commitLabel}</span>}
          {folder && (
            <button type="button" className="btn-sm" onClick={() => void revealItemInDir(joinPath(folder, file.path)).catch(() => {})}
              title={file.source.kind === "commit" ? "作業フォルダの今のファイルを、エクスプローラーで表示します" : undefined}>
              🗂 エクスプローラーで表示
            </button>
          )}
          <button type="button" className="mv-close" onClick={onClose} aria-label="閉じる" title="閉じる（Esc）">×</button>
        </div>
        <div className="mv-body">
          <nav className="mv-list" aria-label="ファイル">
            {title && <div className="mv-list-title">{title}</div>}
            {KIND_GROUPS.map((g) => {
              const items = files.map((f, i) => ({ f, i })).filter(({ f }) => g.kinds.includes(kindOf(f.path)));
              if (!items.length) return null;
              return (
                <div key={g.label}>
                  <div className="mv-list-h">{g.label} {items.length}</div>
                  {items.map(({ f, i }) => (
                    <button key={keyOf(f)} type="button" className={`mv-item${i === index ? " on" : ""}${f.status === "removed" ? " removed" : ""}`}
                      onClick={() => setIndex(i)} title={f.path}>
                      <span className="mv-item-ic" aria-hidden="true">{KIND_ICONS[kindOf(f.path)]}</span>
                      <span className="mv-item-name">
                        {baseName(f.path)}
                        <small>
                          {f.status === "removed" ? "消した" : f.additions != null && f.deletions != null && (f.additions > 0 || f.deletions > 0) ? `+${f.additions} −${f.deletions}` : KIND_LABELS[kindOf(f.path)]}
                        </small>
                      </span>
                    </button>
                  ))}
                </div>
              );
            })}
          </nav>
          {content}
        </div>
      </div>
    </div>,
    host,
  );
}
