import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import {
  ago,
  fingerprint,
  lineKey,
  parsePatch,
  splitRows,
  type PatchLine,
  type PatchRow,
  type PullFile,
  type ReviewComment,
} from "../../lib/pulls";
import { tr, trx } from "../../lib/i18n";

/** 1 つのファイルで最初に見せる行の数（長いファイルは「続きを見る」で） */
const FIRST_ROWS = 600;
const LAYOUT_KEY = "pull-diff-layout";

type Layout = "unified" | "split";

const STATUS_NAMES: Record<string, string> = {
  added: tr("追加"),
  removed: tr("削除"),
  modified: tr("変更"),
  renamed: tr("名前"),
  copied: tr("コピー"),
  changed: tr("変更"),
  unchanged: tr("同じ"),
};

const STATUS_TITLES: Record<string, string> = {
  added: tr("新しく作ったファイル"),
  removed: tr("削除したファイル"),
  modified: tr("中身を変えたファイル"),
  renamed: tr("名前（場所）を変えたファイル"),
  copied: tr("コピーしたファイル"),
  changed: tr("種類や権限が変わったファイル"),
  unchanged: tr("変わっていないファイル"),
};

export interface LineCommentDraft {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
}

interface PullFilesProps {
  files: PullFile[] | null;
  error?: string | null;
  /** 行に付いているコメント（今の差分に出るものだけ） */
  comments?: ReviewComment[];
  /** 行にコメントを付けられるとき（開いているプルリク） */
  onComment?: (c: LineCommentDraft) => Promise<void>;
  /** 「見た」を覚えておく場所（プルリクごと）。null なら「見た」を出さない（作る前の確認など） */
  viewedKey?: string | null;
  /** このファイルまで送る（会話の「変更されたファイル」から来たとき） */
  focus?: { file: string; nonce: number } | null;
  /** 狭いところ（ダイアログの中）: ファイルの一覧を上に出す */
  compact?: boolean;
}

function loadLayout(): Layout {
  try {
    return localStorage.getItem(LAYOUT_KEY) === "split" ? "split" : "unified";
  } catch {
    return "unified";
  }
}

function loadViewed(key: string | null | undefined): Record<string, string> {
  if (!key) return {};
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}") as Record<string, string>;
  } catch {
    return {};
  }
}

const markOf = (f: PullFile) => fingerprint(`${f.status}:${f.patch ?? ""}`);
const fileId = (name: string) => `pf-${fingerprint(name)}`;

function FileName({ file }: { file: PullFile }) {
  const cut = file.filename.lastIndexOf("/") + 1;
  const from = file.previous_filename && file.previous_filename !== file.filename ? file.previous_filename : null;
  return (
    <span className="fp" title={from ? `${from} → ${file.filename}` : file.filename}>
      {from && <span className="fp-dir">{from} → </span>}
      <span className="fp-dir">{file.filename.slice(0, cut)}</span>
      <span className="fp-name">{file.filename.slice(cut)}</span>
    </span>
  );
}

/** 追加・削除の割合（GitHub と同じ 5 つの四角） */
function ChangeBar({ added, deleted }: { added: number; deleted: number }) {
  const total = added + deleted;
  const greens = total === 0 ? 0 : Math.round((5 * added) / total);
  const reds = total === 0 ? 0 : 5 - greens;
  return (
    <span className="pf-bar" aria-hidden="true">
      {Array.from({ length: 5 }, (_, i) => (
        <i key={i} className={i < greens ? "a" : i < greens + reds ? "d" : ""} />
      ))}
    </span>
  );
}

/** 変更したファイルの一覧と、ファイルごとの差分（行番号つき。1 列 / 左右に並べる）。行にコメントも付けられる */
export function PullFiles({ files, error, comments = [], onComment, viewedKey, focus, compact }: PullFilesProps) {
  const [layout, setLayoutState] = useState<Layout>(loadLayout);
  const [viewed, setViewed] = useState<Record<string, string>>(() => loadViewed(viewedKey));
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [current, setCurrent] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => setViewed(loadViewed(viewedKey)), [viewedKey]);

  function setLayout(next: Layout) {
    setLayoutState(next);
    try {
      localStorage.setItem(LAYOUT_KEY, next);
    } catch {
      // 覚えられなくても、今は切り替わる
    }
  }

  function toggleViewed(f: PullFile) {
    const next = { ...viewed };
    if (next[f.filename] === markOf(f)) delete next[f.filename];
    else next[f.filename] = markOf(f);
    setViewed(next);
    if (!viewedKey) return;
    try {
      localStorage.setItem(viewedKey, JSON.stringify(next));
    } catch {
      // 覚えられなくても、今は切り替わる
    }
  }

  const isViewed = (f: PullFile) => viewed[f.filename] === markOf(f);
  const isOpen = (f: PullFile) => !folded.has(f.filename) && !isViewed(f);

  function toggleFold(f: PullFile) {
    const next = new Set(folded);
    if (isOpen(f)) next.add(f.filename);
    else {
      next.delete(f.filename);
      if (isViewed(f)) toggleViewed(f);
    }
    setFolded(next);
  }

  function jump(name: string) {
    setCurrent(name);
    const next = new Set(folded);
    next.delete(name);
    setFolded(next);
    window.setTimeout(() => document.getElementById(fileId(name))?.scrollIntoView({ block: "start", behavior: "smooth" }), 30);
  }

  useEffect(() => {
    if (focus && files?.some((f) => f.filename === focus.file)) jump(focus.file);
    // focus.nonce が変わったら（同じファイルでも）送り直す
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [focus?.nonce, files]);

  const byFile = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      if (c.outdated || c.line === null) continue;
      map.set(c.path, [...(map.get(c.path) ?? []), c]);
    }
    return map;
  }, [comments]);

  if (error) return <p className="pf-message error">{error}</p>;
  if (!files) return <p className="pf-message">{tr("変更したファイルを読み込んでいます…")}</p>;
  if (files.length === 0) return <p className="pf-message">{tr("変更したファイルはありません。")}</p>;

  const added = files.reduce((n, f) => n + f.additions, 0);
  const deleted = files.reduce((n, f) => n + f.deletions, 0);
  const seen = files.filter(isViewed).length;

  return (
    <div className={`pf${compact ? " pf--compact" : ""}`}>
      <div className="pf-toolbar">
        <span className="pf-total">
          {trx("<0>{length}</0> ファイル <1>+{added}</1> <2>−{deleted}</2>", { length: files.length, added, deleted }, [<b />, <span className="add" />, <span className="del" />])}
        </span>
        {viewedKey && (
          <span className="pf-seen" title={tr("「見た」に印を付けたファイルは、たたんでおけます（差分が変わると外れます）")}>
            {trx("見た {seen} / {length}", { seen, length: files.length })}
          </span>
        )}
        <span className="grow" />
        <span className="seg" role="group" aria-label={tr("差分の見せ方")}>
          <button type="button" className={layout === "unified" ? "on" : ""} onClick={() => setLayout("unified")} title={tr("消した行（赤）と足した行（緑）を 1 列に")}>
            {tr("1 列")}
          </button>
          <button type="button" className={layout === "split" ? "on" : ""} onClick={() => setLayout("split")} title={tr("左に変える前、右に変えたあとを並べる")}>
            {tr("左右に並べる")}
          </button>
        </span>
        <button type="button" className="btn-sm" onClick={() => setFolded(folded.size > 0 ? new Set() : new Set(files.map((f) => f.filename)))}>
          {folded.size > 0 ? tr("すべて開く") : tr("すべてたたむ")}
        </button>
      </div>
      <div className="pf-body">
        <div className="pf-list" ref={listRef} role="list" aria-label={tr("変更したファイル")}>
          {files.map((f) => (
            <button
              key={f.filename}
              type="button"
              role="listitem"
              className={`pf-item${current === f.filename ? " on" : ""}${isViewed(f) ? " seen" : ""}`}
              onClick={() => jump(f.filename)}
              title={`${STATUS_TITLES[f.status] ?? f.status}: ${f.filename}`}
            >
              <span className={`pf-status s-${f.status}`}>{STATUS_NAMES[f.status] ?? f.status}</span>
              <FileName file={f} />
              {(byFile.get(f.filename)?.length ?? 0) > 0 && <span className="pf-talk">💬{byFile.get(f.filename)?.length}</span>}
              <span className="pf-nums">
                <span className="add">+{f.additions}</span>
                <span className="del">−{f.deletions}</span>
              </span>
              {isViewed(f) && <span className="pf-check" aria-label={tr("見た")}>✓</span>}
            </button>
          ))}
        </div>
        <div className="pf-diffs">
          {files.map((f) => (
            <section key={f.filename} id={fileId(f.filename)} className={`pf-file${current === f.filename ? " on" : ""}`}>
              <header className="pf-file-head">
                <button type="button" className="pf-fold" aria-expanded={isOpen(f)} onClick={() => toggleFold(f)} title={isOpen(f) ? tr("たたむ") : tr("開く")}>
                  {isOpen(f) ? "▾" : "▸"}
                </button>
                <span className={`pf-status s-${f.status}`} title={STATUS_TITLES[f.status]}>
                  {STATUS_NAMES[f.status] ?? f.status}
                </span>
                <FileName file={f} />
                <span className="pf-nums">
                  <span className="add">+{f.additions}</span>
                  <span className="del">−{f.deletions}</span>
                </span>
                <ChangeBar added={f.additions} deleted={f.deletions} />
                {viewedKey && (
                  <label className="pf-viewed" title={tr("見終わったら印を付けます（たたみます）")}>
                    <input type="checkbox" checked={isViewed(f)} onChange={() => toggleViewed(f)} /> {" "}{tr("見た")}
                  </label>
                )}
              </header>
              {isOpen(f) && (
                <FileDiff file={f} layout={layout} comments={byFile.get(f.filename) ?? []} onComment={onComment} />
              )}
            </section>
          ))}
        </div>
      </div>
    </div>
  );
}

interface FileDiffProps {
  file: PullFile;
  layout: Layout;
  comments: ReviewComment[];
  onComment?: (c: LineCommentDraft) => Promise<void>;
}

function FileDiff({ file, layout, comments, onComment }: FileDiffProps) {
  const [limit, setLimit] = useState(FIRST_ROWS);
  const [composer, setComposer] = useState<{ side: "LEFT" | "RIGHT"; line: number } | null>(null);
  const rows = useMemo(() => (file.patch ? parsePatch(file.patch) : []), [file.patch]);
  const threads = useMemo(() => {
    const map = new Map<string, ReviewComment[]>();
    for (const c of comments) {
      if (c.line === null) continue;
      const key = lineKey(c.side, c.line);
      map.set(key, [...(map.get(key) ?? []), c]);
    }
    return map;
  }, [comments]);

  if (!file.patch) {
    return (
      <p className="pf-message">
        {file.status === "renamed" && file.additions + file.deletions === 0
          ? tr("（名前だけの変更です）")
          : tr("（画像などのバイナリか大きすぎる変更なので、GitHub が差分を出していません）")}
      </p>
    );
  }

  // 行のコメント（右の行 → 左の行の順に探す）と、書きかけの欄
  const keysOf = (l: PatchLine | null, side?: "LEFT" | "RIGHT"): string[] => {
    if (!l) return [];
    const keys: string[] = [];
    if (side !== "LEFT" && l.new !== null) keys.push(lineKey("RIGHT", l.new));
    if (side !== "RIGHT" && l.old !== null && l.kind !== "a") keys.push(lineKey("LEFT", l.old));
    return keys;
  };
  const target = (l: PatchLine, side?: "LEFT" | "RIGHT"): { side: "LEFT" | "RIGHT"; line: number } =>
    side === "LEFT" || l.kind === "d" ? { side: "LEFT", line: l.old ?? 0 } : { side: "RIGHT", line: l.new ?? 0 };
  const isComposing = (l: PatchLine | null, side?: "LEFT" | "RIGHT") => {
    if (!l || !composer) return false;
    const t = target(l, side);
    return t.side === composer.side && t.line === composer.line;
  };

  const extras = (keys: string[], composing: boolean) => {
    const list = keys.flatMap((k) => threads.get(k) ?? []);
    if (list.length === 0 && !composing) return null;
    return (
      <div className="pf-thread">
        {list.map((c) => (
          <div key={c.id} className="pf-comment">
            <b>{c.user?.login ?? tr("（不明）")}</b> <span className="muted">{ago(c.at)}</span>
            <div className="pf-comment-body">{c.body}</div>
          </div>
        ))}
        {composing && composer && onComment && (
          <LineComposer
            label={composer.side === "LEFT" ? tr("変える前の {line} 行目にコメント", { line: composer.line }) : tr("{line} 行目にコメント", { line: composer.line })}
            onCancel={() => setComposer(null)}
            onSubmit={async (body) => {
              await onComment({ path: file.filename, line: composer.line, side: composer.side, body });
              setComposer(null);
            }}
          />
        )}
      </div>
    );
  };

  const addButton = (l: PatchLine, side?: "LEFT" | "RIGHT") =>
    onComment ? (
      <button type="button" className="pf-add" title={tr("この行にコメントを付ける")} aria-label={tr("この行にコメントを付ける")} onClick={() => setComposer(target(l, side))}>
        +
      </button>
    ) : null;

  const shown = rows.slice(0, limit);
  const more = rows.length - shown.length;
  const sign = (k: PatchLine["kind"]) => (k === "a" ? "+" : k === "d" ? "−" : " ");

  return (
    <div className={`pf-diff pf-${layout}`}>
      {layout === "unified"
        ? shown.map((r: PatchRow, i) =>
            r.kind === "h" || r.kind === "note" ? (
              <div key={i} className={`pf-row ${r.kind}`}>
                <span className="pf-text">{r.text}</span>
              </div>
            ) : (
              <Fragment key={i}>
                <div className={`pf-row ${r.kind}`}>
                  <span className="pf-no">{r.old ?? ""}</span>
                  <span className="pf-no">
                    {r.new ?? ""}
                    {addButton(r)}
                  </span>
                  <span className="pf-sign">{sign(r.kind)}</span>
                  <span className="pf-code">{r.text}</span>
                </div>
                {extras(keysOf(r), isComposing(r))}
              </Fragment>
            ),
          )
        : splitRows(shown).map((r, i) =>
            r.kind !== "pair" ? (
              <div key={i} className={`pf-row ${r.kind}`}>
                <span className="pf-text">{r.text}</span>
              </div>
            ) : (
              <Fragment key={i}>
                <div className="pf-pair">
                  {(["LEFT", "RIGHT"] as const).map((side) => {
                    const l = side === "LEFT" ? r.left : r.right;
                    const kind = !l ? "empty" : l.kind === "c" ? "c" : l.kind;
                    return (
                      <div key={side} className={`pf-half ${kind}`}>
                        <span className="pf-no">
                          {l ? (side === "LEFT" ? l.old : l.new) ?? "" : ""}
                          {l && addButton(l, side)}
                        </span>
                        <span className="pf-sign">{l ? sign(l.kind) : ""}</span>
                        <span className="pf-code">{l?.text ?? ""}</span>
                      </div>
                    );
                  })}
                </div>
                {extras(
                  r.left === r.right ? keysOf(r.left) : [...keysOf(r.left, "LEFT"), ...keysOf(r.right, "RIGHT")],
                  isComposing(r.left, "LEFT") || isComposing(r.right, "RIGHT"),
                )}
              </Fragment>
            ),
          )}
      {more > 0 && (
        <button type="button" className="pf-more" onClick={() => setLimit(rows.length)}>
          {trx("残りの {more} 行を見る", { more })}
        </button>
      )}
    </div>
  );
}

function LineComposer({ label, onSubmit, onCancel }: { label: string; onSubmit: (body: string) => Promise<void>; onCancel: () => void }) {
  const [body, setBody] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="pf-composer">
      <textarea
        autoFocus
        rows={3}
        value={body}
        placeholder={tr("{trim}（例: ここは画面の外に出ませんか？）", { trim: label.trim() })}
        onChange={(e) => setBody(e.target.value)}
      />
      {error && <p className="git-dialog-error">{error}</p>}
      <div className="pf-composer-actions">
        <span className="muted">{tr("「コメントする」を押すと送られます（レビューのコメントになります）")}</span>
        <span className="grow" />
        <button type="button" className="btn-sm" disabled={busy} onClick={onCancel}>
          {tr("やめる")}
        </button>
        <button
          type="button"
          className="btn-sm primary"
          disabled={busy || body.trim() === ""}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await onSubmit(body);
            } catch (e) {
              setError(String(e));
              setBusy(false);
            }
          }}
        >
          {busy ? tr("送っています…") : tr("コメントする")}
        </button>
      </div>
    </div>
  );
}
