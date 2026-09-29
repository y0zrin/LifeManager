import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { checkToken, tokenCreateUrl, type RepoRef, type TokenReport } from "../../lib/auth";
import { TokenReportView } from "./TokenReportView";

interface TokenEntryProps {
  /** 確かめるリポジトリ（あれば、見えるか・Issue を読めるかも確かめる） */
  repos: RepoRef[];
  /** 作成ページの持ち主（組織のリポジトリなら組織）。空なら自分 */
  owner?: string;
  onSave: (token: string) => Promise<void>;
  saveLabel?: string;
  onCancel?: () => void;
}

/**
 * トークンを入れる。「GitHub で作る」で、名前・期限・権限を入れた作成ページを開き、貼るとすぐ確かめる
 * （だれのトークンか・期限・リポジトリが見えるか）
 */
export function TokenEntry({ repos, owner, onSave, saveLabel = "このトークンにする", onCancel }: TokenEntryProps) {
  const [token, setToken] = useState("");
  const [show, setShow] = useState(false);
  const [report, setReport] = useState<TokenReport | null>(null);
  const [checking, setChecking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // 貼ったら少し待って確かめる（打っている途中で何度も問い合わせない）
  const trimmed = token.trim();
  const repoKey = repos.map((r) => `${r.owner}/${r.repo}`).join(",");
  useEffect(() => {
    setReport(null);
    setError(null);
    if (trimmed.length < 20) return;
    let alive = true;
    const timer = setTimeout(() => {
      setChecking(true);
      checkToken({ token: trimmed, repos })
        .then((r) => alive && setReport(r))
        .catch((e) => alive && setError(String(e)))
        .finally(() => alive && setChecking(false));
    }, 500);
    return () => {
      alive = false;
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trimmed, repoKey]);

  async function save() {
    setSaving(true);
    try {
      await onSave(trimmed);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="token-entry">
      <div className="token-step">
        <span className="token-step-n">1</span>
        <b>GitHub でトークンを作る</b>
        <div className="token-step-body">
          <button type="button" className="btn-sm" onClick={() => openUrl(tokenCreateUrl(owner))}>
            GitHub で作る（ブラウザが開きます）
          </button>
          <p className="token-step-note">
            名前・期限（90 日）・権限（<code>Issues</code>・<code>Pull requests</code>・<code>Contents</code> の読み書き）は入った状態で開きます。自分で選ぶのは
            <b>「Repository access → Only select repositories」</b>で、使うリポジトリを選ぶことだけ。最後に「Generate token」を押し、出てきたトークン（
            <code>github_pat_…</code>）をコピーします。
          </p>
        </div>
      </div>
      <div className="token-step">
        <span className="token-step-n">2</span>
        <b>ここに貼る</b>
        <div className="token-step-body">
          <span className="token-input">
            <input
              className="input-full"
              type={show ? "text" : "password"}
              value={token}
              autoComplete="off"
              spellCheck={false}
              placeholder="github_pat_…"
              onChange={(e) => setToken(e.target.value)}
            />
            <button type="button" className="btn-sm" onClick={() => setShow((v) => !v)}>
              {show ? "隠す" : "見る"}
            </button>
          </span>
          {checking && (
            <p className="token-step-note">
              <i className="spinner" aria-hidden="true" /> 確かめています…
            </p>
          )}
          {report && <TokenReportView report={report} />}
          {error && <p className="token-error">{error}</p>}
        </div>
      </div>
      <p className="hint">
        <b>トークン</b>は、アプリが自分の代わりに GitHub を使うための「合鍵」です。人に見せたり、コードに書いたりしないでください。アプリは PC
        の鍵の保管場所（キーチェーン）にしまいます。ほかの人のトークンは使わず、自分のアカウントで作ります。
      </p>
      <div className="token-entry-actions">
        {onCancel && (
          <button type="button" className="btn-sm" disabled={saving} onClick={onCancel}>
            やめる
          </button>
        )}
        <button type="button" className="btn-primary" disabled={!report || saving} onClick={save}>
          {saving ? "しまっています…" : saveLabel}
        </button>
      </div>
    </div>
  );
}
