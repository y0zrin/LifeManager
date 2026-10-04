import { useEffect, useMemo, useState } from "react";
import type { GitHubIssue } from "../../lib/types";
import type { ActivityEvent } from "../../lib/activity";
import * as gitApi from "../../lib/git";
import { celebrateDone } from "../../lib/celebrate";
import { countOf } from "../../lib/count";
import { dayKey, doneToday, localDayStart } from "../../lib/today";
import { tr, trx, listSep } from "../../lib/i18n";

interface TodayCardProps {
  closedIssues: GitHubIssue[];
  /** チームの動き（自分が閉じたタスクを拾う）。まだ読めていなければ null */
  events: ActivityEvent[] | null;
  me: string;
  /** この PC の作業フォルダ（あれば、今日のコミットを数える） */
  folder?: string;
  /** git の操作の回数（コミットしたら数え直す） */
  gitOps: number;
  onOpenIssue: (n: number) => void;
  onOpenJournal: () => void;
}

/** 終えたタスクは、何件まで題名を出すか */
const SHOWN = 3;
/** 「今日はここまで」を押した日 */
const STORE = "day-finished";

function loadFinished(): string | null {
  try {
    return localStorage.getItem(STORE);
  } catch {
    return null;
  }
}

/**
 * 今日のあなた（#238）: 今日終えたタスクと、今日のコミットの数。「今日はここまで」で小さく祝う。
 * 続けた日数は数えない（休みたい日に休めるように）
 */
export function TodayCard({ closedIssues, events, me, folder, gitOps, onOpenIssue, onOpenJournal }: TodayCardProps) {
  // 開いたまま 0 時をまたいだら、数え直す
  const [day, setDay] = useState(dayKey);
  useEffect(() => {
    const t = window.setInterval(() => setDay(dayKey()), 60_000);
    return () => window.clearInterval(t);
  }, []);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  const done = useMemo(() => doneToday(closedIssues, events, me), [closedIssues, events, me, day]);

  const [commits, setCommits] = useState<number | null>(null);
  useEffect(() => {
    if (!folder) {
      setCommits(null);
      return;
    }
    let alive = true;
    gitApi
      .myCommitsSince(folder, localDayStart().toISOString())
      .then((n) => { if (alive) setCommits(typeof n === "number" ? n : null); })
      .catch(() => { if (alive) setCommits(null); });
    return () => { alive = false; };
  }, [folder, gitOps, day]);

  const [finishedDay, setFinishedDay] = useState(loadFinished);
  const finished = finishedDay === day;

  function finishDay(button: HTMLElement) {
    const parts = [tr("タスク {n}", { n: countOf(done.length, tr("件")) }), ...(commits !== null ? [tr("コミット {n} 回", { n: commits })] : [])];
    const text = done.length > 0 || (commits ?? 0) > 0 ? tr("今日は{join}", { join: parts.join(listSep()) }) : tr("今日はここまで");
    celebrateDone(tr("今日"), button, text);
    try {
      localStorage.setItem(STORE, day);
    } catch {
      // 覚えられなくても、今は「おつかれさま」にする
    }
    setFinishedDay(day);
  }

  return (
    <div className={`today-card${finished ? " is-finished" : ""}`}>
      <div className="today-head">
        <b>{finished ? tr("🌙 おつかれさまでした") : tr("☀️ 今日のあなた")}</b>
      </div>
      <div className="today-nums">
        <div>
          {trx("<0>{length}</0><1>終えたタスク</1>", { length: done.length }, [<b />, <span />])}
        </div>
        {commits !== null && (
          <div>
            {trx("<0>{commits}</0><1>コミット</1>", { commits }, [<b />, <span />])}
          </div>
        )}
      </div>
      {done.length > 0 && (
        <div className="today-list">
          {done.slice(0, SHOWN).map((i) => (
            <button key={i.number} type="button" className="today-task" title={`#${i.number} ${i.title}`} onClick={() => onOpenIssue(i.number)}>
              ✓ <span className="today-task-n">#{i.number}</span> {i.title}
            </button>
          ))}
          {done.length > SHOWN && <span className="today-more">{tr("ほか {n}", { n: done.length - SHOWN })}</span>}
        </div>
      )}
      <div className="today-actions">
        {finished ? (
          <button type="button" className="btn-sm" onClick={onOpenJournal}>
            {tr("📓 日誌を書く")}
          </button>
        ) : (
          <button type="button" className="btn-sm" onClick={(e) => finishDay(e.currentTarget)}>
            {tr("🌙 今日はここまで")}
          </button>
        )}
      </div>
    </div>
  );
}
