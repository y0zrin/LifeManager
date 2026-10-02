import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubUser } from "../../lib/types";
import { helpBody, type HelpContext } from "../../lib/help";
import { isEnter, isEscape } from "../../lib/keys";
import { issueRef } from "../../lib/issueRef";
import { Avatar } from "../common/Avatar";
import { keyHint } from "../../lib/platform";

interface HelpDialogProps {
  issue: { number: number; title: string };
  me: string;
  /** 呼べる人（リポジトリのメンバー） */
  collaborators: GitHubUser[];
  /** いっしょに送れるもの（ないものは出さない） */
  context: HelpContext;
  /** コメントを送る（送れたら閉じる） */
  onSend: (body: string, to: string[]) => Promise<void>;
  onClose: () => void;
}

type CtxKey = "branch" | "failure" | "conflicts";

/**
 * 🆘 助けを求める: だれに（チームの人）・困っていること・いっしょに送るもの（今のブランチ・最後に失敗した git・競合しているファイル）を選び、
 * その Issue に @ で呼ぶコメントとして残す（GitHub にも残り、あとから読める）。呼ばれた人のアプリでは、赤い 🆘 の知らせになる
 */
export function HelpDialog({ issue, me, collaborators, context, onSend, onClose }: HelpDialogProps) {
  const people = useMemo(() => collaborators.filter((c) => c.login.toLowerCase() !== me.toLowerCase()), [collaborators, me]);
  // チームがもう 1 人だけ（2 人組）なら、はじめから選んでおく
  const [to, setTo] = useState<string[]>(() => (people.length === 1 ? [people[0].login] : []));
  const [message, setMessage] = useState("");
  const [use, setUse] = useState<Record<CtxKey, boolean>>({ branch: !!context.branch, failure: !!context.failure, conflicts: !!context.conflicts?.length });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textRef.current?.focus();
  }, []);

  // Esc はこのダイアログだけを閉じる（後ろの Issue の詳細まで閉じないよう、先に受けて止める）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!isEscape(e)) return;
      e.stopPropagation();
      if (!busy) onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [busy, onClose]);

  const chosen: HelpContext = {
    branch: use.branch ? context.branch : undefined,
    failure: use.failure ? context.failure : undefined,
    conflicts: use.conflicts ? context.conflicts : undefined,
  };
  const anyContext = !!(chosen.branch || chosen.failure || chosen.conflicts?.length);
  const canSend = to.length > 0 && (message.trim().length > 0 || anyContext) && !busy;

  const toggle = (login: string) => setTo((list) => (list.includes(login) ? list.filter((l) => l !== login) : [...list, login]));

  async function send() {
    if (!canSend) return;
    setBusy(true);
    setError(null);
    try {
      await onSend(helpBody(to, message, chosen), to);
      onClose();
    } catch (e) {
      setError(`送れませんでした（${String(e)}）`);
      setBusy(false);
    }
  }

  const firstLine = message.trim().split("\n")[0] ?? "";
  const failureHead = context.failure?.message.split("\n").find((l) => l.trim())?.trim() ?? "";

  return (
    <div className="palette-overlay git-dialog-back help-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog help-dialog" role="dialog" aria-modal="true" aria-label="助けを求める" onClick={(e) => e.stopPropagation()}>
        <h3>🆘 助けを求める</h3>
        <p className="git-dialog-note">
          {issueRef(issue.number)} {issue.title} に、呼んだ人あてのコメントとして残します（GitHub にも残ります）。呼ばれた人のアプリには赤い 🆘 の知らせが出ます
        </p>

        <div className="help-label">だれに</div>
        {people.length === 0 ? (
          <p className="git-dialog-note">このリポジトリにはほかのメンバーがいません（設定 → 接続 で招待できます）</p>
        ) : (
          <div className="help-who" role="group" aria-label="だれに">
            {people.map((p) => (
              <button key={p.login} type="button" className={`help-person${to.includes(p.login) ? " on" : ""}`} aria-pressed={to.includes(p.login)} onClick={() => toggle(p.login)} disabled={busy}>
                <Avatar login={p.login} url={p.avatar_url} className="avatar-sm" />
                {p.login}
              </button>
            ))}
          </div>
        )}

        <label className="help-label" htmlFor="help-message">困っていること</label>
        <textarea
          id="help-message"
          ref={textRef}
          className="textarea-full help-message"
          value={message}
          readOnly={busy}
          placeholder={`例: プッシュしようとしたら rejected と出て進めません${keyHint("（Ctrl+Enter で送る）")}`}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && (e.ctrlKey || e.metaKey)) send();
          }}
        />

        <div className="help-label">いっしょに送るもの</div>
        <div className="help-ctx-opts">
          <label className={`chk${context.branch ? "" : " off"}`}>
            <input type="checkbox" checked={use.branch} disabled={!context.branch || busy} onChange={(e) => setUse({ ...use, branch: e.target.checked })} />
            {context.branch ? (
              <span>
                今のブランチ <code>{context.branch.name}</code>・作業中の変更 {context.branch.changes}
              </span>
            ) : (
              <span>
                今のブランチ <small>（この PC の作業フォルダがありません）</small>
              </span>
            )}
          </label>
          <label className={`chk${context.failure ? "" : " off"}`}>
            <input type="checkbox" checked={use.failure} disabled={!context.failure || busy} onChange={(e) => setUse({ ...use, failure: e.target.checked })} />
            {context.failure ? (
              <span>
                最後に失敗した git: <code>{context.failure.command}</code>
                {failureHead && <small> → {failureHead}</small>}
              </span>
            ) : (
              <span>
                最後に失敗した git <small>（この 30 分はありません）</small>
              </span>
            )}
          </label>
          <label className={`chk${context.conflicts?.length ? "" : " off"}`}>
            <input type="checkbox" checked={use.conflicts} disabled={!context.conflicts?.length || busy} onChange={(e) => setUse({ ...use, conflicts: e.target.checked })} />
            {context.conflicts?.length ? (
              <span>
                競合しているファイル{" "}
                {context.conflicts.map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </span>
            ) : (
              <span>
                競合しているファイル <small>（今はありません）</small>
              </span>
            )}
          </label>
        </div>

        <div className="help-preview">
          送るコメント: <b>🆘 助けてください</b> {to.length > 0 ? to.map((l) => `@${l}`).join(" ") : <em>（だれかを選んでください）</em>}
          {firstLine && <> ／ {firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine}</>}
          {anyContext && <> ／ ▸ いっしょに送るもの</>}
        </div>

        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          <button type="button" className="btn-sm" onClick={onClose} disabled={busy}>
            やめる
          </button>
          <button type="button" className="btn-help" onClick={send} disabled={!canSend}>
            {busy ? "送っています…" : "🆘 送る"}
          </button>
        </div>
      </div>
    </div>
  );
}
