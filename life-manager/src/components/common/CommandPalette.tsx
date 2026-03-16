import { useState } from "react";
import type { GitHubIssue } from "../../lib/types";

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
      await onCreateMemo(memo, "分野:私用");
      setStatus("メモ: " + memo);
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
      <div className="palette" onClick={(e) => e.stopPropagation()}>
        <input
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") handleSubmit(); }}
          placeholder='m テキスト | #番号 | @ラベル名 | 検索語'
          className="palette-input"
        />
      </div>
    </div>
  );
}
