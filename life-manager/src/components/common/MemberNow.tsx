import { useMemo } from "react";
import type { GitHubIssue, GitHubUser } from "../../lib/types";
import type { ActivityEvent } from "../../lib/activity";
import { IN_PROGRESS_LABEL } from "../../lib/sprint";
import { ago } from "../../lib/pulls";
import { Avatar } from "./Avatar";

interface MemberNowProps {
  members: GitHubUser[];
  issues: GitHubIssue[];
  /** チームの動き（ヒストリーと同じもの）。まだ読めていなければ null */
  events: ActivityEvent[] | null;
  me: string;
  onSelectIssue: (n: number) => void;
}

/** 進行中のタスクは、何件まで題名を出すか */
const SHOWN = 2;

type Row = { user: GitHubUser; lastAt: string | null; doing: GitHubIssue[] };

/**
 * メンバーの「今」（#236）: メンバーごとに、最後に動いた時刻（チームの動きの、その人のいちばん新しい出来事）と、進行中のタスク。
 * 自分を先に、あとは最近動いた順。古くても赤くはしない
 */
export function MemberNow({ members, issues, events, me, onSelectIssue }: MemberNowProps) {
  const rows = useMemo<Row[]>(() => {
    const last = new Map<string, string>();
    for (const e of events ?? []) {
      const who = e.actor.toLowerCase();
      const seen = last.get(who);
      if (!seen || e.at > seen) last.set(who, e.at);
    }
    const list = members.map((user): Row => {
      const who = user.login.toLowerCase();
      const doing = issues.filter(
        (i) => i.labels.some((l) => l.name === IN_PROGRESS_LABEL) && (i.assignees ?? []).some((a) => a.login.toLowerCase() === who),
      );
      return { user, lastAt: last.get(who) ?? null, doing };
    });
    const mine = me.toLowerCase();
    return list.sort((a, b) => {
      if (a.user.login.toLowerCase() === mine) return -1;
      if (b.user.login.toLowerCase() === mine) return 1;
      if (a.lastAt && b.lastAt) return a.lastAt < b.lastAt ? 1 : -1;
      if (a.lastAt || b.lastAt) return a.lastAt ? -1 : 1;
      return a.user.login.localeCompare(b.user.login);
    });
  }, [members, issues, events, me]);

  if (rows.length === 0) return null;
  return (
    <section className="member-now" aria-label="メンバーの今">
      <div className="member-now-head">
        <b>👥 メンバーの今</b>
      </div>
      <div className="mn-table" role="table">
        <div className="mn-row mn-cols" role="row">
          <span role="columnheader">メンバー</span>
          <span role="columnheader" title="GitHub で最後に動いた時刻（プッシュ、Issue、コメント、プルリクなど）">最後に動いた</span>
          <span role="columnheader">進行中のタスク</span>
        </div>
        {rows.map((r) => (
          <div key={r.user.login} className="mn-row" role="row">
            <span className="mn-who" role="cell">
              <Avatar login={r.user.login} url={r.user.avatar_url} className="mn-avatar" alt="" />
              <b>{r.user.login}</b>
            </span>
            <span
              className="mn-when"
              role="cell"
              title={r.lastAt ? new Date(r.lastAt).toLocaleString() : events ? "最近の動きが見つかりません" : "読んでいます"}
            >
              {r.lastAt ? ago(r.lastAt) : events ? "—" : "…"}
            </span>
            <span className="mn-doing" role="cell">
              {r.doing.length === 0 ? (
                <span className="mn-none">なし</span>
              ) : (
                <>
                  {r.doing.slice(0, SHOWN).map((i) => (
                    <button key={i.number} type="button" className="mn-task" title={`#${i.number} ${i.title}`} onClick={() => onSelectIssue(i.number)}>
                      <span className="mn-task-n">#{i.number}</span> {i.title}
                    </button>
                  ))}
                  {r.doing.length > SHOWN && <span className="mn-more">ほか {r.doing.length - SHOWN}</span>}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
