import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { dispatchWorkflow, type Workflow } from "../../lib/actions";
import { isEscape } from "../../lib/keys";

interface DispatchDialogProps {
  owner: string;
  repo: string;
  workflow: Workflow;
  branches: string[];
  defaultBranch: string;
  /** 非公開のリポジトリ（無料の時間を使う。確かめるチェックを入れないと動かせない） */
  privateRepo?: boolean;
  /** 無料の時間を使うアカウント */
  ownerLabel?: string;
  onDone: () => void;
  onClose: () => void;
}

/** 手で実行（workflow_dispatch）: ブランチと、ワークフローに書いてある入力を決めて動かす */
export function DispatchDialog({ owner, repo, workflow, branches, defaultBranch, privateRepo, ownerLabel, onDone, onClose }: DispatchDialogProps) {
  const inputs = workflow.dispatch ?? [];
  const [ref, setRef] = useState(defaultBranch);
  const [values, setValues] = useState<Record<string, string>>(() =>
    Object.fromEntries(inputs.map((i) => [i.name, i.default ?? (i.type === "boolean" ? "false" : i.type === "choice" ? i.options[0] ?? "" : "")])),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [agreed, setAgreed] = useState(false);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const missing = inputs.filter((i) => i.required && i.type !== "boolean" && !(values[i.name] ?? "").trim());

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await dispatchWorkflow(owner, repo, workflow.id, ref, values);
      onDone();
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  return createPortal(
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog pr-ui ac-dispatch" role="dialog" aria-modal="true" aria-label="手で実行" onClick={(e) => e.stopPropagation()}>
        <h3>▶ {workflow.name} を手で実行</h3>
        <p className="hint">
          <code>{workflow.path}</code> を、選んだブランチの中身で動かします（ファイルに <code>workflow_dispatch</code> と書いてあるワークフローだけ）。
        </p>
        <label>
          <span className="git-dialog-label">ブランチ</span>
          <select className="select-sm" value={ref} onChange={(e) => setRef(e.target.value)}>
            {(branches.length > 0 ? branches : [defaultBranch]).map((b) => (
              <option key={b} value={b}>
                {b}
                {b === defaultBranch ? "（既定）" : ""}
              </option>
            ))}
          </select>
        </label>
        {inputs.map((i) => (
          <label key={i.name} className={i.type === "boolean" ? "ac-dispatch-check" : undefined}>
            {i.type === "boolean" ? (
              <>
                <input type="checkbox" checked={values[i.name] === "true"} onChange={(e) => setValues({ ...values, [i.name]: String(e.target.checked) })} />
                <span>
                  {i.description || i.name} <code>{i.name}</code>
                </span>
              </>
            ) : (
              <>
                <span className="git-dialog-label">
                  {i.description || i.name} <code>{i.name}</code>
                  {i.required && <span className="ng">（必須）</span>}
                </span>
                {i.type === "choice" ? (
                  <select className="select-sm" value={values[i.name]} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })}>
                    {i.options.map((o) => (
                      <option key={o} value={o}>
                        {o}
                      </option>
                    ))}
                  </select>
                ) : (
                  <input className="git-dialog-input" value={values[i.name] ?? ""} onChange={(e) => setValues({ ...values, [i.name]: e.target.value })} />
                )}
              </>
            )}
          </label>
        ))}
        {privateRepo && (
          <label className="ac-dispatch-check ac-dispatch-agree">
            <input type="checkbox" checked={agreed} onChange={(e) => setAgreed(e.target.checked)} />
            <span>
              非公開のリポジトリなので、{ownerLabel ?? owner} の Actions の無料の時間（月 2,000 分）を使うことを確かめました
            </span>
          </label>
        )}
        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          <button type="button" className="btn-sm" disabled={busy} onClick={onClose}>
            やめる
          </button>
          <button type="button" className="btn-primary" disabled={busy || missing.length > 0 || (!!privateRepo && !agreed)} onClick={submit} title={missing.length > 0 ? `入れてください: ${missing.map((m) => m.name).join("、")}` : undefined}>
            {busy ? "動かしています…" : "実行する"}
          </button>
        </div>
      </div>
    </div>,
    document.querySelector("main.app") ?? document.body,
  );
}
