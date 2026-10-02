import { useRef, useState } from "react";
import type { GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";
import type { LabelFilter, LabelFilters } from "../../lib/taskList";
import type { MilestoneFilter, StateFilter } from "../../lib/savedViews";
import { useDismiss } from "../../hooks/useDismiss";
import { sectionOf } from "../../lib/section";

/** ラベルの種類（"状態:" など）と、その見出し・ラベル */
export interface FilterCategory {
  prefix: string;
  name: string;
  labels: GitHubLabel[];
}

export interface TaskFilterProps {
  categories: FilterCategory[];
  filters: LabelFilters;
  onFiltersChange: (filters: LabelFilters) => void;
  assignee: string;
  onAssigneeChange: (login: string) => void;
  currentUser: string;
  collaborators: GitHubUser[];
  milestone: MilestoneFilter | null;
  onMilestoneChange: (m: MilestoneFilter | null) => void;
  milestones: GitHubMilestone[];
  milestoneTitle: (n: number) => string | null | undefined;
  state: StateFilter;
  onStateChange: (s: StateFilter) => void;
  /** 「表示」（オープンのみ・クローズのみ・両方）を出すか（ボードはオープンだけなので出さない） */
  showState?: boolean;
}

const STATE_LABELS: Record<StateFilter, string> = { open: "オープンのみ", closed: "クローズのみ", all: "両方" };

/** かけている絞り込みの数（検索は別。表示は「オープンのみ」がはじめ） */
export function filterCount(p: Pick<TaskFilterProps, "filters" | "assignee" | "milestone" | "state">): number {
  return (
    Object.values(p.filters).filter((f) => f?.values.length).length + (p.assignee ? 1 : 0) + (p.milestone !== null ? 1 : 0) + (p.state !== "open" ? 1 : 0)
  );
}

/** 絞り込みをすべて外す（表示はオープンのみに戻す） */
export function clearAll(p: TaskFilterProps) {
  p.onFiltersChange({});
  p.onAssigneeChange("");
  p.onMilestoneChange(null);
  p.onStateChange("open");
}

/** フィルタの中身（種別・セクション・状態・優先・見積・担当者・マイルストーン・表示）。吹き出しと、スマホの下から出る板で使う */
export function TaskFilterGroups(props: TaskFilterProps) {
  const { categories, filters, onFiltersChange, assignee, onAssigneeChange, currentUser, collaborators, milestone, onMilestoneChange, milestones, milestoneTitle, state, onStateChange, showState = true } = props;
  function toggle(prefix: string, label: string) {
    const f: LabelFilter = filters[prefix] ?? { values: [], mode: "any" };
    const values = f.values.includes(label) ? f.values.filter((v) => v !== label) : [...f.values, label];
    onFiltersChange({ ...filters, [prefix]: { values, mode: f.mode } });
  }

  const people = [
    { login: "", name: "全員" },
    ...(currentUser ? [{ login: currentUser, name: "自分" }] : []),
    ...collaborators.filter((c) => c.login !== currentUser).map((c) => ({ login: c.login, name: c.login })),
  ];

  return (
    <div className="task-filter-grid">
      {categories.map((c) => {
        const f = filters[c.prefix];
        const values = f?.values ?? [];
        const mode = f?.mode ?? "any";
        return (
          <div key={c.prefix} className="task-filter-group">
            <div className="task-filter-name">
              {c.name}
              {values.length > 1 && (
                <span className="task-filter-mode" role="group" aria-label={`${c.name}の選び方`}>
                  <button type="button" className={mode === "any" ? "on" : ""} title="選んだラベルがどれか付いている" onClick={() => onFiltersChange({ ...filters, [c.prefix]: { values, mode: "any" } })}>
                    どれか
                  </button>
                  <button type="button" className={mode === "all" ? "on" : ""} title="選んだラベルがすべて付いている" onClick={() => onFiltersChange({ ...filters, [c.prefix]: { values, mode: "all" } })}>
                    すべて
                  </button>
                </span>
              )}
            </div>
            {c.labels.map((l) => (
              <button key={l.name} type="button" className={`task-filter-opt${values.includes(l.name) ? " on" : ""}`} aria-pressed={values.includes(l.name)} onClick={() => toggle(c.prefix, l.name)}>
                <span className="label-filter-dot" style={{ background: `#${l.color}` }} />
                {l.name.replace(c.prefix, "")}
              </button>
            ))}
          </div>
        );
      })}
      <div className="task-filter-group">
        <div className="task-filter-name">担当者</div>
        {people.map((p) => (
          <button key={p.login || "all"} type="button" className={`task-filter-opt${assignee === p.login ? " on" : ""}`} aria-pressed={assignee === p.login} onClick={() => onAssigneeChange(p.login)}>
            {p.name}
          </button>
        ))}
      </div>
      <div className="task-filter-group">
        <div className="task-filter-name">マイルストーン</div>
        <select
          value={milestone ?? ""}
          className="select-sm"
          aria-label="マイルストーン"
          onChange={(e) => onMilestoneChange(e.target.value === "" ? null : e.target.value === "none" ? "none" : Number(e.target.value))}
        >
          <option value="">全て</option>
          {milestones.map((m) => (
            <option key={m.number} value={m.number}>
              🎯 {m.title}
            </option>
          ))}
          {typeof milestone === "number" && !milestones.some((m) => m.number === milestone) && (
            <option value={milestone}>🎯 {milestoneTitle(milestone) ?? `#${milestone}`}（クローズ）</option>
          )}
          <option value="none">マイルストーンなし</option>
        </select>
      </div>
      {showState && (
      <div className="task-filter-group">
        <div className="task-filter-name">表示</div>
        {(Object.keys(STATE_LABELS) as StateFilter[]).map((s) => (
          <button key={s} type="button" className={`task-filter-opt${state === s ? " on" : ""}`} aria-pressed={state === s} onClick={() => onStateChange(s)}>
            {STATE_LABELS[s]}
          </button>
        ))}
      </div>
      )}
    </div>
  );
}

/** 「フィルタ」: 押すと、種別・セクション・状態・優先・見積・担当者・マイルストーン・表示の一覧が開く。押すとすぐに一覧に反映する */
export function TaskFilterButton(props: TaskFilterProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const count = filterCount(props);

  return (
    <span className="task-filter" ref={ref}>
      <button type="button" className={`select-sm task-filter-button${count ? " task-filter-button--on" : ""}`} aria-expanded={open} onClick={() => setOpen((v) => !v)}>
        フィルタ{count > 0 && <span className="task-filter-count">{count}</span>} ▾
      </button>
      {open && (
        <div className="task-filter-pop" role="dialog" aria-label="フィルタ">
          <div className="task-filter-head">
            <b>フィルタ</b>
            <span className="task-filter-hint">押すと一覧に反映されます</span>
          </div>
          <TaskFilterGroups {...props} />
          <div className="task-filter-foot">
            {count > 0 && (
              <button type="button" className="link-button" onClick={() => clearAll(props)}>
                すべて外す
              </button>
            )}
            <span className="grow" />
            <button type="button" className="btn-sm" onClick={() => setOpen(false)}>
              閉じる
            </button>
          </div>
        </div>
      )}
    </span>
  );
}

/** かけている絞り込みを、× で外せるチップにして並べる（ないときは出さない） */
export function TaskFilterChips(props: TaskFilterProps) {
  const { categories, filters, onFiltersChange, assignee, onAssigneeChange, currentUser, milestone, onMilestoneChange, milestoneTitle, state, onStateChange } = props;
  const chips: { key: string; text: string; clear: () => void }[] = [];
  for (const c of categories) {
    const f = filters[c.prefix];
    if (!f?.values.length) continue;
    const names = f.values.map((v) => (v.startsWith(c.prefix) ? v.slice(c.prefix.length) : sectionOf(v))).join("・");
    chips.push({
      key: c.prefix,
      text: `${c.name}: ${names}${f.values.length > 1 ? (f.mode === "all" ? "（すべて）" : "（どれか）") : ""}`,
      clear: () => onFiltersChange({ ...filters, [c.prefix]: { values: [], mode: f.mode } }),
    });
  }
  if (assignee) chips.push({ key: "assignee", text: `担当者: ${assignee === currentUser ? "自分" : assignee}`, clear: () => onAssigneeChange("") });
  if (milestone !== null)
    chips.push({ key: "milestone", text: `マイルストーン: ${milestone === "none" ? "なし" : milestoneTitle(milestone) ?? `#${milestone}`}`, clear: () => onMilestoneChange(null) });
  if (state !== "open") chips.push({ key: "state", text: `表示: ${STATE_LABELS[state]}`, clear: () => onStateChange("open") });
  if (chips.length === 0) return null;
  return (
    <div className="task-filter-chips">
      {chips.map((c) => (
        <span key={c.key} className="task-filter-chip">
          {c.text}
          <button type="button" aria-label={`${c.text} を外す`} onClick={c.clear}>
            ×
          </button>
        </span>
      ))}
      {chips.length > 1 && (
        <button type="button" className="link-button" onClick={() => clearAll(props)}>
          すべて外す
        </button>
      )}
    </div>
  );
}
