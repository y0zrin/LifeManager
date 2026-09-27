import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { GitCommit, GitHistory, GitStatus } from "../../lib/types";
import {
  aheadBehind,
  appCommitBreakdown,
  appCommitKind,
  dayKey,
  firstParentChain,
  isMerge,
  longDay,
  shortWhen,
  timeOf,
  type BranchEntry,
} from "../../lib/history";
import { easeScrollTo } from "../../lib/motion";
import type { GitActions } from "../../hooks/useGitActions";
import { BranchPicker } from "../git/BranchPicker";

interface BranchesViewProps {
  history: GitHistory;
  entries: BranchEntry[];
  byHash: Map<string, GitCommit>;
  /** 見ているブランチ（全体図と共有） */
  selected: string | null;
  onSelect: (name: string) => void;
  /** 全体図でコミットを選んで来たとき。そのコミットまでスクロールして目立たせる */
  focusCommit: string | null;
  onFocusHandled: () => void;
  /** この PC の git のときだけ */
  status: GitStatus | null;
  actions: GitActions | null;
  onOpenWork: () => void;
  onOpenOverview: () => void;
  /** コミット・ブランチの操作のメニュー（右クリック・「⋯」） */
  onCommitMenu: (pos: MenuPos, commit: GitCommit) => void;
  onBranchMenu: (pos: MenuPos, entry: BranchEntry) => void;
}

type MenuPos = { x: number; y: number };

/** 「⋯」ボタンの下にメニューを出す位置 */
export const belowButton = (el: HTMLElement): MenuPos => {
  const r = el.getBoundingClientRect();
  return { x: r.right - 300, y: r.bottom + 4 };
};

const MAX_CHAIN = 300;

export function roleOf(e: BranchEntry, local: boolean): string {
  const parts: string[] = [];
  if (e.isDefault) parts.push("既定のブランチ");
  if (e.isCurrent) parts.push("チェックアウト中");
  if (local && !e.onPc) parts.push("GitHub にだけある");
  if (local && e.onPc && !e.onGitHub) parts.push("この PC にだけある");
  return parts.join("・") || "ブランチ";
}

/** ブランチ画面: ブランチごとのページを左右にスライドして見る。名前の帯はスライドに合わせて大きさが変わる */
export function BranchesView(props: BranchesViewProps) {
  const { entries, selected, onSelect } = props;
  const found = entries.findIndex((e) => e.name === selected);
  const index = found >= 0 ? found : 0;
  const pagerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(index);
  const stopAnim = useRef<(() => void) | null>(null);
  const placed = useRef(false);
  const settleTimer = useRef(0);
  const frame = useRef(0);

  // 外から（一覧・全体図・矢印）ブランチが変わったら、そのページへスライドする（最初の表示だけは動かさずに置く）
  useLayoutEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    const target = index * el.clientWidth;
    if (!placed.current) {
      placed.current = true;
      el.scrollLeft = target;
      setPos(index);
      return;
    }
    if (Math.abs(el.scrollLeft - target) < 2) return;
    stopAnim.current?.();
    stopAnim.current = easeScrollTo(el, { left: target });
  }, [index]);

  // 窓の大きさが変わったら、今のページにそろえ直す
  useEffect(() => {
    const onResize = () => {
      const el = pagerRef.current;
      if (el) el.scrollLeft = index * el.clientWidth;
    };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [index]);

  const onScroll = () => {
    const el = pagerRef.current;
    if (!el || !el.clientWidth) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setPos(el.scrollLeft / el.clientWidth));
    // 指やホイールで動かして止まったら、そのページのブランチを選んだことにする
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const i = Math.round(el.scrollLeft / el.clientWidth);
      if (entries[i] && entries[i].name !== selected) onSelect(entries[i].name);
    }, 140);
  };

  useEffect(() => () => {
    stopAnim.current?.();
    cancelAnimationFrame(frame.current);
    window.clearTimeout(settleTimer.current);
  }, []);

  const go = useCallback(
    (i: number) => {
      const e = entries[Math.max(0, Math.min(entries.length - 1, i))];
      if (e) onSelect(e.name);
    },
    [entries, onSelect],
  );

  // ← → で隣のブランチへ
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      const t = e.target as HTMLElement;
      if (t.closest?.("input, textarea, select, [contenteditable]")) return;
      if (e.key === "ArrowLeft") go(index - 1);
      else if (e.key === "ArrowRight") go(index + 1);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, index]);

  const local = props.history.source === "local";
  const defaultEntry = entries.find((e) => e.isDefault) ?? null;
  const near = Math.round(pos);

  if (entries.length === 0) {
    return (
      <div className="content">
        <p className="work-loading">ブランチがまだありません（最初のコミットをすると、ブランチができます）</p>
      </div>
    );
  }

  return (
    <div className="bview">
      <div className="bv-strip">
        <button type="button" className="bv-edge l" aria-label="前のブランチ" disabled={index === 0} onClick={() => go(index - 1)}>
          ‹
        </button>
        <div className="bv-names">
          {entries.map((e, i) => {
            const d = i - pos;
            if (Math.abs(d) > 2.2) return null;
            const k = Math.max(0, 1 - Math.min(1, Math.abs(d)));
            return (
              <button
                key={e.name}
                type="button"
                onContextMenu={(ev) => {
                  ev.preventDefault();
                  props.onBranchMenu({ x: ev.clientX, y: ev.clientY }, e);
                }}
                className={`bv-name${i === index ? " on" : ""}`}
                style={{
                  left: `calc(50% + ${d * 36}%)`,
                  transform: `translateX(-50%) scale(${0.62 + 0.38 * k})`,
                  opacity: 1 - Math.min(1, Math.abs(d)) * 0.45 - Math.max(0, Math.abs(d) - 1) * 0.5,
                }}
                tabIndex={Math.abs(d) < 1.5 ? 0 : -1}
                onClick={() => go(i)}
              >
                {e.name}
              </button>
            );
          })}
        </div>
        <div className="bv-role">{roleOf(entries[index], local)}</div>
        <button
          type="button"
          className="bv-edge r"
          aria-label="次のブランチ"
          disabled={index === entries.length - 1}
          onClick={() => go(index + 1)}
        >
          ›
        </button>
        <div className="bv-tools">
          <BranchPicker
            entries={entries}
            selected={entries[index].name}
            byHash={props.byHash}
            local={local}
            onPick={onSelect}
            onMenu={props.onBranchMenu}
          />
        </div>
      </div>

      <div className="bv-pager" ref={pagerRef} onScroll={onScroll}>
        {entries.map((e, i) => (
          <div key={e.name} className="bv-page">
            {Math.abs(i - near) <= 1 && (
              <BranchPage
                entry={e}
                history={props.history}
                byHash={props.byHash}
                defaultEntry={defaultEntry}
                status={e.isCurrent ? props.status : null}
                actions={props.actions}
                focusCommit={i === index ? props.focusCommit : null}
                onFocusHandled={props.onFocusHandled}
                onOpenWork={props.onOpenWork}
                onOpenOverview={props.onOpenOverview}
                onCommitMenu={props.onCommitMenu}
                onBranchMenu={props.onBranchMenu}
              />
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

// --- 1 本のブランチのページ ---

type Item = { kind: "one"; commit: GitCommit } | { kind: "app"; commits: GitCommit[] };

interface BranchPageProps {
  entry: BranchEntry;
  history: GitHistory;
  byHash: Map<string, GitCommit>;
  defaultEntry: BranchEntry | null;
  status: GitStatus | null;
  actions: GitActions | null;
  focusCommit: string | null;
  onFocusHandled: () => void;
  onOpenWork: () => void;
  onOpenOverview: () => void;
  onCommitMenu: (pos: MenuPos, commit: GitCommit) => void;
  onBranchMenu: (pos: MenuPos, entry: BranchEntry) => void;
}

const BranchPage = memo(function BranchPage({
  entry,
  history,
  byHash,
  defaultEntry,
  status,
  actions,
  focusCommit,
  onFocusHandled,
  onOpenWork,
  onOpenOverview,
  onCommitMenu,
  onBranchMenu,
}: BranchPageProps) {
  const local = history.source === "local";
  const chain = useMemo(() => firstParentChain(byHash, entry.tip, MAX_CHAIN), [byHash, entry.tip]);
  const vsDefault = useMemo(
    () => (defaultEntry && !entry.isDefault ? aheadBehind(byHash, entry.tip, defaultEntry.tip) : null),
    [byHash, entry.tip, entry.isDefault, defaultEntry],
  );

  // コミットに付いているラベル（このブランチ自身は出さない。GitHub の控えは「GitHub の位置」として出す）
  const chipsAt = useMemo(() => {
    const map = new Map<string, { kind: string; name: string }[]>();
    for (const r of history.refs) {
      if (r.kind === "branch" && r.name === entry.name) continue;
      if (r.kind === "remote" && r.name !== `origin/${entry.name}`) continue;
      if (r.kind === "remote" && r.hash === entry.tip) continue;
      const chip = r.kind === "remote" ? { kind: "remote", name: "GitHub の位置" } : { kind: r.kind, name: r.name };
      map.set(r.hash, [...(map.get(r.hash) ?? []), chip]);
    }
    return map;
  }, [history.refs, entry.name, entry.tip]);

  // 日ごとに分け、アプリの自動コミットはその日のうちでまとめる
  const days = useMemo(() => {
    const out: { key: string; label: string; items: Item[]; app: Item | null }[] = [];
    for (const c of chain) {
      const key = dayKey(c.date);
      let day = out[out.length - 1];
      if (!day || day.key !== key) {
        day = { key, label: longDay(c.date), items: [], app: null };
        out.push(day);
      }
      if (appCommitKind(c.subject) && !chipsAt.has(c.hash)) {
        if (day.app && day.app.kind === "app") day.app.commits.push(c);
        else {
          day.app = { kind: "app", commits: [c] };
          day.items.push(day.app);
        }
      } else {
        day.items.push({ kind: "one", commit: c });
      }
    }
    return out;
  }, [chain, chipsAt]);

  // 全体図から来たら、そのコミットまで動かして目立たせる（まとめの中なら開く）
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!focusCommit) return;
    const box = scrollRef.current;
    const row = box?.querySelector<HTMLElement>(`[data-hash="${focusCommit}"]`);
    if (box && row) {
      const details = row.closest("details");
      if (details) details.open = true;
      const top = row.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop - box.clientHeight / 3;
      easeScrollTo(box, { top: Math.max(0, top) });
      row.classList.remove("flash");
      void row.offsetWidth;
      row.classList.add("flash");
    }
    onFocusHandled();
  }, [focusCommit, onFocusHandled]);

  const tip = byHash.get(entry.tip);
  const changes = status?.files.length ?? 0;
  const info = entry.info;

  const row = (c: GitCommit) => (
    <div
      key={c.hash}
      className={`c-row${isMerge(c) ? " merge" : ""}`}
      data-hash={c.hash}
      onContextMenu={(ev) => {
        ev.preventDefault();
        onCommitMenu({ x: ev.clientX, y: ev.clientY }, c);
      }}
    >
      <span className="c-time">{timeOf(c.date)}</span>
      <span className={`c-dot${isMerge(c) ? " merge" : ""}`} />
      <span className="c-msg" title={`${c.subject}\n${c.author}`}>{c.subject}</span>
      <span className="c-chips">
        {(chipsAt.get(c.hash) ?? []).map((ch) => (
          <span key={`${ch.kind}:${ch.name}`} className={`chip ${ch.kind}`}>
            {ch.kind === "tag" ? "🏷️" : ch.kind === "remote" ? "☁" : "🌿"} {ch.name}
          </span>
        ))}
      </span>
      <code className="c-hash">{c.hash.slice(0, 7)}</code>
      <button
        type="button"
        className="row-more"
        aria-label="コミットの操作"
        title="コミットの操作（右クリックでも開けます）"
        onClick={(ev) => onCommitMenu(belowButton(ev.currentTarget), c)}
      >
        ⋯
      </button>
    </div>
  );

  return (
    <div className="bv-scroll" ref={scrollRef}>
      <div className="p-info">
        <div className="p-chips">
          {info && info.ahead > 0 && <span className="chip warn" title="まだ GitHub に送っていないコミット">↑{info.ahead} 未プッシュ</span>}
          {info && info.behind > 0 && <span className="chip warn" title="GitHub にあって、まだ取り込んでいないコミット">↓{info.behind} 未プル</span>}
          {info?.gone && <span className="chip ng">GitHub で削除済み</span>}
          {local && entry.onPc && !entry.onGitHub && <span className="chip muted">未公開</span>}
          {local && !entry.onPc && <span className="chip muted">GitHub にだけある</span>}
          {entry.isCurrent && changes > 0 && (
            <button type="button" className="chip wip-link" onClick={onOpenWork}>
              ✎ 作業中の変更 {changes} → 作業
            </button>
          )}
          <span className="p-actions">
            {local && actions && !entry.isCurrent && (
              <button type="button" className="btn-sm" onClick={() => actions.requestSwitch(entry.name)} title={`git switch ${entry.name}`}>
                このブランチに切り替える
              </button>
            )}
            <button type="button" className="btn-sm" onClick={onOpenOverview} title="全体図（−キー）">
              全体図で見る
            </button>
            <button type="button" className="btn-sm" onClick={(ev) => onBranchMenu(belowButton(ev.currentTarget), entry)}>
              ⋯ ブランチの操作
            </button>
          </span>
        </div>
        <div className="p-meta">
          {tip && <span>最終更新 {shortWhen(tip.date)}</span>}
          <span>
            {chain.length}
            {chain.length >= MAX_CHAIN ? "+" : ""} コミット
          </span>
          {vsDefault && defaultEntry && (vsDefault.ahead > 0 || vsDefault.behind > 0) && (
            <span>
              {defaultEntry.name} より
              {vsDefault.ahead > 0 && ` ${vsDefault.ahead} 先行`}
              {vsDefault.ahead > 0 && vsDefault.behind > 0 && "、"}
              {vsDefault.behind > 0 && ` ${vsDefault.behind} 遅れ`}
            </span>
          )}
          {vsDefault && defaultEntry && vsDefault.ahead === 0 && vsDefault.behind === 0 && <span>{defaultEntry.name} と同じ</span>}
        </div>
      </div>

      <div className="c-list">
        {days.map((day) => (
          <section key={day.key} className="c-day">
            <h4 className="c-day-head">{day.label}</h4>
            {day.items.map((it) =>
              it.kind === "one" ? (
                row(it.commit)
              ) : (
                <details key={`app:${it.commits[0].hash}`} className="c-auto">
                  <summary className="c-row">
                    <span className="c-time">{timeOf(it.commits[0].date)}</span>
                    <span className="c-dot auto" />
                    <span className="c-msg">
                      🤖 アプリの自動コミット {it.commits.length} 件 <span className="c-sub">{appCommitBreakdown(it.commits)}</span>
                    </span>
                    <span className="c-chips" />
                    <span className="c-hash">▾</span>
                    <span />
                  </summary>
                  <div className="c-auto-list">{it.commits.map(row)}</div>
                </details>
              ),
            )}
          </section>
        ))}
        {(chain.length >= MAX_CHAIN || history.truncated) && (
          <p className="c-more">これより前のコミットは読み込んでいません</p>
        )}
      </div>
    </div>
  );
});
