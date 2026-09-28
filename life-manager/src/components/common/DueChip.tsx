import type { GitHubIssue } from "../../lib/types";
import { daysUntil, dueOf } from "../../lib/due";

/** 期限まで、この日数以内なら黄色で知らせる */
const SOON_DAYS = 3;

/** カードの「📅 10/10（あと 12 日）」。過ぎていたら赤で「⚠ 9/25（3 日超過）」。閉じた Issue には出さない */
export function DueChip({ issue }: { issue: GitHubIssue }) {
  if (issue.state === "closed") return null;
  const due = dueOf(issue);
  if (!due) return null;
  const days = daysUntil(due.date);
  const [, m, d] = due.date.split("-").map(Number);
  const date = `${m}/${d}`;
  const from = due.source === "gantt" ? "ガントの終了日" : `マイルストーン「${issue.milestone?.title ?? ""}」の期限`;
  if (days < 0) {
    return (
      <span className="due-chip due-chip--over" title={`期限（${from}）を過ぎています`}>
        ⚠ {date}（{-days} 日超過）
      </span>
    );
  }
  return (
    <span className={`due-chip${days <= SOON_DAYS ? " due-chip--soon" : ""}`} title={`期限（${from}）`}>
      📅 {date}（{days === 0 ? "今日" : `あと ${days} 日`}）
    </span>
  );
}
