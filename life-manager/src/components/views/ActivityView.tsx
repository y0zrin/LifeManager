import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { KIND_LABELS, dayLabel, describe, kindOf, timeOf, type ActivityKind, type Part } from "../../lib/activity";
import { ago } from "../../lib/pulls";
import type { ActivityState } from "../../hooks/useActivity";
import { CommitDetail } from "../git/CommitDetail";

interface ActivityViewProps {
  owner: string;
  repo: string;
  activity: ActivityState;
  onOpenIssue: (n: number) => void;
  onOpenPull: (n: number) => void;
  onOpenRun: (runId: number) => void;
}

/** アクティビティ: 上に「あなたがすること」（GitHub の通知の代わり）、下にチームの動き（日ごと） */
export function ActivityView({ owner, repo, activity, onOpenIssue, onOpenPull, onOpenRun }: ActivityViewProps) {
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

  const events = useMemo(() => (feed?.events ?? []).map((e) => ({ e, d: describe(e) })).filter((x) => x.d !== null), [feed]);
  const actors = useMemo(() => [...new Set(events.map((x) => x.e.actor))].sort(), [events]);
  const shown = events.filter((x) => (!who || x.e.actor === who) && (!kind || kindOf(x.e) === kind));
  const days: { label: string; items: typeof shown }[] = [];
  for (const x of shown) {
    const label = dayLabel(x.e.at);
    const last = days[days.length - 1];
    if (last && last.label === label) last.items.push(x);
    else days.push({ label, items: [x] });
  }

  return (
    <div className="activity pr-ui">
      <div className="av-me">
        <div className="av-me-head">
          <b>あなたがすること {todos.length}</b>
          <span className="grow" />
          <button type="button" className="btn-sm" onClick={reload} disabled={loading} title="読み直す">
            {loading ? "…" : "↻"}
          </button>
        </div>
        {todos.length === 0 ? (
          <p className="muted">{feed ? "今はありません。レビューを頼まれたり、担当の期限が近づいたりすると、ここに出ます。" : "読み込んでいます…"}</p>
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
                {t.detail && <span className="av-detail">「{t.detail.slice(0, 80)}」</span>}
              </button>
              <span className="muted av-when">{t.at ? ago(t.at) : ""}</span>
              <button type="button" className="pr-reviewer-x" title="見た（中身が変わると、また出ます）" aria-label="見た" onClick={() => dismiss(t.key)}>
                ×
              </button>
            </div>
          ))
        )}
        <p className="av-note">GitHub の通知（ベル）そのものは、GitHub の決まりで Life Manager からは読めません。代わりに、Issue・プルリク・Actions から集めています。</p>
      </div>

      <div className="av-filters">
        <select className="select-sm" value={who} onChange={(e) => setWho(e.target.value)} aria-label="だれ">
          <option value="">だれ: すべて</option>
          {actors.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
        <select className="select-sm" value={kind} onChange={(e) => setKind(e.target.value as "" | ActivityKind)} aria-label="種類">
          <option value="">種類: すべて</option>
          {(Object.keys(KIND_LABELS) as ActivityKind[]).map((k) => (
            <option key={k} value={k}>
              {KIND_LABELS[k]}
            </option>
          ))}
        </select>
        <span className="muted">チームの動き（GitHub が残している、最近の 90 日ほど）</span>
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
            <div className="av-day-label">{day.label}</div>
            {day.items.map(({ e, d }) => (
              <div key={e.id} className={`av-ev k-${kindOf(e)}`}>
                <span className="av-icon" aria-hidden="true">
                  {d!.icon}
                </span>
                <span className="av-ev-body">
                  <span>
                    <b>{e.actor}</b> {renderParts(d!.parts)}
                  </span>
                  {d!.detail && <span className="av-detail">「{d!.detail.slice(0, 100)}」</span>}
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
            ))}
          </div>
        ))
      )}

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
