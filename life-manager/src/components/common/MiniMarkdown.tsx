import { Fragment, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";

interface MiniMarkdownProps {
  text: string;
  /** ふつうの文字の中身（#45 を押せるようにする など） */
  renderText?: (text: string) => ReactNode;
}

const INLINE = /(\*\*[^*]+\*\*|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/;

/** リリースノートなどの簡単な Markdown（見出し・箇条書き・段落・**太字**・`コード`・[文字](URL)）を見やすく出す */
export function MiniMarkdown({ text, renderText }: MiniMarkdownProps) {
  const plain = (s: string) => (renderText ? renderText(s) : s);
  const inline = (s: string): ReactNode =>
    s.split(INLINE).map((part, i) => {
      if (/^\*\*[^*]+\*\*$/.test(part)) return <b key={i}>{plain(part.slice(2, -2))}</b>;
      if (/^`[^`]+`$/.test(part)) return <code key={i}>{part.slice(1, -1)}</code>;
      const link = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(part);
      if (link) {
        const url = link[2];
        return /^https?:\/\//.test(url) ? (
          <button key={i} type="button" className="pr-ref" onClick={() => openUrl(url).catch(() => {})}>
            {link[1]}
          </button>
        ) : (
          <Fragment key={i}>{link[1]}</Fragment>
        );
      }
      return <Fragment key={i}>{plain(part)}</Fragment>;
    });

  const blocks: ReactNode[] = [];
  let list: string[] = [];
  let para: string[] = [];
  const flushList = () => {
    if (list.length === 0) return;
    const items = list;
    list = [];
    blocks.push(
      <ul key={`ul${blocks.length}`} className="md-list">
        {items.map((it, i) => (
          <li key={i}>{inline(it)}</li>
        ))}
      </ul>,
    );
  };
  const flushPara = () => {
    if (para.length === 0) return;
    const lines = para;
    para = [];
    blocks.push(
      <p key={`p${blocks.length}`} className="md-p">
        {lines.map((l, i) => (
          <Fragment key={i}>
            {i > 0 && <br />}
            {inline(l)}
          </Fragment>
        ))}
      </p>,
    );
  };

  for (const line of text.replace(/\r\n/g, "\n").split("\n")) {
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    const item = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (heading) {
      flushList();
      flushPara();
      blocks.push(
        <div key={`h${blocks.length}`} className={`md-h md-h${Math.min(heading[1].length, 4)}`}>
          {inline(heading[2])}
        </div>,
      );
    } else if (item) {
      flushPara();
      list.push(item[1]);
    } else if (line.trim() === "") {
      flushList();
      flushPara();
    } else {
      flushList();
      para.push(line);
    }
  }
  flushList();
  flushPara();
  return <div className="md">{blocks}</div>;
}
