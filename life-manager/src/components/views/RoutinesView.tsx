import { useState } from "react";
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
  const [showForm, setShowForm] = useState(false);
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);

  const [name, setName] = useState("");
  const [frequency, setFrequency] = useState("daily");
  const [days, setDays] = useState<string[]>([]);
  const [day, setDay] = useState("");
  const [time, setTime] = useState("09:00");
  const [title, setTitle] = useState("");
  const [selectedLabels, setSelectedLabels] = useState<string[]>(["種別:ルーチン"]);
  const [body, setBody] = useState("");
  const [autoClose, setAutoClose] = useState("");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");

  function buildRoutine(): Routine {
    return {
      name,
      schedule: {
        frequency,
        ...(frequency === "daily" && days.length > 0 ? { days } : {}),
        ...(frequency === "weekly" ? { day } : {}),
        ...(frequency === "monthly" ? { day: parseInt(day) } : {}),
        time,
        ...(startDate ? { start_date: startDate } : {}),
        ...(endDate ? { end_date: endDate } : {}),
      },
      issue: {
        title,
        labels: [...selectedLabels],
        ...(body ? { body } : {}),
      },
      ...(autoClose ? { auto_close: autoClose } : {}),
    };
  }

  async function handleSubmit() {
    const routine = buildRoutine();
    setSaving(true);
    try {
      if (editingIndex !== null) {
        const updated = [...routines];
        updated[editingIndex] = routine;
        await onSave(updated);
      } else {
        await onSave([...routines, routine]);
      }
      resetForm();
    } finally {
      setSaving(false);
    }
  }

  function handleEdit(index: number) {
    const r = routines[index];
    setName(r.name);
    setFrequency(r.schedule.frequency);
    setDays(r.schedule.days || []);
    setDay(r.schedule.day != null ? String(r.schedule.day) : "");
    setTime(r.schedule.time);
    setTitle(r.issue.title);
    setSelectedLabels([...r.issue.labels]);
    setBody(r.issue.body || "");
    setAutoClose(r.auto_close || "");
    setStartDate(r.schedule.start_date || "");
    setEndDate(r.schedule.end_date || "");
    setEditingIndex(index);
    setShowForm(true);
  }

  async function handleDelete(index: number) {
    if (editingIndex === index) resetForm();
    setSaving(true);
    try {
      await onSave(routines.filter((_, i) => i !== index));
    } finally {
      setSaving(false);
    }
  }

  function resetForm() {
    setName(""); setFrequency("daily"); setDays([]);
    setDay(""); setTime("09:00"); setTitle("");
    setSelectedLabels(["種別:ルーチン"]); setBody(""); setAutoClose("");
    setStartDate(""); setEndDate("");
    setEditingIndex(null);
    setShowForm(false);
  }

  const isEditing = editingIndex !== null;

  return (
    <div className="content">
      <div className="toolbar">
        <button onClick={() => { if (showForm) resetForm(); else setShowForm(true); }} className="btn-sm">
          {showForm ? "×" : "+ ルーチン追加"}
        </button>
        <button onClick={onRefresh} className="btn-sm">更新</button>
      </div>

      {showForm && (
        <div className="form-card" style={{ borderLeft: isEditing ? "3px solid var(--accent-blue)" : undefined }}>
          {isEditing && (
            <p style={{ fontSize: "var(--font-sm)", color: "var(--accent-blue)", margin: "0 0 var(--space-xs)" }}>
              「{routines[editingIndex]?.name}」を編集中
            </p>
          )}
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
          <div className="flex-row" style={{ alignItems: "center", gap: "var(--space-xs)" }}>
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", flexShrink: 0 }}>期間:</span>
            <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
              className="input-full" style={{ maxWidth: "160px" }} />
            <span style={{ fontSize: "var(--font-sm)", color: "var(--text-faint)" }}>〜</span>
            <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
              className="input-full" style={{ maxWidth: "160px" }} />
            <span style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)" }}>（空欄で無期限）</span>
          </div>
          <input value={autoClose} onChange={(e) => setAutoClose(e.target.value)}
            placeholder="自動クローズ時刻（例: 23:59、空欄で無効）" className="input-full" style={{ maxWidth: "200px" }} />
          <div className="flex-row">
            <button onClick={handleSubmit} className="btn-primary" disabled={!name || !title || saving}>
              {saving ? "保存中..." : isEditing ? "更新" : "追加"}
            </button>
            {isEditing && (
              <button onClick={resetForm} className="btn-sm">キャンセル</button>
            )}
          </div>
        </div>
      )}

      {routines.map((routine, index) => {
        const scheduleStr = routine.schedule.frequency === "daily"
          ? `毎日${routine.schedule.days ? ` (${routine.schedule.days.map((d) => weekdayLabels[d] || d).join("")})` : ""}`
          : routine.schedule.frequency === "weekly"
          ? `毎週${weekdayLabels[String(routine.schedule.day)] || routine.schedule.day}曜日`
          : `毎月${routine.schedule.day}日`;

        const periodStr = (routine.schedule.start_date || routine.schedule.end_date)
          ? ` [${routine.schedule.start_date || ""}〜${routine.schedule.end_date || ""}]`
          : "";

        return (
          <div key={index} className="issue-card" style={editingIndex === index ? { borderColor: "var(--accent-blue)" } : undefined}>
            <div className="issue-card-header">
              <div>
                <strong>{routine.name}</strong>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)", marginLeft: "8px" }}>
                  {scheduleStr} {routine.schedule.time}{periodStr}
                </span>
              </div>
              <div className="flex-row" style={{ gap: "var(--space-xs)" }}>
                <button className="btn-sm" onClick={() => handleEdit(index)} disabled={saving}>編集</button>
                <button className="btn-sm" onClick={() => handleDelete(index)} disabled={saving}
                  style={{ color: "var(--accent-red)" }}>削除</button>
              </div>
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
      {routines.length === 0 && (
        <p className="empty-message">ルーチンが設定されていません</p>
      )}
    </div>
  );
}
