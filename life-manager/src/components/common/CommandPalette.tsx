import { useState } from "react";
import type { GitHubIssue } from "../../lib/types";
import { isEnter } from "../../lib/keys";
import { tr, trx } from "../../lib/i18n";

interface CommandPaletteProps {
  issues: GitHubIssue[];
  onCreateMemo: (text: string, theme: string) => Promise<void>;
  onFilterChange: (label: string) => void;
  setStatus: (s: string) => void;
  onClose: () => void;
}

export function CommandPalette({ issues, onCreateMemo, onFilterChange, setStatus, onClose }: CommandPaletteProps) {
  const [input, setInput] = useState("");

  async function handleSubmit() {
    const text = input.trim();
    if (!text) return;
    onClose();

    if (text.startsWith("m ")) {
      const memo = text.substring(2);
      try {
        await onCreateMemo(memo, "");
        setStatus(tr("メモ: ") + memo);
      } catch {
        // 送れなかったメモは、一覧に「送れませんでした」で残る（知らせは上のバーに出ている）
      }
    } else if (text.startsWith("#")) {
      const num = parseInt(text.substring(1));
      if (!isNaN(num)) {
        const found = issues.find((i) => i.number === num);
        if (found) setStatus(`#${num}: ${found.title}`);
        else setStatus(tr("#{num} が見つかりません", { num }));
      }
    } else if (text.startsWith("@")) {
      onFilterChange(text.substring(1));
    } else {
      onFilterChange("");
      const matching = issues.filter(
        (i) => i.title.includes(text) || (i.body && i.body.includes(text))
      );
      setStatus(tr("\"{text}\" で {length} 件ヒット", { text, length: matching.length }));
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" role="dialog" aria-label={tr("コマンド")} onClick={(e) => e.stopPropagation()}>
        <div className="palette-title">{tr("何をしますか？")}</div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (isEnter(e)) handleSubmit(); }}
          placeholder={tr("例: m 効果音を探す ／ #12 ／ @セクション:プログラマー ／ ジャンプ")}
          className="palette-input"
        />
        {/* 打てるもの（頭の文字で切り替わる） */}
        <ul className="palette-hints">
          <li>{trx("<0>m</0> テキスト<1>メモにする</1>", undefined, [<kbd />, <span />])}</li>
          <li>{trx("<0>#</0>番号<1>その Issue を探す</1>", undefined, [<kbd />, <span />])}</li>
          <li>{trx("<0>@</0>ラベル名<1>そのラベルのタスクを表示する</1>", undefined, [<kbd />, <span />])}</li>
          <li>{trx("ことば<0>題名と本文から探す</0>", undefined, [<span />])}</li>
        </ul>
      </div>
    </div>
  );
}
