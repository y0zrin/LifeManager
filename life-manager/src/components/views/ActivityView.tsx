import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { KIND_LABELS, dayLabel, describe, helpRoles, kindOf, milestoneEvents, timeOf, type ActivityKind, type Part } from "../../lib/activity";
import { ago } from "../../lib/pulls";
import { commentPreview } from "../../lib/help";
import type { ActivityState } from "../../hooks/useActivity";
import { CommitDetail } from "../git/CommitDetail";
import { TeamWork } from "./TeamWork";
import type { GitHubIssue, GitHubMilestone, GitHubUser } from "../../lib/types";

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
}

/** ヒストリー: 上に「あなたがすること」（GitHub の通知の代わり）、下にチームの動き（日ごと） */
export function ActivityView({ owner, repo, activity, onOpenIssue, onOpenPull, onOpenRun, team, motion, milestones, closedIssues }: ActivityViewProps) {
  const { feed, error, loading, reload, todos, dismiss } = activity;
  const [who, setWho] = useState("");
  const [kind, setKind] = useState<"" | ActivityKind>("");
  const [commit, setCommit] = useState<{ hash: string; subject: string; author: string; date: string } | null>(null);

  const open = (p: Exclude<Part, string>) => (p.kind === "pull" ? onOpenPull(p.number) : onOpenIssue(p.number));
  const renderParts = (parts: Part[]) =>
    parts.map((p, i) =>
      typeof p === "string" ? (
        <span key={i}>{p}</span>
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

          <div className="av-me">
            <div className="av-me-head">
              <b>あなたがすること {todos.length}</b>
              <span className="grow" />
              <button type="button" className="btn-sm" onClick={reload} disabled={loading} title="読み直す">
                {loading ? "…" : "↻"}
              </button>
            </div>
            {todos.length === 0 ? (
              <p className="muted">{feed ? "今はありません" : "読み込んでいます…"}</p>
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
                  <button type="button" className="pr-reviewer-x" title="見た（中身が変わるとまた出ます）" aria-label="見た" onClick={() => dismiss(t.key)}>
                    ×
                  </button>
                </div>
              ))
            )}
          </div>
        </div>

        <div className="av-main">
          <div className="av-filters">
            <select className="select-sm" value={who} onChange={(e) => setWho(e.target.value)} aria-label="だれ">
              <option value="">だれ: すべて（{whoCount("")}）</option>
              {actors.map((a) => (
                <option key={a} value={a}>
                  {a}（{whoCount(a)}）
                </option>
              ))}
            </select>
            <select className="select-sm" value={kind} onChange={(e) => setKind(e.target.value as "" | ActivityKind)} aria-label="種類">
              <option value="">種類: すべて（{kindCount("")}）</option>
              {(Object.keys(KIND_LABELS) as ActivityKind[]).map((k) => (
                <option key={k} value={k}>
                  {KIND_LABELS[k]}（{kindCount(k)}）
                </option>
              ))}
            </select>
            <span className="muted">
              チームの動き {feed && <b className="av-count">{shown.length} 件</b>}（GitHub が残している最近の 90 日ほど）
            </span>
          </div>

          {error ? (
            <p className="git-dialog-error">{error}</p>
          ) : !feed ? (
            <p className="muted">読み込んでいます…</p>
          ) : days.length === 0 ? (
            <p className="muted">まだ何も起きていません。</p>
          ) : (
            days.map((day) => (
              <div key={day.label} className="av-day">
                <div className="av-day-label">
                  {day.label}
                  <span className="av-day-count">{day.items.length} 件</span>
                </div>
                {day.items.map(({ e, d }) =>
                  d!.tone === "milestone" ? (
                    // マイルストーンの達成は、大きく派手に（#229）
                    <div key={e.id} className="av-ms">
                      <span className="av-ms-trophy" aria-hidden="true">
                        {d!.icon}
                      </span>
                      <span className="av-ms-body">
                        <span className="av-ms-kicker">マイルストーン達成</span>
                        <b className="av-ms-title">{renderParts(d!.parts)}</b>
                        {d!.sub && <span className="av-ms-sub">{renderParts(d!.sub)}</span>}
                      </span>
                      <span className="av-ms-party" aria-hidden="true">
                        🎉
                      </span>
                      <span className="muted av-when">{timeOf(e.at)}</span>
                    </div>
                  ) : (
                    <div key={e.id} className={`av-ev k-${kindOf(e)}${d!.tone ? ` t-${d!.tone}` : ""}`}>
                      <span className="av-icon" aria-hidden="true">
                        {d!.icon}
                      </span>
                      <span className="av-ev-body">
                        <span>
                          <b>{e.actor}</b> {renderParts(d!.parts)}
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
