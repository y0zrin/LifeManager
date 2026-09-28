import { useRef, useState } from "react";
import type { GitHubLabel } from "../../lib/types";
import type { LabelFilter } from "../../lib/taskList";
import { useDismiss } from "../../hooks/useDismiss";

interface LabelFilterButtonProps {
  /** 見出し（"分野" など） */
  name: string;
  /** ラベルの頭（"分野:" など） */
  prefix: string;
  labels: GitHubLabel[];
  value: LabelFilter | undefined;
  onChange: (value: LabelFilter) => void;
}

/** ラベルの種類ごとの絞り込み。押すと複数選べ、2 つ以上選んだら「どれか（OR）／すべて（AND）」を切り替えられる */
export function LabelFilterButton({ name, prefix, labels, value, onChange }: LabelFilterButtonProps) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useDismiss(ref, open, () => setOpen(false));
  const values = value?.values ?? [];
  const mode = value?.mode ?? "any";
  const short = (label: string) => label.replace(prefix, "");

  function toggle(label: string) {
    const next = values.includes(label) ? values.filter((v) => v !== label) : [...values, label];
    onChange({ values: next, mode });
  }

  return (
    <span className="label-filter" ref={ref}>
      <button type="button" className={`select-sm label-filter-button${values.length ? " label-filter-button--on" : ""}`} onClick={() => setOpen((v) => !v)}>
        {name}:{" "}
        {values.length === 0 ? (
          "全て"
        ) : (
          <>
            <b>{values.map(short).join("・")}</b>
            {values.length > 1 && `（${mode === "all" ? "すべて" : "どれか"}）`}
          </>
        )}{" "}
        ▾
      </button>
      {open && (
        <div className="label-filter-pop">
          <div className="label-filter-title">{name}（複数選べます）</div>
          {labels.map((l) => (
            <label key={l.name} className="label-filter-item">
              <input type="checkbox" checked={values.includes(l.name)} onChange={() => toggle(l.name)} />
              <span className="label-filter-dot" style={{ background: `#${l.color}` }} />
              {short(l.name)}
            </label>
          ))}
          {values.length > 1 && (
            <>
              <div className="label-filter-mode">
                <button type="button" className={mode === "any" ? "on" : ""} onClick={() => onChange({ values, mode: "any" })}>
                  どれか（OR）
                </button>
                <button type="button" className={mode === "all" ? "on" : ""} onClick={() => onChange({ values, mode: "all" })}>
                  すべて（AND）
                </button>
              </div>
              <div className="label-filter-note">
                選んだラベルが{mode === "all" ? <b>すべて</b> : <b>どれか</b>}付いている Issue を出します
              </div>
            </>
          )}
          {values.length > 0 && (
            <button type="button" className="link-button label-filter-clear" onClick={() => onChange({ values: [], mode })}>
              選ぶのをやめる（全て）
            </button>
          )}
        </div>
      )}
    </span>
  );
}
