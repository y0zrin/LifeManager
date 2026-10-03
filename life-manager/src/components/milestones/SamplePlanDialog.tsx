import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import type { GitHubMilestone } from "../../lib/types";
import { GAME_PLAN, planDates, planTaskLabels } from "../../lib/samplePlan";
import { withStartDate } from "../../lib/sprint";
import { DatePickerButton } from "../common/DatePickerButton";
import { celebrateDone } from "../../lib/celebrate";
import { isEscape } from "../../lib/keys";
import { dayKey } from "../../lib/today";

interface SamplePlanDialogProps {
  /** 今あるマイルストーン（同じ名前は作れない） */
  milestones: GitHubMilestone[];
  /** 作ったマイルストーンの番号を返す */
  onCreateMilestone: (title: string, description: string, dueOn: string | null) => Promise<number | null>;
  onCreateIssue: (title: string, body: string, labels: string[], milestone: number | null) => Promise<number>;
  onClose: () => void;
}

/** はじめに出しておく発表の日（今日から 8 週） */
const WEEKS = 8;

/** 「3/12（木）」 */
function shortDay(day: string): string {
  const [y, m, d] = day.split("-").map(Number);
  const w = "日月火水木金土"[new Date(y, m - 1, d).getDay()];
  return `${m}/${d}（${w}）`;
}

/**
 * 見本の計画から作る（#239）: 企画 → プロトタイプ → α版 → β版 → 発表 のマイルストーンと、よくあるタスク。
 * 始める日と発表の日から、段ごとの期限を割り振る。名前は変えられる
 */
export function SamplePlanDialog({ milestones, onCreateMilestone, onCreateIssue, onClose }: SamplePlanDialogProps) {
  const [start, setStart] = useState(() => dayKey());
  const [end, setEnd] = useState(() => dayKey(new Date(Date.now() + WEEKS * 7 * 86400000)));
  const [titles, setTitles] = useState(() => GAME_PLAN.map((s) => s.title));
  const [withTasks, setWithTasks] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const dates = useMemo(() => planDates(GAME_PLAN, start, end), [start, end]);
  const taken = new Set(milestones.map((m) => m.title.trim()));
  const dup = titles.map((t, i) => taken.has(t.trim()) || titles.some((x, j) => j !== i && x.trim() === t.trim()));
  const taskCount = GAME_PLAN.reduce((n, s) => n + s.tasks.length, 0);
  const canCreate = !busy && !!dates && titles.every((t) => t.trim()) && !dup.some(Boolean);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  async function create(button: HTMLElement) {
    if (!dates) return;
    const origin = button.getBoundingClientRect();
    setError(null);
    let made = 0;
    let tasksMade = 0;
    try {
      for (let i = 0; i < GAME_PLAN.length; i++) {
        const title = titles[i].trim();
        setBusy(`${title} を作っています（マイルストーン ${i + 1} / ${GAME_PLAN.length}）…`);
        const number = await onCreateMilestone(title, withStartDate("", dates[i].start), `${dates[i].due}T00:00:00Z`);
        if (number === null) throw new Error(`${title} の番号が分かりませんでした`);
        made++;
        if (!withTasks) continue;
        for (const task of GAME_PLAN[i].tasks) {
          setBusy(`${title} のタスクを作っています（${tasksMade + 1} / ${taskCount}）…`);
          await onCreateIssue(task.title, "", planTaskLabels(task), number);
          tasksMade++;
        }
      }
      celebrateDone("見本の計画", origin, `マイルストーン ${made} つ${withTasks ? `とタスク ${tasksMade} 件` : ""}を作りました`);
      onClose();
    } catch (e) {
      setError(`途中で止まりました（マイルストーン ${made} つ、タスク ${tasksMade} 件まで作りました）: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog sp-dialog" role="dialog" aria-modal="true" aria-label="見本の計画から作る" onClick={(e) => e.stopPropagation()}>
        <h3>📋 見本の計画から作る</h3>

        <div className="sp-days">
          <span className="git-dialog-label">始める日</span>
          <DatePickerButton value={start} onChange={(v) => v && setStart(v)} label={shortDay(start)} />
          <span className="git-dialog-label">発表の日</span>
          <DatePickerButton value={end} onChange={(v) => v && setEnd(v)} label={shortDay(end)} />
        </div>
        {!dates && <p className="git-dialog-error">発表の日は、始める日から 5 日以上あとにします</p>}

        <ol className="sp-stages">
          {GAME_PLAN.map((stage, i) => (
            <li key={stage.title} className={dup[i] ? "is-dup" : ""}>
              <div className="sp-stage-head">
                <input
                  className="input-full sp-title"
                  value={titles[i]}
                  disabled={!!busy}
                  aria-label={`${i + 1} つ目のマイルストーンの名前`}
                  onChange={(e) => setTitles(titles.map((t, j) => (j === i ? e.target.value : t)))}
                />
                {dates && (
                  <span className="sp-dates">
                    {shortDay(dates[i].start)} 〜 {shortDay(dates[i].due)}
                  </span>
                )}
              </div>
              {dup[i] && <span className="sp-dup">同じ名前のマイルストーンがあります</span>}
              {withTasks && (
                <ul className="sp-tasks">
                  {stage.tasks.map((t) => (
                    <li key={t.title} title={`セクション:${t.section}`}>
                      {t.title}
                    </li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>

        <label className="chk">
          <input type="checkbox" checked={withTasks} disabled={!!busy} onChange={(e) => setWithTasks(e.target.checked)} />
          よくあるタスクも作る（{taskCount} 件）
        </label>

        {busy && <p className="git-dialog-running">{busy}</p>}
        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          <button type="button" className="btn-sm" disabled={!!busy} onClick={onClose}>
            やめる
          </button>
          <button type="button" className="btn-primary" disabled={!canCreate} onClick={(e) => void create(e.currentTarget)}>
            作る（マイルストーン {GAME_PLAN.length} つ{withTasks ? `・タスク ${taskCount} 件` : ""}）
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
