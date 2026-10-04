import { useEffect, useState } from "react";
import type { BoardColumn, BoardConfig, BoardGenre, GitHubLabel } from "../../lib/types";
import { BOARD_COUNT, BOARD_GENRES, boardColumns, genreOf } from "../../lib/board";
import { tr, trx } from "../../lib/i18n";

interface BoardColumnsSettingProps {
  boardConfig: BoardConfig | null;
  labels: GitHubLabel[];
  onSave: (config: BoardConfig) => Promise<void>;
}

/** 区画ごとに、置くボードを書き出しておく（設定がない区画は、状態の名前から決まる） */
function withGenre(columns: BoardColumn[]): BoardColumn[] {
  return columns.map((c) => ({ ...c, genre: genreOf(c) }));
}

/** ボードの区画（どの状態を、どのボードに置くか・並び）。リポジトリの config/board.yaml に置き、チームで共有する */
export function BoardColumnsSetting({ boardConfig, labels, onSave }: BoardColumnsSettingProps) {
  const saved = withGenre(boardColumns(boardConfig));
  const savedText = JSON.stringify(saved);
  const [columns, setColumns] = useState<BoardColumn[]>(saved);
  const [newKey, setNewKey] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [newEmoji, setNewEmoji] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(columns) !== savedText;

  // 読み直したら（ほかの PC で変えたときなど）、手を付けていなければ合わせる
  useEffect(() => {
    if (!dirty) setColumns(JSON.parse(savedText) as BoardColumn[]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedText]);

  const used = new Set(columns.map((c) => c.key));
  const statusLabels = labels.filter((l) => l.name.startsWith("状態:") && !used.has(l.name));

  function move(index: number, dir: -1 | 1) {
    const to = index + dir;
    if (to < 0 || to >= columns.length) return;
    const next = [...columns];
    [next[index], next[to]] = [next[to], next[index]];
    setColumns(next);
  }

  function add() {
    if (!newKey || !newTitle.trim()) return;
    setColumns([...columns, { key: newKey, title: newTitle.trim(), emoji: newEmoji.trim() || "📋", genre: "doing" }]);
    setNewKey("");
    setNewTitle("");
    setNewEmoji("");
  }

  async function save() {
    setSaving(true);
    setError(null);
    try {
      await onSave({ columns, boards: BOARD_COUNT });
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="form-card" id="settings-board">
      <h3 className="settings-section-title" style={{ marginBottom: "var(--space-xs)" }}>{tr("ボードの区画")}</h3>
      <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
        {trx("状態ごとの区画をどのボード（📥 未整理・🔥 着手済み・🔍 確認待ち）に置くかと、並びを決めます。チームで一つの決まりです。リポジトリの <0>config/board.yaml</0> に置き、GitHub に送ります。", undefined, [<code />])}
      </p>
      <div className="board-cols">
        {columns.map((col, index) => (
          <div key={col.key} className="board-col-row">
            <span className="board-col-name">
              {col.emoji} {tr(col.title)}
            </span>
            <select
              className="select-sm"
              value={genreOf(col)}
              aria-label={tr("{title} を置くボード", { title: tr(col.title) })}
              onChange={(e) => setColumns(columns.map((c, i) => (i === index ? { ...c, genre: e.target.value as BoardGenre } : c)))}
            >
              {BOARD_GENRES.map((g) => (
                <option key={g.key} value={g.key}>
                  {g.icon} {g.label}
                </option>
              ))}
            </select>
            <span className="board-col-moves">
              <button type="button" className="btn-sm" onClick={() => move(index, -1)} disabled={index === 0} aria-label={tr("{title} を上へ", { title: tr(col.title) })}>
                ↑
              </button>
              <button type="button" className="btn-sm" onClick={() => move(index, 1)} disabled={index === columns.length - 1} aria-label={tr("{title} を下へ", { title: tr(col.title) })}>
                ↓
              </button>
              <button type="button" className="btn-sm board-col-remove" onClick={() => setColumns(columns.filter((_, i) => i !== index))} aria-label={tr("{title} を外す", { title: tr(col.title) })}>
                ×
              </button>
            </span>
          </div>
        ))}
      </div>
      <div className="board-col-add">
        <span className="board-col-add-title">{tr("区画を足す")}</span>
        <select
          className="select-sm"
          value={newKey}
          aria-label={tr("足す区画の状態")}
          onChange={(e) => {
            setNewKey(e.target.value);
            if (e.target.value && !newTitle) setNewTitle(e.target.value === "none" ? tr("未分類") : e.target.value.split(":")[1] || "");
          }}
        >
          <option value="">{tr("状態のラベルを選ぶ…")}</option>
          {!used.has("none") && <option value="none">{tr("未分類（状態のラベルなし）")}</option>}
          {statusLabels.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
        <input value={newEmoji} onChange={(e) => setNewEmoji(e.target.value)} placeholder={tr("絵文字")} className="input-full board-col-emoji" aria-label={tr("絵文字")} />
        <input value={newTitle} onChange={(e) => setNewTitle(e.target.value)} placeholder={tr("表示名")} className="input-full board-col-title" aria-label={tr("表示名")} />
        <button type="button" className="btn-sm" onClick={add} disabled={!newKey || !newTitle.trim()}>
          {tr("足す")}
        </button>
      </div>
      <div className="board-col-actions">
        {dirty && <span className="board-col-dirty">{tr("保存していない変更があります")}</span>}
        <button type="button" className="btn-sm" onClick={() => setColumns(saved)} disabled={!dirty || saving}>
          {tr("元に戻す")}
        </button>
        <button type="button" className="btn-primary" onClick={save} disabled={!dirty || saving}>
          {saving ? tr("保存しています…") : tr("保存")}
        </button>
      </div>
      {error && <p className="git-dialog-error">{error}</p>}
    </div>
  );
}
