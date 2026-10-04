import { useState } from "react";
import { BUILTIN_TEMPLATES, type IssueTemplate } from "../../lib/issueTemplates";
import { tr, trx } from "../../lib/i18n";

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
      setMessage({ text: tr("テンプレートを置きました") });
    } catch (e) {
      setMessage({ text: String(e), error: true });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="issue-templates">
      <div className="issue-templates-row">
        <span className="issue-templates-label">{tr("テンプレート:")}</span>
        <button type="button" className={`template-chip${selected === null ? " on" : ""}`} onClick={() => onSelect(null)}>
          {tr("なし")}
        </button>
        {templates === null && !error ? (
          <span className="issue-templates-note">{tr("読み込み中…")}</span>
        ) : (
          shown.map((t) => (
            <button key={t.file} type="button" className={`template-chip${selected === t.file ? " on" : ""}`} title={tr(t.about)} onClick={() => onSelect(t)}>
              {tr(t.name)}
              {t.about && <small>{tr(t.about)}</small>}
            </button>
          ))
        )}
      </div>
      {none && (
        <div className="issue-templates-none">
          {trx("<0>このリポジトリにはまだテンプレートがありません。</0>見本の 3 つを使えます。", undefined, [<b />])}{" "}
          <button type="button" className="link-button" disabled={busy} onClick={place}>
            {tr("このリポジトリに置く")}
          </button>
          <div className="cmd-preview">
            {trx("<0>置くファイル</0><1>{join}</1>", { join: BUILTIN_TEMPLATES.map((t) => `.github/ISSUE_TEMPLATE/${t.file}`).join("\n") }, [<span />, <code />])}
          </div>
        </div>
      )}
      {busy && (
        <p className="issue-templates-note">
          <i className="spinner" aria-hidden="true" /> {" "}{tr("置いています…")}
        </p>
      )}
      {message && <p className={`sub-issues-note${message.error ? " sub-issues-note--error" : " sub-issues-note--ok"}`}>{message.text}</p>}
      {error && <p className="issue-templates-note">{trx("テンプレートを読めませんでした（{error}）。見本を出しています", { error })}</p>}
    </div>
  );
}
