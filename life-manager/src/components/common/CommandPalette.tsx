import { useState } from "react";
import type { GitHubIssue } from "../../lib/types";
import { isEnter } from "../../lib/keys";

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
        setStatus("メモ: " + memo);
      } catch {
        // 送れなかったメモは、一覧に「送れませんでした」で残る（知らせは上のバーに出ている）
      }
    } else if (text.startsWith("#")) {
      const num = parseInt(text.substring(1));
      if (!isNaN(num)) {
        const found = issues.find((i) => i.number === num);
        if (found) setStatus(`#${num}: ${found.title}`);
        else setStatus(`#${num} が見つかりません`);
      }
    } else if (text.startsWith("@")) {
      onFilterChange(text.substring(1));
    } else {
      onFilterChange("");
      const matching = issues.filter(
        (i) => i.title.includes(text) || (i.body && i.body.includes(text))
      );
      setStatus(`"${text}" で ${matching.length} 件ヒット`);
    }
  }

  return (
    <div className="palette-overlay" onClick={onClose}>
      <div className="palette" role="dialog" aria-label="コマンド" onClick={(e) => e.stopPropagation()}>
        <div className="palette-title">何をしますか？</div>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (isEnter(e)) handleSubmit(); }}
          placeholder="例: m 効果音を探す ／ #12 ／ @セクション:プログラマー ／ ジャンプ"
          className="palette-input"
        />
        {/* 打てるもの（頭の文字で切り替わる） */}
        <ul className="palette-hints">
          <li><kbd>m</kbd> テキスト<span>メモにする</span></li>
          <li><kbd>#</kbd>番号<span>その Issue を探す</span></li>
          <li><kbd>@</kbd>ラベル名<span>そのラベルのタスクを表示する</span></li>
          <li>ことば<span>題名と本文から探す</span></li>
        </ul>
      </div>
    </div>
  );
}
