import { useState, useEffect } from "react";
import type { GitHubLabel, Routine } from "../../lib/types";
import { LabelBadge } from "../common/LabelBadge";

interface RoutinesViewProps {
  routines: Routine[];
  availableLabels: GitHubLabel[];
  onSave: (routines: Routine[]) => Promise<void>;
  onRefresh: () => Promise<void>;
}

const weekdays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const weekdayLabels: Record<string, string> = {
  mon: "月", tue: "火", wed: "水", thu: "木", fri: "金", sat: "土", sun: "日",
};

export function RoutinesView({ routines, availableLabels, onSave, onRefresh }: RoutinesViewProps) {
  const [editingRoutines, setEditingRoutines] = useState<Routine[]>(routines);
  const [showForm, setShowForm] = useState(false);

  const [name, setName] = useState("");
  const [frequency, setFrequency] = useState("daily");
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("09:00");
  const [title, setTitle] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>(["種別:ルーチン"]);
  const [body, setBody] = useState("");
  const [autoClose, setAutoClose] = useState("");

  useEffect(() => {
    setEditingRoutines(routines);
  }, [routines]);

  function handleAdd() {
    const newRoutine: Routine = {
      name,
      schedule: {
        frequency,
        ...(frequency === "daily" && days.length > 0 ? { days } : {}),
        ...(frequency === "weekly" ? { day } : {}),
        ...(frequency === "monthly" ? { day: parseInt(day) } : {}),
        time,
      },
      issue: {
        title,
        labels: [...selectedLabels],
        ...(body ? { body } : {}),
      },
      ...(autoClose ? { auto_close: autoClose } : {}),
    };
    setEditingRoutines([...editingRoutines, newRoutine]);
    resetForm();
  }

  function handleDelete(index: number) {
    setEditingRoutines(editingRoutines.filter((_, i) => i !== index));
  }

  async function handleSave() {
    await onSave(editingRoutines);
  }

  function resetForm() {
    setName(""); setFrequency("daily"); setDays([]);
    setDay(""); setTime("09:00"); setTitle("");
    setSelectedLabels(["種別:ルーチン"]); setBody(""); setAutoClose("");
    setShowForm(false);
  }

  const hasChanges = JSON.stringify(editingRoutines) !== JSON.stringify(routines);

  return (
    <div className="content">
      <div className="toolbar">
        <button onClick={() => setShowForm(!showForm)} className="btn-sm">
          {showForm ? "×" : "+ ルーチン追加"}
        </button>
        <button onClick={onRefresh} className="btn-sm">更新</button>
        {hasChanges && (
          <button onClick={handleSave} className="btn-primary">保存</button>
        )}
      </div>

      {showForm && (
        <div className="form-card">
          <input value={name} onChange={(e) => setName(e.target.value)}
            placeholder="ルーチン名" className="input-full" />
          <div className="flex-row">
            <select value={frequency} onChange={(e) => setFrequency(e.target.value)} className="select-sm">
              <option value="daily">毎日</option>
              <option value="weekly">毎週</option>
              <option value="monthly">毎月</option>
            </select>
            <input type="time" value={time} onChange={(e) => setTime(e.target.value)}
              className="input-full" style={{ maxWidth: "120px" }} />
          </div>

          {frequency === "daily" && (
            <div className="flex-row flex-wrap gap-xs">
              {weekdays.map((wd) => (
                <label key={wd} style={{ fontSize: "var(--font-sm)", display: "flex", alignItems: "center", gap: "2px" }}>
                  <input type="checkbox" checked={days.includes(wd)}
                    onChange={(e) => {
                      if (e.target.checked) setDays([...days, wd]);
                      else setDays(days.filter((d) => d !== wd));
                    }}
                  />
                  {weekdayLabels[wd]}
                </label>
              ))}
            </div>
          )}

          {frequency === "weekly" && (
            <select value={day} onChange={(e) => setDay(e.target.value)} className="select-sm">
              <option value="">曜日を選択...</option>
              {weekdays.map((wd) => (
                <option key={wd} value={wd}>{weekdayLabels[wd]}曜日</option>
              ))}
            </select>
          )}

          {frequency === "monthly" && (
            <input type="number" value={day} onChange={(e) => setDay(e.target.value)}
              placeholder="日（1-31）" className="input-full" style={{ maxWidth: "120px" }} min="1" max="31" />
          )}

          <input value={title} onChange={(e) => setTitle(e.target.value)}
            placeholder="Issue タイトル（{{date}}, {{week}}, {{month}} が使えます）" className="input-full" />
          <div className="label-selector">
            {availableLabels.map((l) => {
              const active = selectedLabels.includes(l.name);
              return (
                <span
                  key={l.name}
                  className={`label-chip ${active ? "active" : ""}`}
                  onClick={() => {
                    if (active) setSelectedLabels(selectedLabels.filter((n) => n !== l.name));
                    else setSelectedLabels([...selectedLabels, l.name]);
                  }}
                  style={{
                    color: parseInt(l.color, 16) > 0x7fffff ? "#000" : "#fff",
                    backgroundColor: `#${l.color}`,
                  }}
                >
                  {l.name}
                </span>
              );
            })}
          </div>
          <textarea value={body} onChange={(e) => setBody(e.target.value)}
            placeholder="本文（タスクリストは - [ ] で記述）" className="textarea-full" />
          <input value={autoClose} onChange={(e) => setAutoClose(e.target.value)}
            placeholder="自動クローズ時刻（例: 23:59、空欄で無効）" className="input-full" style={{ maxWidth: "200px" }} />
          <button onClick={handleAdd} className="btn-primary" disabled={!name || !title}>追加</button>
        </div>
      )}

      {editingRoutines.map((routine, index) => {
        const scheduleStr = routine.schedule.frequency === "daily"
          ? `毎日${routine.schedule.days ? ` (${routine.schedule.days.map((d) => weekdayLabels[d] || d).join("")})` : ""}`
          : routine.schedule.frequency === "weekly"
          ? `毎週${weekdayLabels[String(routine.schedule.day)] || routine.schedule.day}曜日`
          : `毎月${routine.schedule.day}日`;

        return (
          <div key={index} className="issue-card">
            <div className="issue-card-header">
              <div>
                <strong>{routine.name}</strong>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)", marginLeft: "8px" }}>
                  {scheduleStr} {routine.schedule.time}
                </span>
              </div>
              <button className="btn-sm" onClick={() => handleDelete(index)}
                style={{ color: "var(--accent-red)" }}>削除</button>
            </div>
            <p className="issue-card-body">→ {routine.issue.title}</p>
            {routine.issue.body && (
              <p style={{ color: "var(--text-faint)", fontSize: "var(--font-xs)", margin: "2px 0", whiteSpace: "pre-wrap" }}>
                {routine.issue.body.length > 100 ? routine.issue.body.substring(0, 100) + "..." : routine.issue.body}
              </p>
            )}
            <div className="issue-card-labels">
              {routine.issue.labels.map((labelName) => {
                const found = availableLabels.find((l) => l.name === labelName);
                return <LabelBadge key={labelName} name={labelName} color={found?.color || "666666"} />;
              })}
              {routine.auto_close && (
                <span style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", marginLeft: "4px" }}>
                  自動クローズ: {routine.auto_close}
                </span>
              )}
            </div>
          </div>
        );
      })}
      {editingRoutines.length === 0 && (
        <p className="empty-message">ルーチンが設定されていません</p>
      )}
    </div>
  );
}
