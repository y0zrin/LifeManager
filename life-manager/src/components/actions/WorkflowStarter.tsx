import { useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { openUrl } from "@tauri-apps/plugin-opener";
import { repoRootFiles } from "../../lib/actions";
import { addNewFile } from "../../lib/git";
import { isEscape } from "../../lib/keys";
import { WORKFLOW_TEMPLATES, newFileUrl, suggestTemplate } from "../../lib/workflowTemplates";

interface WorkflowStarterProps {
  owner: string;
  repo: string;
  defaultBranch: string;
  language: string | null;
  /** この PC の作業フォルダ（あれば、そこに置いて作業タブでコミット・プッシュ） */
  folder: string | null;
  onPlaced: (file: string) => void;
  onClose: () => void;
}

/** はじめる準備: テストを動かすワークフローのひな形を選んで置く（この PC の作業フォルダ、なければ GitHub の画面） */
export function WorkflowStarter({ owner, repo, defaultBranch, language, folder, onPlaced, onClose }: WorkflowStarterProps) {
  const [files, setFiles] = useState<string[] | null>(null);
  const [templateId, setTemplateId] = useState<string | null>(null);
  const [dir, setDir] = useState(".");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    repoRootFiles(owner, repo)
      .then((f) => setFiles(f))
      .catch(() => setFiles([]));
  }, [owner, repo]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !busy) onClose();
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [busy, onClose]);

  const suggested = useMemo(() => (files ? suggestTemplate(files, language) : null), [files, language]);
  const template = WORKFLOW_TEMPLATES.find((t) => t.id === (templateId ?? suggested?.id)) ?? WORKFLOW_TEMPLATES[WORKFLOW_TEMPLATES.length - 1];
  const yaml = template.yaml(dir.trim() || ".");

  async function place() {
    if (!folder) return;
    setBusy(true);
    setError(null);
    try {
      await addNewFile(folder, template.file, yaml);
      onPlaced(template.file);
    } catch (e) {
      setError(String(e));
      setBusy(false);
    }
  }

  async function copy() {
    try {
      await navigator.clipboard.writeText(yaml);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // 写せなくても、中身は画面に出ている
    }
  }

  return createPortal(
    <div className="palette-overlay git-dialog-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog pr-ui ac-starter" role="dialog" aria-modal="true" aria-label="ワークフローを置く" onClick={(e) => e.stopPropagation()}>
        <h3>▶ テストを動かすワークフローを置く</h3>
        <p className="hint">
          <code>.github/workflows/</code> に YAML のファイルを置いてプッシュすると、そのあとはプッシュやプルリクのたびに、GitHub がテストを動かして結果を知らせてくれます（Actions の山に入ります）。
        </p>
        {!files ? (
          <p className="muted">リポジトリのファイルを見ています…</p>
        ) : (
          <>
            <div className="ac-templates" role="radiogroup" aria-label="ひな形">
              {WORKFLOW_TEMPLATES.map((t) => (
                <label key={t.id} className={`ac-template${template.id === t.id ? " on" : ""}`}>
                  <input type="radio" name="workflow-template" checked={template.id === t.id} onChange={() => setTemplateId(t.id)} />
                  <span>
                    <b>{t.name}</b>
                    {suggested?.id === t.id && t.id !== "hello" && <span className="ok">（このリポジトリに合いそう）</span>}
                    <span className="muted"> — {t.detail}</span>
                  </span>
                </label>
              ))}
            </div>
            {template.id !== "hello" && (
              <label className="ac-starter-dir">
                <span className="git-dialog-label">プロジェクトのあるフォルダ（いちばん上なら . のまま。例: life-manager）</span>
                <input className="git-dialog-input" value={dir} onChange={(e) => setDir(e.target.value)} />
              </label>
            )}
            <div className="ac-starter-file">
              置くファイル: <code>{template.file}</code>
            </div>
            <pre className="ac-yaml">{yaml}</pre>
          </>
        )}
        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          <button type="button" className="btn-sm" disabled={busy} onClick={onClose}>
            やめる
          </button>
          <button type="button" className="btn-sm" onClick={copy}>
            {copied ? "✔ コピーしました" : "中身をコピー"}
          </button>
          <button type="button" className="btn-sm" onClick={() => openUrl(newFileUrl(owner, repo, defaultBranch, template.file, yaml)).catch(() => {})}>
            GitHub の画面で作る ↗
          </button>
          {folder && (
            <button type="button" className="btn-primary" disabled={busy || !files} onClick={place}>
              {busy ? "置いています…" : "この PC の作業フォルダに置く"}
            </button>
          )}
        </div>
        <p className="muted">
          {folder
            ? "作業フォルダに置いたら、作業タブでチェックを入れてコミットし、プッシュすると動き始めます。"
            : "作業フォルダを決めていないので、GitHub の画面で作ります（名前と中身が入った状態で開きます。入っていなければ、コピーして貼ります）。"}
        </p>
      </div>
    </div>,
    document.querySelector("main.app") ?? document.body,
  );
}
