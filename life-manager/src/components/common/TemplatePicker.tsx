import { useState } from "react";
import { BUILTIN_TEMPLATES, type IssueTemplate } from "../../lib/issueTemplates";

interface TemplatePickerProps {
  /** リポジトリのテンプレート（null は読み込み中）。空なら見本を出す */
  templates: IssueTemplate[] | null;
  /** 選んでいるテンプレートのファイル名（なしは null） */
  selected: string | null;
  onSelect: (template: IssueTemplate | null) => void;
  /** 見本のテンプレートを、リポジトリにファイルとして置く */
  onPlaceBuiltins: () => Promise<void>;
  /** 読めなかったときの理由 */
  error: string | null;
}

/** Issue を作るときのテンプレートの選択（GitHub と同じ .github/ISSUE_TEMPLATE のファイル） */
export function TemplatePicker({ templates, selected, onSelect, onPlaceBuiltins, error }: TemplatePickerProps) {
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ text: string; error?: boolean } | null>(null);
  const none = templates !== null && templates.length === 0;
  const shown = templates && templates.length > 0 ? templates : BUILTIN_TEMPLATES;

  async function place() {
    setBusy(true);
    setMessage(null);
    try {
      await onPlaceBuiltins();
      setMessage({ text: "テンプレートを置きました。GitHub の「New issue」でも選べます（作業タブでプルすると、手元にも来ます）" });
    } catch (e) {
      setMessage({ text: String(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="issue-templates">
      <div className="issue-templates-row">
        <span className="issue-templates-label">テンプレート:</span>
        <button type="button" className={`template-chip${selected === null ? " on" : ""}`} onClick={() => onSelect(null)}>
          なし
        </button>
        {templates === null && !error ? (
          <span className="issue-templates-note">読み込み中…</span>
        ) : (
          shown.map((t) => (
            <button key={t.file} type="button" className={`template-chip${selected === t.file ? " on" : ""}`} title={t.about} onClick={() => onSelect(t)}>
              {t.name}
              {t.about && <small>{t.about}</small>}
            </button>
          ))
        )}
      </div>
      {none && (
        <div className="issue-templates-none">
          <b>このリポジトリには、まだテンプレートがありません。</b>見本の 3 つを使えます。{" "}
          <button type="button" className="link-button" disabled={busy} onClick={place}>
            このリポジトリに置く
          </button>
          （GitHub の「New issue」でも使えるようになります）
          <div className="cmd-preview">
            <span>置くファイル（1 つのコミットにします）</span>
            <code>{BUILTIN_TEMPLATES.map((t) => `.github/ISSUE_TEMPLATE/${t.file}`).join("\n")}</code>
          </div>
        </div>
      )}
      {busy && (
        <p className="issue-templates-note">
          <i className="spinner" aria-hidden="true" /> 置いています…
        </p>
      )}
      {message && <p className={`sub-issues-note${message.error ? " sub-issues-note--error" : " sub-issues-note--ok"}`}>{message.text}</p>}
      {error && <p className="issue-templates-note">テンプレートを読めませんでした（{error}）。見本を出しています</p>}
    </div>
  );
}
