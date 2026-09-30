import { useEffect, useMemo, useState, type ReactNode } from "react";
import { highlightLines } from "../../lib/highlight";
import { decodeText, extOf, looksLikeText, parseCsv } from "../../lib/media";
import { DiffRows, parseDiff } from "../git/DiffView";

/** 長すぎるファイルは、はじめのほうだけ（画面が重くならないように） */
const MAX_LINES = 20000;
/** 大きなファイルは、頭の 2MB だけ文字にする（全部を色分け・表にすると固まる） */
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const headOf = (b: ArrayBuffer) => (b.byteLength > MAX_TEXT_BYTES ? b.slice(0, MAX_TEXT_BYTES) : b);

interface CodeViewProps {
  bytes: ArrayBuffer;
  path: string;
  /** このコミットでの、このファイルの差分を読む（なければ「このコミットの変更」は出さない） */
  loadPatch?: () => Promise<string | null>;
  onInfo?: (text: string) => void;
}

/** コード・テキスト（色分け・行の番号・折り返し。「このコミットの変更」では差分） */
export function CodeView({ bytes, path, loadPatch, onInfo }: CodeViewProps) {
  const text = useMemo(() => (looksLikeText(bytes) ? decodeText(headOf(bytes)) : null), [bytes]);
  const cut = bytes.byteLength > MAX_TEXT_BYTES;
  const [mode, setMode] = useState<"file" | "patch">("file");
  const [wrap, setWrap] = useState(false);
  const [patch, setPatch] = useState<string | null | undefined>(undefined);
  // 色分けするのも、出す行（とその次の 1 行。長いかどうかを知るため）まで
  const lines = useMemo(() => (text === null ? [] : highlightLines(text.split("\n").slice(0, MAX_LINES + 1).join("\n"), extOf(path))), [text, path]);
  const long = cut || lines.length > MAX_LINES;

  useEffect(() => {
    if (text !== null) onInfo?.(long ? `${MAX_LINES.toLocaleString()} 行より長い` : `${lines.length.toLocaleString()} 行`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, lines.length]);

  useEffect(() => {
    if (mode !== "patch" || patch !== undefined || !loadPatch) return;
    loadPatch().then(setPatch).catch(() => setPatch(null));
  }, [mode, patch, loadPatch]);

  if (text === null) {
    return <div className="mv-main full"><p className="mv-note center">中身が文字ではないので、ここでは見られません</p></div>;
  }
  const shown = lines.slice(0, MAX_LINES);
  const rows = patch ? parseDiff(patch) : [];

  return (
    <div className="mv-main full">
      <div className="mv-stage mv-code-stage">
        <div className="mv-toolbar right">
          {loadPatch && (
            <>
              <button type="button" className={`btn-sm${mode === "file" ? " on" : ""}`} onClick={() => setMode("file")}>ファイル全体</button>
              <button type="button" className={`btn-sm${mode === "patch" ? " on" : ""}`} onClick={() => setMode("patch")}>このコミットの変更</button>
            </>
          )}
          <button type="button" className={`btn-sm${wrap ? " on" : ""}`} aria-pressed={wrap} onClick={() => setWrap(!wrap)}>折り返す</button>
        </div>
        {mode === "patch" ? (
          <div className="mv-patch dr-diff">
            {patch === undefined ? <p className="mv-note">読み込んでいます…</p> : rows.length === 0 ? <p className="mv-note">このコミットでの差分はありません（名前だけの変更・バイナリなど）</p> : <DiffRows rows={rows} />}
          </div>
        ) : (
          <pre className={`mv-code${wrap ? " wrap" : ""}`}>
            {shown.map((tokens, i) => (
              <div key={i} className="mv-line">
                <span className="mv-ln">{i + 1}</span>
                <span className="mv-tx">
                  {tokens.length === 0 ? " " : tokens.map((t, j) => (t.t === "plain" ? t.s : <span key={j} className={`hl-${t.t}`}>{t.s}</span>))}
                </span>
              </div>
            ))}
            {long && <div className="mv-note">…（長いので、はじめのほうだけ出しています。全部は「外部のアプリで開く」か、エディターで）</div>}
          </pre>
        )}
      </div>
    </div>
  );
}

/** Markdown の 1 行の中（太字・斜体・コード・リンク）。HTML は使わず、そのままの文字として出す */
function inline(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*|__[^_]+__)|(\*[^*]+\*|_[^_]+_)|(\[([^\]]+)\]\(([^)]+)\))/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let n = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const k = `${key}-${n++}`;
    if (m[1]) out.push(<code key={k}>{m[1].slice(1, -1)}</code>);
    else if (m[2]) out.push(<b key={k}>{m[2].slice(2, -2)}</b>);
    else if (m[3]) out.push(<i key={k}>{m[3].slice(1, -1)}</i>);
    else if (m[4]) out.push(<span key={k} className="mv-md-link" title={m[6]}>{m[5]}</span>);
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Markdown を整えて（見出し・箇条書き・番号・引用・コード・区切り線）。そのままの文字でも見られる */
export function MarkdownView({ bytes }: { bytes: ArrayBuffer }) {
  const text = useMemo(() => decodeText(headOf(bytes)), [bytes]);
  const [raw, setRaw] = useState(false);
  const blocks = useMemo(() => {
    const out: ReactNode[] = [];
    const lines = text.replace(/\r\n?/g, "\n").split("\n");
    let i = 0;
    let key = 0;
    while (i < lines.length) {
      const line = lines[i];
      const k = `b${key++}`;
      if (line.startsWith("```")) {
        const body: string[] = [];
        i++;
        while (i < lines.length && !lines[i].startsWith("```")) body.push(lines[i++]);
        i++;
        out.push(<pre key={k} className="mv-md-pre">{body.join("\n")}</pre>);
        continue;
      }
      const h = line.match(/^(#{1,6})\s+(.*)$/);
      if (h) {
        const level = Math.min(h[1].length, 4);
        out.push(<div key={k} className={`mv-md-h mv-md-h${level}`}>{inline(h[2], k)}</div>);
        i++;
        continue;
      }
      if (/^(\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(line)) {
        const items: ReactNode[] = [];
        const ordered = /^\s*\d/.test(line);
        while (i < lines.length && /^(\s*[-*+]\s+|\s*\d+[.)]\s+)/.test(lines[i])) {
          const body = lines[i].replace(/^(\s*[-*+]\s+|\s*\d+[.)]\s+)/, "").replace(/^\[( |x)\]\s*/i, (_, c) => (c === " " ? "☐ " : "☑ "));
          items.push(<li key={`${k}-${items.length}`}>{inline(body, `${k}-${items.length}`)}</li>);
          i++;
        }
        out.push(ordered ? <ol key={k}>{items}</ol> : <ul key={k}>{items}</ul>);
        continue;
      }
      if (line.startsWith(">")) {
        out.push(<blockquote key={k}>{inline(line.replace(/^>\s?/, ""), k)}</blockquote>);
        i++;
        continue;
      }
      if (/^\s*([-*_])\s*\1\s*\1[\s\-*_]*$/.test(line)) {
        out.push(<hr key={k} />);
        i++;
        continue;
      }
      if (line.trim() === "") {
        i++;
        continue;
      }
      const para: string[] = [];
      while (i < lines.length && lines[i].trim() !== "" && !/^(#{1,6}\s|```|>|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i])) para.push(lines[i++]);
      out.push(<p key={k}>{inline(para.join(" "), k)}</p>);
    }
    return out;
  }, [text]);
  return (
    <div className="mv-main full">
      <div className="mv-stage mv-doc-stage">
        <div className="mv-toolbar right">
          <button type="button" className={`btn-sm${!raw ? " on" : ""}`} onClick={() => setRaw(false)}>整えて</button>
          <button type="button" className={`btn-sm${raw ? " on" : ""}`} onClick={() => setRaw(true)}>そのまま</button>
        </div>
        {raw ? <pre className="mv-code wrap">{text}</pre> : <div className="mv-md">{blocks}</div>}
      </div>
    </div>
  );
}

/** CSV・TSV を表で（2000 行まで）。そのままの文字でも見られる */
export function CsvView({ bytes, path, onInfo }: { bytes: ArrayBuffer; path: string; onInfo?: (text: string) => void }) {
  const text = useMemo(() => decodeText(headOf(bytes)), [bytes]);
  const rows = useMemo(() => parseCsv(text, extOf(path) === "tsv" ? "\t" : ","), [text, path]);
  const [raw, setRaw] = useState(false);
  useEffect(() => {
    onInfo?.(`${Math.max(0, rows.length - 1).toLocaleString()} 行 ・ ${rows[0]?.length ?? 0} 列`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows]);
  const [head, ...body] = rows;
  return (
    <div className="mv-main full">
      <div className="mv-stage mv-doc-stage">
        <div className="mv-toolbar right">
          <button type="button" className={`btn-sm${!raw ? " on" : ""}`} onClick={() => setRaw(false)}>表</button>
          <button type="button" className={`btn-sm${raw ? " on" : ""}`} onClick={() => setRaw(true)}>そのまま</button>
        </div>
        {raw ? (
          <pre className="mv-code wrap">{text}</pre>
        ) : (
          <div className="mv-table-wrap">
            <table className="mv-table">
              {head && (
                <thead>
                  <tr><th className="mv-ln">#</th>{head.map((c, i) => <th key={i}>{c}</th>)}</tr>
                </thead>
              )}
              <tbody>
                {body.slice(0, 2000).map((r, i) => (
                  <tr key={i}><td className="mv-ln">{i + 1}</td>{r.map((c, j) => <td key={j}>{c}</td>)}</tr>
                ))}
              </tbody>
            </table>
            {body.length > 2000 && <p className="mv-note">…（はじめの 2,000 行だけ出しています）</p>}
          </div>
        )}
      </div>
    </div>
  );
}

/** プレビューのページが、外（インターネット・学校や家のネットワーク）に出ないようにする決まり。スクリプトと、ページの中の画像などは動く */
const PREVIEW_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:">`;

/** ページの頭（<head> のすぐあと。なければ <!DOCTYPE> のあと、それもなければ先頭）に、決まりを入れる */
function withPreviewCsp(html: string): string {
  const head = html.match(/<head[^>]*>/i);
  if (head && head.index !== undefined) {
    const at = head.index + head[0].length;
    return html.slice(0, at) + PREVIEW_CSP + html.slice(at);
  }
  const doctype = html.match(/^\s*<!doctype[^>]*>/i);
  if (doctype) return doctype[0] + PREVIEW_CSP + html.slice(doctype[0].length);
  return PREVIEW_CSP + html;
}

/** HTML（この画面の中だけで動かす。アプリや PC には触れない。外のネットワークにも出ない） */
export function HtmlView({ bytes, onOpenOutside }: { bytes: ArrayBuffer; onOpenOutside?: () => void }) {
  const text = useMemo(() => withPreviewCsp(decodeText(bytes)), [bytes]);
  return (
    <div className="mv-main full">
      <div className="mv-stage mv-html-stage">
        <div className="mv-html-note">
          🛡 この画面の中だけで動きます（アプリや PC には触れません）。ほかのファイル（画像・CSS）は読めないことがあります
          {onOpenOutside && <button type="button" className="btn-sm" onClick={onOpenOutside}>ブラウザで開く</button>}
        </div>
        <iframe className="mv-html" title="HTML" sandbox="allow-scripts" srcDoc={text} />
      </div>
    </div>
  );
}
