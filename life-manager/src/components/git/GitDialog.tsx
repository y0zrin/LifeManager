import { useEffect, useRef, useState } from "react";
import type { GitResult } from "../../hooks/useGit";
import { isEnter, isEscape } from "../../lib/keys";

/**
 * git の操作の前に出すダイアログ。どれも「実行するコマンド」を見せる。
 * - input: 名前を聞いてから実行する（ブランチの作成・タグなど）
 * - confirm: 確認してから実行する（元に戻せない操作は danger）
 * - choice: やり方を選んでもらう（変更があるときのブランチの切り替えなど）
 */
export type GitDialogSpec =
  | {
      kind: "input";
      title: string;
      label: string;
      placeholder: string;
      initial?: string;
      note?: string;
      okLabel: string;
      commandFor: (value: string) => string;
      submit: (value: string) => Promise<GitResult>;
    }
  | {
      kind: "confirm";
      title: string;
      message: string;
      okLabel: string;
      danger?: boolean;
      /** チェックボックスで選べるおまけ（例: 新しいファイルも消す） */
      option?: string;
      commandFor: (option: boolean) => string;
      submit: (option: boolean) => Promise<GitResult>;
    }
  | {
      kind: "choice";
      title: string;
      message: string;
      choices: { key: string; title: string; detail: string; command: string }[];
      submit: (key: string) => Promise<GitResult>;
    };

interface GitDialogProps {
  spec: GitDialogSpec;
  onClose: () => void;
}

export function GitDialog({ spec, onClose }: GitDialogProps) {
  const [value, setValue] = useState(spec.kind === "input" ? spec.initial ?? "" : "");
  const [option, setOption] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const firstRef = useRef<HTMLButtonElement>(null);

  // 名前を聞くときは入力欄に、確認のときは（うっかり実行しないよう）キャンセルに、フォーカスを置く
  useEffect(() => {
    (inputRef.current ?? firstRef.current)?.focus();
    inputRef.current?.select();
  }, []);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !running) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [running, onClose]);

  async function run(result: Promise<GitResult>) {
    setRunning(true);
    setError(null);
    const r = await result;
    setRunning(false);
    if (r.ok) {
      onClose();
      return;
    }
    setError(r.message);
    // 名前を直してすぐ打ち直せるように
    inputRef.current?.focus();
    inputRef.current?.select();
  }

  function submitInput() {
    if (spec.kind !== "input" || running) return;
    const v = value.trim();
    if (!v) {
      setError(`${spec.label}を入力してください`);
      inputRef.current?.focus();
      return;
    }
    run(spec.submit(v));
  }

  const command =
    spec.kind === "input" ? spec.commandFor(value.trim() || spec.placeholder)
    : spec.kind === "confirm" ? spec.commandFor(option)
    : null;

  return (
    <div className="palette-overlay git-dialog-back" onClick={() => { if (!running) onClose(); }}>
      <div className="git-dialog" role="dialog" aria-modal="true" aria-label={spec.title} onClick={(e) => e.stopPropagation()}>
        <h3>{spec.title}</h3>

        {spec.kind === "input" ? (
          <>
            <label className="git-dialog-label">
              {spec.label}
              <input
                ref={inputRef}
                className="input-full"
                value={value}
                placeholder={spec.placeholder}
                autoComplete="off"
                spellCheck={false}
                // disabled にするとフォーカスが外れてしまうので、実行中は読み取り専用にする
                readOnly={running}
                onChange={(e) => { setValue(e.target.value); setError(null); }}
                onKeyDown={(e) => { if (isEnter(e)) submitInput(); }}
              />
            </label>
            {spec.note && <p className="git-dialog-note">{spec.note}</p>}
          </>
        ) : (
          <p className="git-dialog-message">{spec.message}</p>
        )}

        {spec.kind === "confirm" && spec.option && (
          <label className="chk">
            <input type="checkbox" checked={option} disabled={running} onChange={(e) => setOption(e.target.checked)} />
            {spec.option}
          </label>
        )}

        {spec.kind === "choice" &&
          spec.choices.map((c, i) => (
            <button
              key={c.key}
              ref={i === 0 ? firstRef : undefined}
              type="button"
              className="git-choice"
              disabled={running}
              onClick={() => run(spec.submit(c.key))}
            >
              <b>{c.title}</b>
              <small>{c.detail}</small>
              <code>{c.command}</code>
            </button>
          ))}

        {command && (
          <div className="cmd-preview">
            <span>実行するコマンド</span>
            <code>{command}</code>
          </div>
        )}

        {error && <p className="git-dialog-error">{error}</p>}
        {running && <p className="git-dialog-running">実行しています…</p>}

        <div className="git-dialog-actions">
          <button
            type="button"
            className="btn-sm"
            ref={spec.kind === "confirm" ? firstRef : undefined}
            disabled={running}
            onClick={onClose}
          >
            キャンセル
          </button>
          {spec.kind === "input" && (
            <button type="button" className="btn-primary" disabled={running} onClick={submitInput}>
              {spec.okLabel}
            </button>
          )}
          {spec.kind === "confirm" && (
            <button
              type="button"
              className={spec.danger ? "btn-danger" : "btn-primary"}
              disabled={running}
              onClick={() => run(spec.submit(option))}
            >
              {spec.okLabel}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
