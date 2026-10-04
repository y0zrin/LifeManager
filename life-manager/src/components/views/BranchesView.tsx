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
import { tr, trx, listSep } from "../../lib/i18n";

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

/** 名前の帯: 左右の端のボタンの幅と、となりの名前までの間（帯の幅に対する割合） */
const NAME_INSET = 44;
const NAME_STEP = 0.36;
/** 履歴を名前と同じ間で並べるときの、1 列の幅の下限。これより狭いときは 1 本を大きく出し、左右は端に少しだけ見せる */
const MIN_COLUMN = 320;
const PEEK_PAGE = 0.86;

/** 真ん中からの離れぐあい（ページ何枚分か）に合わせた薄さ。名前も履歴も同じ */
const fade = (d: number) => Math.max(0, 1 - Math.min(1, Math.abs(d)) * 0.45 - Math.max(0, Math.abs(d) - 1) * 0.5);

export function roleOf(e: BranchEntry, local: boolean): string {
  const parts: string[] = [];
  if (e.isDefault) parts.push(tr("既定のブランチ"));
  if (e.isCurrent) parts.push(tr("チェックアウト中"));
  if (local && !e.onPc) parts.push(tr("GitHub にだけある"));
  if (local && e.onPc && !e.onGitHub) parts.push(tr("この PC にだけある"));
  return parts.join(tr("・")) || tr("ブランチ");
}

/** ブランチ画面: ブランチごとのページを左右にスライドして見る。名前の帯はスライドに合わせて大きさが変わる。
 * 広いときは、履歴も名前と同じ間で並べ、左右のブランチの履歴は名前と同じ薄さで出す（#228） */
export function BranchesView(props: BranchesViewProps) {
  const { entries, selected, onSelect } = props;
  const found = entries.findIndex((e) => e.name === selected);
  const index = found >= 0 ? found : 0;
  const pagerRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState(index);
  const stopAnim = useRef<(() => void) | null>(null);
  const settleTimer = useRef(0);
  const frame = useRef(0);

  // ページの幅: 広いときは名前の間と同じ（3 列）、狭いときは 1 本を大きく（左右は端に少しだけ）。窓の大きさが変わったら決め直す
  const [lay, setLay] = useState({ w: 0, page: 0 });
  useLayoutEffect(() => {
    const el = pagerRef.current;
    if (!el) return;
    const measure = () => {
      const w = el.clientWidth;
      const step = (w - 2 * NAME_INSET) * NAME_STEP;
      const page = Math.round(step >= MIN_COLUMN ? step : w * PEEK_PAGE);
      setLay((p) => (p.w === w && p.page === page ? p : { w, page }));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [entries.length > 0]);
  const cols = lay.page > 0 && lay.page < lay.w * 0.6;
  // 1 列が狭いとき（3 列と、スマホ）は、行を詰める
  const compact = lay.page > 0 && lay.page < 520;

  // 外から（一覧・全体図・矢印）ブランチが変わったら、そのページへスライドする（最初と、並べ方が変わったときは動かさずに置く）
  const laidFor = useRef(0);
  useLayoutEffect(() => {
    const el = pagerRef.current;
    if (!el || !lay.page) return;
    const target = index * lay.page;
    if (laidFor.current !== lay.page) {
      laidFor.current = lay.page;
      stopAnim.current?.();
      el.scrollLeft = target;
      setPos(index);
      return;
    }
    if (Math.abs(el.scrollLeft - target) < 2) return;
    stopAnim.current?.();
    stopAnim.current = easeScrollTo(el, { left: target });
  }, [index, lay.page]);

  const onScroll = () => {
    const el = pagerRef.current;
    if (!el || !lay.page) return;
    cancelAnimationFrame(frame.current);
    frame.current = requestAnimationFrame(() => setPos(el.scrollLeft / lay.page));
    // 指やホイールで動かして止まったら、そのページのブランチを選んだことにする
    window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => {
      const i = Math.round(el.scrollLeft / lay.page);
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

  // 名前の帯の上でホイールを回すと、隣のブランチへ（下・右に回すと次、上・左で前）。
  // 1 目盛りで 1 本。トラックパッドの細かい動きはためてから動かし、勢いで何本も飛ばないよう少し間を空ける。
  // Ctrl＋ホイールは、作業⇄ブランチ⇄全体図の切り替えに使うので、ここでは受け取らない
  const stripRef = useRef<HTMLDivElement>(null);
  const goRef = useRef(go);
  goRef.current = go;
  const indexRef = useRef(index);
  indexRef.current = index;
  const wheel = useRef({ sum: 0, at: 0 });
  useEffect(() => {
    const el = stripRef.current;
    if (!el) return;
    function onWheel(e: WheelEvent) {
      if (e.ctrlKey) return;
      e.preventDefault();
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      const w = wheel.current;
      // 行で動くマウス（deltaMode 1）は、1 行を 40 ピクセルとして数える
      w.sum += e.deltaMode === 1 ? delta * 40 : delta;
      const now = Date.now();
      if (Math.abs(w.sum) < 40 || now - w.at < 180) return;
      w.at = now;
      goRef.current(indexRef.current + (w.sum > 0 ? 1 : -1));
      w.sum = 0;
    }
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [entries.length > 0]);

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
        <p className="work-loading">{tr("ブランチがまだありません")}</p>
      </div>
    );
  }

  return (
    <div className="bview">
      <div className="bv-strip" ref={stripRef}>
        <button type="button" className="bv-edge l" aria-label={tr("前のブランチ")} disabled={index === 0} onClick={() => go(index - 1)}>
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
                  left: `calc(50% + ${d * NAME_STEP * 100}%)`,
                  transform: `translateX(-50%) scale(${0.62 + 0.38 * k})`,
                  opacity: fade(d),
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
          aria-label={tr("次のブランチ")}
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

      <div
        className={`bv-pager${cols ? " cols" : ""}${compact ? " compact" : ""}`}
        ref={pagerRef}
        onScroll={onScroll}
        style={lay.page ? { paddingInline: (lay.w - lay.page) / 2, ["--bv-page" as string]: `${lay.page}px` } : undefined}
      >
        {entries.map((e, i) => {
          // 左右のブランチの履歴は、名前と同じ薄さ。押すと、そのブランチへ（中のボタンは押せない）
          const side = i !== index;
          return (
            <div
              key={e.name}
              className={`bv-page${side ? " side" : ""}`}
              style={{ ["--o" as string]: fade(i - pos) }}
              onClick={side ? () => go(i) : undefined}
            >
              <div className="bv-page-in" inert={side}>
                {Math.abs(i - near) <= (cols ? 2 : 1) && (
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
            </div>
          );
        })}
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
      const chip = r.kind === "remote" ? { kind: "remote", name: tr("GitHub の位置") } : { kind: r.kind, name: r.name };
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
        aria-label={tr("コミットの操作")}
        title={tr("コミットの操作（右クリックでも開けます）")}
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
          {info && info.ahead > 0 && <span className="chip warn" title={tr("まだ GitHub に送っていないコミット")}>{trx("↑{ahead} 未プッシュ", { ahead: info.ahead })}</span>}
          {info && info.behind > 0 && <span className="chip warn" title={tr("GitHub にあって、まだ取り込んでいないコミット")}>{trx("↓{behind} 未プル", { behind: info.behind })}</span>}
          {info?.gone && <span className="chip ng">{tr("GitHub で削除済み")}</span>}
          {local && entry.onPc && !entry.onGitHub && <span className="chip muted">{tr("未公開")}</span>}
          {local && !entry.onPc && <span className="chip muted">{tr("GitHub にだけある")}</span>}
          {entry.isCurrent && changes > 0 && (
            <button type="button" className="chip wip-link" onClick={onOpenWork}>
              {trx("✎ 作業中の変更 {changes} → 作業をする", { changes })}
            </button>
          )}
          <span className="p-actions">
            {/* 見ているブランチを、切り替えずにフェッチ・プル（作業フォルダは今のブランチのまま） */}
            {local && actions && entry.onGitHub && (
              <>
                <button type="button" className="btn-sm" onClick={() => actions.fetchBranch(entry)} title={tr("git fetch origin {name}（GitHub の {name} を読むだけ）", { name: entry.name })}>
                  {tr("⟳ フェッチ")}
                </button>
                <button type="button" className="btn-sm" onClick={() => actions.pullBranch(entry)}
                  title={entry.isCurrent ? "git pull" : entry.onPc ? tr("git fetch origin {name}:{name}（切り替えずに、GitHub の最新にする）", { name: entry.name }) : tr("git branch --track {name} origin/{name}（切り替えずに、この PC に作る）", { name: entry.name })}>
                  {tr("⬇ プル")}
                </button>
              </>
            )}
            {local && actions && !entry.isCurrent && (
              <button type="button" className="btn-sm" onClick={() => actions.requestSwitch(entry.name)} title={`git switch ${entry.name}`}>
                {tr("このブランチに切り替える")}
              </button>
            )}
            <button type="button" className="btn-sm" onClick={onOpenOverview} title={tr("全体図（−キー）")}>
              {tr("全体図で見る")}
            </button>
            <button type="button" className="btn-sm" onClick={(ev) => onBranchMenu(belowButton(ev.currentTarget), entry)}>
              {tr("⋯ ブランチの操作")}
            </button>
          </span>
        </div>
        <div className="p-meta">
          {tip && <span>{trx("最終更新 {shortWhen}", { shortWhen: shortWhen(tip.date) })}</span>}
          <span>
            {chain.length}
            {chain.length >= MAX_CHAIN ? "+" : ""} {" "}{tr("コミット")}
          </span>
          {vsDefault && defaultEntry && (vsDefault.ahead > 0 || vsDefault.behind > 0) && (
            <span>
              {trx("{name} より", { name: defaultEntry.name })}
              {vsDefault.ahead > 0 && tr(" {ahead} 先行", { ahead: vsDefault.ahead })}
              {vsDefault.ahead > 0 && vsDefault.behind > 0 && listSep()}
              {vsDefault.behind > 0 && tr(" {behind} 遅れ", { behind: vsDefault.behind })}
            </span>
          )}
          {vsDefault && defaultEntry && vsDefault.ahead === 0 && vsDefault.behind === 0 && <span>{trx("{name} と同じ", { name: defaultEntry.name })}</span>}
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
                      {trx("🤖 アプリの自動コミット {length} 件 <0>{appCommitBreakdown}</0>", { length: it.commits.length, appCommitBreakdown: appCommitBreakdown(it.commits) }, [<span className="c-sub" />])}
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
          <p className="c-more">{tr("これより前のコミットは読み込んでいません")}</p>
        )}
      </div>
    </div>
  );
});
