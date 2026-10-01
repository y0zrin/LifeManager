import type { GitLineStat, GitRun } from "../../lib/types";

export type DiffRow = { kind: "f" | "h" | "a" | "d" | "c" | "note"; text: string };

const MAX_ROWS = 2000;

/**
 * git diff の出力を行ごとに分ける。見出し（index・--- ・+++）は省く。
 * withFiles なら、ファイルごとの区切り（diff --git）をファイル名の行（f）にする（複数のファイルの差分用）
 */
export function parseDiff(text: string, withFiles = false): DiffRow[] {
  const rows: DiffRow[] = [];
  let inHunk = false;
  for (const line of text.split("\n")) {
    if (line.startsWith("diff --git ")) {
      inHunk = false;
      if (withFiles) rows.push({ kind: "f", text: line.replace(/^diff --git a\/(.*) b\/(.*)$/, (_, a, b) => (a === b ? b : `${a} → ${b}`)) });
    } else if (line.startsWith("@@")) {
      inHunk = true;
      rows.push({ kind: "h", text: line });
    } else if (!inHunk) {
      if (line.startsWith("Binary files")) rows.push({ kind: "note", text: "バイナリファイルのため、中身は表示しません" });
      // バックエンドからのお知らせ（大きいファイルなど）
      else if (line.startsWith("（")) rows.push({ kind: "note", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "a", text: line });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "d", text: line });
    } else if (line !== "") {
      rows.push({ kind: "c", text: line });
    }
  }
  return rows;
}

interface DiffViewProps {
  /** ファイルのパス */
  title: string;
  lines?: GitLineStat | null;
  run: GitRun | null;
  error: string | null;
  loading: boolean;
}

/** 差分（追加は緑・削除は赤）。いちばん上に、差分を出したコマンドを小さく見せる */
export function DiffView({ title, lines, run, error, loading }: DiffViewProps) {
  const rows = run ? parseDiff(run.output) : [];
  return (
    <div className="dr-diff">
      <div className="dr-diff-head">
        <span className="dr-diff-path" title={title}>{title}</span>
        {lines && <span className="add">+{lines.added}</span>}
        {lines && lines.deleted > 0 && <span className="del">−{lines.deleted}</span>}
        {run && <code className="dr-diff-cmd" title="この差分を出したコマンド">{run.command}</code>}
      </div>
      {error ? (
        <div className="note error">{error}</div>
      ) : !run ? (
        <div className="note">{loading ? "読み込んでいます…" : ""}</div>
      ) : rows.length === 0 ? (
        <div className="note">表示できる差分はありません。ファイルの権限や種類だけが変わった可能性があります</div>
      ) : (
        <DiffRows rows={rows} />
      )}
    </div>
  );
}

/** 差分の行（追加は緑・削除は赤・f はファイル名の見出し） */
export function DiffRows({ rows }: { rows: DiffRow[] }) {
  return (
    <div className="diff">
      {rows.slice(0, MAX_ROWS).map((r, i) => (
        <div key={i} className={r.kind}>{r.text}</div>
      ))}
      {rows.length > MAX_ROWS && <div className="note">…（長いので、最初の {MAX_ROWS} 行だけ表示しています）</div>}
    </div>
  );
}
