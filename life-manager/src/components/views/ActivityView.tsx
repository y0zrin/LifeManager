import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { KIND_LABELS, dayLabel, describe, helpRoles, kindOf, milestoneEvents, timeOf, type ActivityKind, type Part, type RefPart } from "../../lib/activity";
import { ago } from "../../lib/pulls";
import { commentPreview } from "../../lib/help";
import type { ActivityState } from "../../hooks/useActivity";
import { CommitDetail } from "../git/CommitDetail";
import { TeamWork } from "./TeamWork";
import type { GitHubIssue, GitHubMilestone, GitHubUser } from "../../lib/types";
import { tr, trx } from "../../lib/i18n";

interface ActivityViewProps {
  owner: string;
  repo: string;
  activity: ActivityState;
  onOpenIssue: (n: number) => void;
  onOpenPull: (n: number) => void;
  onOpenRun: (runId: number) => void;
  /** チームの人（「チームの仕事」に顔を出す） */
  team: GitHubUser[];
  /** 画面の動きが「ふつう」か */
  motion: boolean;
  /** マイルストーンの達成をヒストリーに出すため（#229） */
  milestones: GitHubMilestone[];
  closedIssues: GitHubIssue[];
  /** 今日のあなた（チームの仕事の下。#238） */
  today?: ReactNode;
}

/** この起動のあいだに、滑り込みを見せたマイルストーンの達成（もう一度ヒストリーを開いても、くり返さない） */
const shownBanners = new Set<string>();

/**
 * マイルストーンの達成の帯（#230）: オーバーウォッチの UI のような斜めの帯。画面に入ったら、外から滑り込んで強く光る。
 * 見るのは動かない外側（slot）で、動くのは中（外にいるあいだは見つからないため）
 */
function MilestoneBanner({ id, children }: { id: string; children: ReactNode }) {
  const slot = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<"wait" | "play" | "rest">(() => (shownBanners.has(id) ? "rest" : "wait"));
  useEffect(() => {
    const el = slot.current;
    if (!el || state !== "wait") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((x) => x.isIntersecting)) return;
        shownBanners.add(id);
        setState("play");
        io.disconnect();
      },
      { threshold: 0.6 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [id, state]);
  return (
    <div ref={slot} className="av-ms-slot">
      <div className={`av-ms ${state}`}>
        <span className="av-ms-bloom" aria-hidden="true" />
        <span className="av-ms-slab" aria-hidden="true" />
        <span className="av-ms-flash" aria-hidden="true" />
        {children}
      </div>
    </div>
  );
}

/** ヒストリー: 上に「あなたがすること」（GitHub の通知の代わり）、下にチームの動き（日ごと） */
export function ActivityView({ owner, repo, activity, onOpenIssue, onOpenPull, onOpenRun, team, motion, milestones, closedIssues, today }: ActivityViewProps) {
  const { feed, error, loading, reload, todos, dismiss } = activity;
  const [who, setWho] = useState("");
  const [kind, setKind] = useState<"" | ActivityKind>("");
  const [commit, setCommit] = useState<{ hash: string; subject: string; author: string; date: string } | null>(null);

  const open = (p: RefPart) => (p.kind === "pull" ? onOpenPull(p.number) : onOpenIssue(p.number));
  const renderParts = (parts: Part[]) =>
    parts.map((p, i) =>
      typeof p === "string" ? (
        <span key={i}>{p}</span>
      ) : p.kind === "actor" ? (
        <b key={i}>{p.name}</b>
      ) : (
        <button key={i} type="button" className="pr-ref" title={p.title ?? undefined} onClick={() => open(p)}>
          #{p.number}
          {p.title ? ` ${p.title}` : ""}
        </button>
      ),
    );

  // GitHub の出来事に、マイルストーンの達成（アプリが作る）を足して新しい順に。🆘 は流れの中での役（求めた・答えた・解決した）で書く
  const events = useMemo(() => {
    const list = feed?.events ?? [];
    const roles = helpRoles(list);
    const since = list.length > 0 ? Math.min(...list.map((e) => Date.parse(e.at))) : Date.now() - 90 * 86400000;
    return [...list, ...milestoneEvents(milestones, closedIssues, since)]
      .sort((a, b) => b.at.localeCompare(a.at))
      .map((e) => ({ e, d: describe(e, roles.get(e.id)) }))
      .filter((x) => x.d !== null);
  }, [feed, milestones, closedIssues]);
  const actors = useMemo(() => [...new Set(events.map((x) => x.e.actor).filter(Boolean))].sort(), [events]);
  const matchWho = (x: (typeof events)[number]) => !who || x.e.actor === who;
  const matchKind = (x: (typeof events)[number]) => !kind || kindOf(x.e) === kind;
  const shown = events.filter((x) => matchWho(x) && matchKind(x));
  // 絞り込みの選択肢ごとの件数（もう一方の絞り込みは当てたまま。選ぶと何件になるか）
  const whoCount = (a: string) => events.filter((x) => (!a || x.e.actor === a) && matchKind(x)).length;
  const kindCount = (k: "" | ActivityKind) => events.filter((x) => (!k || kindOf(x.e) === k) && matchWho(x)).length;
  const days: { label: string; items: typeof shown }[] = [];
  for (const x of shown) {
    const label = dayLabel(x.e.at);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(x);
    else days.push({ label, items: [x] });
  }

  return (
    <div className="activity pr-ui">
      {/* 広いときは 2 列: 左にチームの仕事とあなたがすること、右にチームの動き（#227） */}
      <div className="av-cols">
        <div className="av-side">
          {/* チームの仕事（これまでの合計。減らない数） */}
          <TeamWork key={`${owner}/${repo}`} owner={owner} repo={repo} team={team} motion={motion} />

          {today}

          <div className="av-me">
            <div className="av-me-head">
              <b>{trx("あなたがすること {length}", { length: todos.length })}</b>
              <span className="grow" />
              <button type="button" className="btn-sm" onClick={reload} disabled={loading} title={tr("読み直す")}>
                {loading ? "…" : "↻"}
              </button>
            </div>
            {todos.length === 0 ? (
              <p className="muted">{feed ? tr("今はありません") : tr("読み込んでいます…")}</p>
            ) : (
              todos.map((t) => (
                <div key={t.key} className={`av-todo t-${t.tone || "none"}`}>
                  <span className="av-icon" aria-hidden="true">
                    {t.icon}
                  </span>
                  <button
                    type="button"
                    className="av-todo-main"
                    onClick={() => (t.target.kind === "run" ? onOpenRun(t.target.runId) : t.target.kind === "pull" ? onOpenPull(t.target.number) : onOpenIssue(t.target.number))}
                  >
                    <span className="av-todo-text">
                      {t.parts.map((p, i) =>
                        typeof p === "string" ? (
                          <span key={i}>{p}</span>
                        ) : p.kind === "actor" ? (
                          <b key={i}>{p.name}</b>
                        ) : (
                          <b key={i} className="av-ref">
                            #{p.number}
                            {p.title ? ` ${p.title}` : ""}
                          </b>
                        ),
                      )}
                    </span>
                    {t.detail && <span className="av-detail">「{commentPreview(t.detail).slice(0, 80)}」</span>}
                  </button>
                  <span className="muted av-when">{t.at ? ago(t.at) : ""}</span>
                  <button type="button" className="pr-reviewer-x" title={tr("見た（中身が変わるとまた出ます）")} aria-label={tr("見た")} onClick={() => dismiss(t.key)}>
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="av-main">
          <div className="av-filters">
            <select className="select-sm" value={who} onChange={(e) => setWho(e.target.value)} aria-label={tr("だれ")}>
              <option value="">{trx("だれ: すべて（{whoCount}）", { whoCount: whoCount("") })}</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}（{whoCount(a)}）
                </option>
              ))}
            </select>
            <select className="select-sm" value={kind} onChange={(e) => setKind(e.target.value as "" | ActivityKind)} aria-label={tr("種類")}>
              <option value="">{trx("種類: すべて（{kindCount}）", { kindCount: kindCount("") })}</option>
              {(Object.keys(KIND_LABELS) as ActivityKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}（{kindCount(k)}）
                </option>
              ))}
            </select>
            <span className="muted">
              {tr("チームの動き")}{" "} {feed && <b className="av-count">{trx("{length} 件", { length: shown.length })}</b>}{tr("（GitHub が残している最近の 90 日ほど）")}
            </span>
          </div>

          {error ? (
            <p className="git-dialog-error">{error}</p>
          ) : !feed ? (
            <p className="muted">{tr("読み込んでいます…")}</p>
          ) : days.length === 0 ? (
            <p className="muted">{tr("まだ何も起きていません。")}</p>
          ) : (
            days.map((day) => (
              <div key={day.label} className="av-day">
                <div className="av-day-label">
                  {trx("{label}<0>{length} 件</0>", { label: day.label, length: day.items.length }, [<span className="av-day-count" />])}
                </div>
                {day.items.map(({ e, d }) =>
                  d!.tone === "milestone" ? (
                    // マイルストーンの達成は、大きく派手に（#229・#230）
                    <MilestoneBanner key={e.id} id={e.id}>
                      <span className="av-ms-trophy" aria-hidden="true">
                        {d!.icon}
                      </span>
                      <span className="av-ms-body">
                        {trx("<0>マイルストーン達成</0><1>{renderParts}</1>", { renderParts: renderParts(d!.parts) }, [<span className="av-ms-kicker" />, <b className="av-ms-title" />])}
                        {d!.sub && <span className="av-ms-sub">{renderParts(d!.sub)}</span>}
                      </span>
                      <span className="av-when">{timeOf(e.at)}</span>
                    </MilestoneBanner>
                  ) : (
                    <div key={e.id} className={`av-ev k-${kindOf(e)}${d!.tone ? ` t-${d!.tone}` : ""}`}>
                      <span className="av-icon" aria-hidden="true">
                        {d!.icon}
                      </span>
                      <span className="av-ev-body">
                        <span>
                          {renderParts(d!.parts)}
                        </span>
                        {d!.detail && <span className="av-detail">「{commentPreview(d!.detail).slice(0, 100)}」</span>}
                        {d!.commits && d!.commits.length > 0 && (
                          <span className="av-commits">
                            {d!.commits.map((c) => (
                              <button key={c.sha} type="button" className="av-commit" onClick={() => setCommit({ hash: c.sha, subject: c.message, author: e.actor, date: e.at })}>
                                <code>{c.sha.slice(0, 7)}</code> {c.message}
                              </button>
                            ))}
                          </span>
                        )}
                      </span>
                      <span className="muted av-when">{timeOf(e.at)}</span>
                    </div>
                  ),
                )}
              </div>
            ))
          )}
        </div>
      </div>

      {commit &&
        createPortal(
          <CommitDetail
            source={{ owner, repo }}
            commit={{ hash: commit.hash, parents: [], author: commit.author, date: commit.date, subject: commit.subject }}
            onClose={() => setCommit(null)}
          />,
          document.querySelector("main.app") ?? document.body,
        )}
    </div>
  );
}
