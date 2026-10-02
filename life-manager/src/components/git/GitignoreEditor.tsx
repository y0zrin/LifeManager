import { useEffect, useRef, useState } from "react";
import * as git from "../../lib/git";
import type { GitResult } from "../../hooks/useGit";
import { isComposing, isEscape } from "../../lib/keys";

interface GitignoreEditorProps {
  folder: string;
  onSave: (text: string) => Promise<GitResult>;
  onClose: () => void;
}

// 書き方の早見表（左がパターン、右が意味）
const HELP: [string, string][] = [
  ["*.log", "拡張子が .log のファイル（どのフォルダでも）"],
  ["/build/", "いちばん上の build フォルダ（/ で始めるとその場所だけ）"],
  ["build/", "どこにある build フォルダでも"],
  ["!keep.log", "! で始めると例外（無視しない）"],
  ["# メモ", "# で始まる行はメモ"],
];

/** .gitignore（git で記録しないファイルの一覧）を、その場で書き換える */
export function GitignoreEditor({ folder, onSave, onClose }: GitignoreEditorProps) {
  // null のあいだは読み込み中
  const [text, setText] = useState<string | null>(null);
  const [original, setOriginal] = useState("");
  const [exists, setExists] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const textRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    git.readGitignore(folder).then(
      (r) => {
        if (!alive) return;
        setText(r.text);
        setOriginal(r.text);
        setExists(r.exists);
      },
      (e) => {
        if (!alive) return;
        setText("");
        setError(git.splitGitError(e).message);
      },
    );
    return () => { alive = false; };
  }, [folder]);

  const loaded = text !== null;
  useEffect(() => {
    const el = textRef.current;
    if (!loaded || !el) return;
    el.focus();
    // 書き足すことが多いので、カーソルは最後に置く
    el.setSelectionRange(el.value.length, el.value.length);
    el.scrollTop = el.scrollHeight;
  }, [loaded]);

  const dirty = loaded && text !== original;

  async function save() {
    if (text === null || saving || !dirty) return;
    setSaving(true);
    setError(null);
    const r = await onSave(text);
    setSaving(false);
    if (r.ok) onClose();
    else setError(r.message);
  }

  // Esc で閉じる。書き換えたあとは、うっかり消えないよう「キャンセル」でだけ閉じる
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (isEscape(e) && !saving && !dirty) {
        e.stopPropagation();
        onClose();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [saving, dirty, onClose]);

  return (
    <div className="palette-overlay git-dialog-back" onClick={() => { if (!saving && !dirty) onClose(); }}>
      <div className="git-dialog gi-editor" role="dialog" aria-modal="true" aria-label=".gitignore を編集" onClick={(e) => e.stopPropagation()}>
        <h3>.gitignore を編集</h3>
        <p className="git-dialog-note">
          git で記録しない（無視する）ファイルを 1 行に 1 つ書きます。
          {!exists && " まだ .gitignore はありません。保存するとリポジトリのいちばん上に作ります。"}
        </p>
        {loaded ? (
          <textarea
            ref={textRef}
            className="input-full gi-text"
            value={text}
            rows={12}
            spellCheck={false}
            placeholder={"*.log\n/build/\n.env"}
            // disabled にするとフォーカスが外れてしまうので、保存中は読み取り専用にする
            readOnly={saving}
            onChange={(e) => { setText(e.target.value); setError(null); }}
            onKeyDown={(e) => {
              // Ctrl+S で保存（変換中は除く）
              if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s" && !isComposing(e)) {
                e.preventDefault();
                save();
              }
            }}
          />
        ) : (
          <p className="git-dialog-running">読み込んでいます…</p>
        )}
        <dl className="gi-help">
          {HELP.map(([pattern, meaning]) => (
            <div key={pattern}>
              <dt><code>{pattern}</code></dt>
              <dd>{meaning}</dd>
            </div>
          ))}
        </dl>
        <p className="git-dialog-note">
          すでに git で管理しているファイルは、ここに書いても無視されません。「作業をする」の ③ でファイルを右クリックして「無視する」を選ぶと、管理から外せます（
          <code>git rm --cached</code>）。
        </p>
        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          {dirty && <span className="gi-dirty">保存していない変更があります</span>}
          <button type="button" className="btn-sm" disabled={saving} onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className="btn-primary" disabled={saving || !dirty} onClick={save}>
            {saving ? "保存しています…" : "保存"}
          </button>
        </div>
      </div>
    </div>
  );
}
