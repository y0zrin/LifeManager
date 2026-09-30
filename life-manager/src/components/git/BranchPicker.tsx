import { useCallback, useRef, useState } from "react";
import { useDismiss } from "../../hooks/useDismiss";
import { shortWhen, type BranchEntry } from "../../lib/history";
import type { GitCommit } from "../../lib/types";
import { isEnter } from "../../lib/keys";

interface BranchPickerProps {
  entries: BranchEntry[];
  selected: string | null;
  byHash: Map<string, GitCommit>;
  /** 履歴をこの PC の git から読んだか（GitHub にだけあるブランチの印を出すかどうか） */
  local: boolean;
  onPick: (name: string) => void;
  /** 右クリックで、そのブランチの操作のメニュー */
  onMenu?: (pos: { x: number; y: number }, entry: BranchEntry) => void;
}

/** 「☰ ブランチ一覧」: ブランチ画面ではそのページへ、全体図ではそのブランチの位置へ移る */
export function BranchPicker({ entries, selected, byHash, local, onPick, onMenu }: BranchPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);
  useDismiss(ref, open, close);

  const index = entries.findIndex((e) => e.name === selected);
  const q = query.trim().toLowerCase();
  const list = entries.filter((e) => !q || e.name.toLowerCase().includes(q));
  const main = list.filter((e) => e.isDefault || e.isCurrent);
  const others = list.filter((e) => !e.isDefault && !e.isCurrent);

  function pick(name: string) {
    setOpen(false);
    onPick(name);
  }

  const item = (e: BranchEntry) => {
    const tip = byHash.get(e.tip);
    const badges = [
      local && !e.onPc ? "GitHub にだけある" : "",
      e.info?.ahead ? `↑${e.info.ahead}` : "",
      e.info?.behind ? `↓${e.info.behind}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <button
        key={e.name}
        type="button"
        className={`bl-item${e.name === selected ? " on" : ""}`}
        onClick={() => pick(e.name)}
        onContextMenu={(ev) => {
          if (!onMenu) return;
          ev.preventDefault();
          setOpen(false);
          onMenu({ x: ev.clientX, y: ev.clientY }, e);
        }}
      >
        <span className="bl-name">
          {e.name}
          {e.isCurrent && <span className="bl-co">チェックアウト中</span>}
        </span>
        <span className="bl-meta">{tip ? shortWhen(tip.date) : ""}</span>
        <span className="bl-sub">{e.isDefault ? "既定のブランチ" : tip?.subject ?? ""}</span>
        {badges && <span className="bl-sync">{badges}</span>}
      </button>
    );
  };

  return (
    <div className="blist" ref={ref}>
      <button type="button" className={`tbtn${open ? " open" : ""}`} onClick={() => { setQuery(""); setOpen(!open); }}>
        ☰ ブランチ一覧
        {index >= 0 && <span className="bl-pos">{index + 1} / {entries.length}</span>}
      </button>
      {open && (
        <div className="bl-panel popover">
          <input
            className="input-full bsw-filter"
            placeholder="ブランチを絞り込む"
            autoFocus
            autoComplete="off"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => { if (isEnter(e) && list[0]) pick(list[0].name); }}
          />
          {main.length > 0 && <div className="bsw-group">主要</div>}
          {main.map(item)}
          {others.length > 0 && <div className="bsw-group">そのほか</div>}
          {others.map(item)}
          {list.length === 0 && <div className="bsw-empty">一致するブランチはありません</div>}
        </div>
      )}
    </div>
  );
}
