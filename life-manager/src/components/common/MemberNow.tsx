import { useMemo } from "react";
import type { GitHubIssue, GitHubUser } from "../../lib/types";
import type { ActivityEvent } from "../../lib/activity";
import { IN_PROGRESS_LABEL } from "../../lib/sprint";
import { ago } from "../../lib/pulls";
import { Avatar } from "./Avatar";
import { tr, trx } from "../../lib/i18n";

interface MemberNowProps {
  members: GitHubUser[];
  issues: GitHubIssue[];
  /** チームの動き（ヒストリーと同じもの）。まだ読めていなければ null */
  events: ActivityEvent[] | null;
  me: string;
  onSelectIssue: (n: number) => void;
  /** 人を押したとき（その人の担当のタスク一覧を開く。#246） */
  onSelectMember?: (login: string) => void;
}

/** 進行中のタスクは、何件まで題名を出すか */
const SHOWN = 2;

type Row = { user: GitHubUser; lastAt: string | null; doing: GitHubIssue[] };

/**
 * メンバーの「今」（#236）: メンバーごとに、最後に動いた時刻（チームの動きの、その人のいちばん新しい出来事）と、進行中のタスク。
 * 自分を先に、あとは最近動いた順。古くても赤くはしない
 */
export function MemberNow({ members, issues, events, me, onSelectIssue, onSelectMember }: MemberNowProps) {
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
    <section className="member-now" aria-label={tr("メンバーの今")}>
      <div className="member-now-head">
        <b>{tr("👥 メンバーの今")}</b>
      </div>
      <div className="mn-table" role="table">
        <div className="mn-row mn-cols" role="row">
          {trx("<0>メンバー</0><1>最後に動いた</1><2>進行中のタスク</2>", undefined, [<span role="columnheader" />, <span role="columnheader" title={tr("GitHub で最後に動いた時刻（プッシュ、Issue、コメント、プルリクなど）")} />, <span role="columnheader" />])}
        </div>
        {rows.map((r) => (
          <div key={r.user.login} className="mn-row" role="row">
            <span className="mn-who" role="cell">
              {onSelectMember ? (
                <button type="button" className="mn-who-btn" title={tr("{login} の担当のタスクを一覧で見る", { login: r.user.login })} onClick={() => onSelectMember(r.user.login)}>
                  <Avatar login={r.user.login} url={r.user.avatar_url} className="mn-avatar" alt="" />
                  <b>{r.user.login}</b>
                </button>
              ) : (
                <>
                  <Avatar login={r.user.login} url={r.user.avatar_url} className="mn-avatar" alt="" />
                  <b>{r.user.login}</b>
                </>
              )}
            </span>
            <span
              className="mn-when"
              role="cell"
              title={r.lastAt ? new Date(r.lastAt).toLocaleString() : events ? tr("最近の動きが見つかりません") : tr("読んでいます")}
            >
              {r.lastAt ? ago(r.lastAt) : events ? "—" : "…"}
            </span>
            <span className="mn-doing" role="cell">
              {r.doing.length === 0 ? (
                <span className="mn-none">{tr("なし")}</span>
              ) : (
                <>
                  {r.doing.slice(0, SHOWN).map((i) => (
                    <button key={i.number} type="button" className="mn-task" title={`#${i.number} ${i.title}`} onClick={() => onSelectIssue(i.number)}>
                      <span className="mn-task-n">#{i.number}</span> {i.title}
                    </button>
                  ))}
                  {r.doing.length > SHOWN && <span className="mn-more">{tr("ほか")}{" "} {r.doing.length - SHOWN}</span>}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}
