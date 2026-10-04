import type { GitHubIssue } from "../../lib/types";
import { daysUntil, dueOf } from "../../lib/due";
import { tr } from "../../lib/i18n";

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
  const from = due.source === "gantt" ? tr("ガントの終了日") : tr("マイルストーン「{v}」の期限", { v: issue.milestone?.title ?? "" });
  if (days < 0) {
    return (
      <span className="due-chip due-chip--over" title={tr("期限（{from}）を過ぎています", { from })}>
        ⚠ {date}（{-days} {" "}{tr("日超過）")}
      </span>
    );
  }
  return (
    <span className={`due-chip${days <= SOON_DAYS ? " due-chip--soon" : ""}`} title={tr("期限（{from}）", { from })}>
      📅 {date}（{days === 0 ? tr("今日") : tr("あと {days} 日", { days })}）
    </span>
  );
}
