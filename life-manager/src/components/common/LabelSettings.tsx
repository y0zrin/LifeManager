// 設定 → タスク の「ラベル」（#281）。区分（種別・状態・優先・セクション・見積・そのほか）ごとのタブに分け、
// タブの中は、名前の頭を外した札を折り返して並べる（1 個 1 行の縦長にしない）。
// 「＋」で、その区分のラベルを作る（頭はアプリが付ける）。札を押すと、札の下で直す・消す
import { useMemo, useState, type KeyboardEvent } from "react";
import type { GitHubLabel } from "../../lib/types";
import { labelCategories, prefixOf, type LabelCategory } from "../../lib/labelCategory";
import { labelValueText, tr } from "../../lib/i18n";

/** 開いているタブ（区分の頭）をこの PC に覚える */
const TAB_KEY = "label-settings-tab";
/** 新しいラベルの色の候補（GitHub がすすめる色） */
const PALETTE = ["B60205", "D93F0B", "FBCA04", "0E8A16", "006B75", "1D76DB", "0052CC", "5319E7", "E99695", "F9D0C4", "FEF2C0", "C2E0C6", "BFDADC", "C5DEF5", "BFD4F2", "D4C5F9"];

function loadTab(): string {
  try {
    return localStorage.getItem(TAB_KEY) ?? "種別:";
  } catch {
    return "種別:";
  }
}

/** 札の字の色（LabelBadge と同じ: 色の値が 0x7fffff より大きければ黒） */
const inkOf = (color: string) => (parseInt(color, 16) > 0x7fffff ? "#000" : "#fff");

type Form = { mode: "new" } | { mode: "edit"; label: GitHubLabel; confirmDelete: boolean };

interface LabelSettingsProps {
  labels: GitHubLabel[];
  onCreate: (name: string, color: string, description: string) => Promise<void>;
  onUpdate: (currentName: string, newName: string, color: string, description: string) => Promise<void>;
  onDelete: (name: string) => Promise<void>;
  onSetup: () => Promise<void>;
}

export function LabelSettings({ labels, onCreate, onUpdate, onDelete, onSetup }: LabelSettingsProps) {
  const categories = useMemo(() => labelCategories(labels), [labels]);
  const [tab, setTabState] = useState(loadTab);
  const current: LabelCategory = categories.find((c) => c.prefix === tab) ?? categories[0];
  const [form, setForm] = useState<Form | null>(null);
  const [value, setValue] = useState("");
  const [color, setColor] = useState("#0E8A16");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);

  const setTab = (prefix: string) => {
    setTabState(prefix);
    setForm(null);
    try {
      localStorage.setItem(TAB_KEY, prefix);
    } catch {
      // 覚えられなくても、タブは替わる
    }
  };

  const openNew = () => {
    setForm({ mode: "new" });
    setValue("");
    setDescription("");
    setColor(`#${PALETTE[Math.floor(Math.random() * PALETTE.length)]}`);
  };

  const openEdit = (l: GitHubLabel) => {
    if (form?.mode === "edit" && form.label.name === l.name) {
      setForm(null);
      return;
    }
    setForm({ mode: "edit", label: l, confirmDelete: false });
    setValue(l.name.slice(prefixOf(l.name, current).length));
    setColor(`#${l.color}`);
    setDescription(l.description ?? "");
  };

  // 書いて、うまくいったら欄を閉じる（失敗したときは欄を残す。わけは上の知らせに出る）
  const run = async (task: () => Promise<void>) => {
    setBusy(true);
    try {
      await task();
      setForm(null);
    } catch {
      // useRepoMeta が知らせに出す
    } finally {
      setBusy(false);
    }
  };

  const editing = form?.mode === "edit" ? form.label : null;
  const prefix = editing ? prefixOf(editing.name, current) : current.prefix;
  // 見積のラベルは、名前を変えると見積もりとして読めなくなるので、色と説明だけ直す
  const fixedName = editing !== null && !current.canAdd;
  const name = `${prefix}${value.trim()}`;
  const submit = () => {
    if (!value.trim() || busy) return;
    const hex = color.replace("#", "");
    if (form?.mode === "new") void run(() => onCreate(name, hex, description.trim()));
    else if (editing) void run(() => onUpdate(editing.name, name, hex, description.trim()));
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" && !e.nativeEvent.isComposing) submit();
    else if (e.key === "Escape") setForm(null);
  };

  return (
    <div className="form-card">
      <div className="settings-section-header">
        <h3 className="settings-section-title">{tr("ラベル")}</h3>
        <button
          onClick={onSetup}
          className="btn-sm"
          title={tr("優先（高・中・低）とセクション（プログラマー・デザイナー・プランナー・その他）の 7 つを作ります。もうあるラベルはそのままです")}
        >
          {tr("ラベル一括作成")}
        </button>
      </div>

      <div className="ls-tabs" role="tablist" aria-label={tr("ラベルの区分")}>
        {categories.map((c) => (
          <button
            key={c.prefix}
            type="button"
            role="tab"
            aria-selected={c === current}
            className={`ls-tab${c === current ? " on" : ""}`}
            title={c.canAdd ? undefined : tr("見積もりのラベルは、タスクに見積もりを付けたときに作ります")}
            onClick={() => setTab(c.prefix)}
          >
            {c.name}
            <span className="ls-tab-n">{c.labels.length}</span>
          </button>
        ))}
      </div>

      <div className="ls-pane" role="tabpanel">
        <div className="ls-chips">
          {current.labels.map((l) => (
            <button
              key={l.name}
              type="button"
              className={`ls-chip${editing?.name === l.name ? " on" : ""}`}
              style={{ background: `#${l.color}`, color: inkOf(l.color) }}
              title={l.description || undefined}
              onClick={() => openEdit(l)}
            >
              {labelValueText(l.name)}
            </button>
          ))}
          {current.canAdd && (
            <button
              type="button"
              className={`ls-add${form?.mode === "new" ? " on" : ""}`}
              title={tr("この区分のラベルを作る")}
              aria-label={tr("この区分のラベルを作る")}
              onClick={() => (form?.mode === "new" ? setForm(null) : openNew())}
            >
              ＋
            </button>
          )}
          {current.labels.length === 0 && !current.canAdd && <span className="settings-hint--subtle">{tr("ラベルがありません")}</span>}
        </div>

        {form && (
          <div className="ls-form">
            <input type="color" value={color} onChange={(e) => setColor(e.target.value)} className="color-picker-input" aria-label={tr("色")} />
            {prefix && <span className="ls-prefix">{prefix}</span>}
            {fixedName ? (
              <span className="ls-fixed">{value}</span>
            ) : (
              <input className="ls-input" value={value} onChange={(e) => setValue(e.target.value)} onKeyDown={onKey} placeholder={tr("名前")} autoFocus />
            )}
            <input className="ls-input wide" value={description} onChange={(e) => setDescription(e.target.value)} onKeyDown={onKey} placeholder={tr("説明（任意）")} />
            {form.mode === "new" ? (
              <>
                <button type="button" className="btn-primary" onClick={submit} disabled={!value.trim() || busy}>
                  {busy ? tr("作成中...") : tr("作成")}
                </button>
                <button type="button" className="btn-sm" onClick={() => setForm(null)}>
                  {tr("やめる")}
                </button>
              </>
            ) : form.confirmDelete ? (
              <>
                <button type="button" className="btn-sm ls-danger" disabled={busy} onClick={() => void run(() => onDelete(form.label.name))}>
                  {busy ? "…" : tr("消す")}
                </button>
                <button type="button" className="btn-sm" onClick={() => setForm({ ...form, confirmDelete: false })}>
                  {tr("やめる")}
                </button>
                <span className="ls-warn">{tr("消すと、付けてあるタスクからも外れます（元に戻せません）")}</span>
              </>
            ) : (
              <>
                <button type="button" className="btn-primary" onClick={submit} disabled={!value.trim() || busy}>
                  {busy ? tr("保存中...") : tr("保存")}
                </button>
                <button type="button" className="btn-sm ls-danger" onClick={() => setForm({ ...form, confirmDelete: true })}>
                  {tr("消す…")}
                </button>
                <button type="button" className="btn-sm" onClick={() => setForm(null)}>
                  {tr("やめる")}
                </button>
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
