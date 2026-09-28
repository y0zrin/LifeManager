import type { GitHubLabel, GitHubMilestone, GitHubUser } from "../../lib/types";

/** まとめて変える操作 */
export type BulkAction =
  | { kind: "close" }
  | { kind: "reopen" }
  | { kind: "status"; label: string }
  | { kind: "label"; label: string }
  | { kind: "milestone"; number: number | null; title: string }
  | { kind: "assignee"; login: string | null };

interface BulkBarProps {
  count: number;
  /** 選んだ中に、開いている・閉じた Issue があるか（出すボタンを決める） */
  hasOpen: boolean;
  hasClosed: boolean;
  labels: GitHubLabel[];
  milestones: GitHubMilestone[];
  collaborators: GitHubUser[];
  currentUser: string;
  busy: string | null;
  message: string | null;
  onRun: (action: BulkAction) => void;
  onSelectAll: () => void;
  onQuit: () => void;
}

/** 「☑ 選ぶ」で選んだ Issue を、まとめて変える帯（画面の下） */
export function BulkBar({ count, hasOpen, hasClosed, labels, milestones, collaborators, currentUser, busy, message, onRun, onSelectAll, onQuit }: BulkBarProps) {
  const disabled = count === 0 || !!busy;
  const statusLabels = labels.filter((l) => l.name.startsWith("状態:"));
  const otherLabels = labels.filter((l) => !l.name.startsWith("状態:"));
  const people = [currentUser, ...collaborators.map((c) => c.login).filter((l) => l !== currentUser)].filter(Boolean);

  // 選んだらすぐ実行し、選択肢は見出しに戻す
  const pick = (e: React.ChangeEvent<HTMLSelectElement>, run: (value: string) => void) => {
    const value = e.target.value;
    e.target.value = "";
    if (value) run(value);
  };

  return (
    <div className="bulk-bar" role="toolbar" aria-label="まとめて変える">
      <div className="bulk-bar-inner">
        <span className="bulk-bar-count">
          <b>{count}</b> 件を選択中
        </span>
        {hasOpen && (
          <button type="button" className="btn-sm" disabled={disabled} onClick={() => onRun({ kind: "close" })}>
            完了にする
          </button>
        )}
        {hasClosed && (
          <button type="button" className="btn-sm" disabled={disabled} onClick={() => onRun({ kind: "reopen" })}>
            再開する
          </button>
        )}
        {hasOpen && statusLabels.length > 0 && (
          <select className="select-sm" defaultValue="" disabled={disabled} onChange={(e) => pick(e, (label) => onRun({ kind: "status", label }))}>
            <option value="">状態を変える…</option>
            {statusLabels.map((l) => (
              <option key={l.name} value={l.name}>
                {l.name.replace("状態:", "")}
              </option>
            ))}
          </select>
        )}
        <select className="select-sm" defaultValue="" disabled={disabled} onChange={(e) => pick(e, (label) => onRun({ kind: "label", label }))}>
          <option value="">ラベルを付ける…</option>
          {otherLabels.map((l) => (
            <option key={l.name} value={l.name}>
              {l.name}
            </option>
          ))}
        </select>
        <select
          className="select-sm"
          defaultValue=""
          disabled={disabled}
          onChange={(e) =>
            pick(e, (v) => {
              const m = milestones.find((x) => String(x.number) === v);
              onRun({ kind: "milestone", number: m ? m.number : null, title: m ? m.title : "なし" });
            })
          }
        >
          <option value="">マイルストーン…</option>
          {milestones.map((m) => (
            <option key={m.number} value={m.number}>
              {m.title}
            </option>
          ))}
          <option value="none">（外す）</option>
        </select>
        <select className="select-sm" defaultValue="" disabled={disabled} onChange={(e) => pick(e, (v) => onRun({ kind: "assignee", login: v === "none" ? null : v }))}>
          <option value="">担当…</option>
          {people.map((login) => (
            <option key={login} value={login}>
              {login === currentUser ? `自分（${login}）` : login}
            </option>
          ))}
          <option value="none">（外す）</option>
        </select>
        <button type="button" className="btn-sm" disabled={!!busy} onClick={onSelectAll}>
          全部選ぶ
        </button>
        <button type="button" className="btn-sm" disabled={!!busy} onClick={onQuit}>
          やめる
        </button>
        {busy && (
          <span className="bulk-bar-note">
            <i className="spinner" aria-hidden="true" /> {busy}
          </span>
        )}
        {!busy && message && <span className="bulk-bar-note bulk-bar-note--ok">{message}</span>}
      </div>
    </div>
  );
}
