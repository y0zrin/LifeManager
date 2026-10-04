import { useEffect, useMemo, useRef, useState } from "react";
import type { GitHubUser } from "../../lib/types";
import { helpBody, type HelpContext } from "../../lib/help";
import { isEnter, isEscape } from "../../lib/keys";
import { issueRef } from "../../lib/issueRef";
import { Avatar } from "../common/Avatar";
import { keyHint } from "../../lib/platform";
import { tr, trx } from "../../lib/i18n";

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
      setError(tr("送れませんでした（{String}）", { String: String(e) }));
      setBusy(false);
    }
  }

  const firstLine = message.trim().split("\n")[0] ?? "";
  const failureHead = context.failure?.message.split("\n").find((l) => l.trim())?.trim() ?? "";

  return (
    <div className="palette-overlay git-dialog-back help-back" onClick={() => !busy && onClose()}>
      <div className="git-dialog help-dialog" role="dialog" aria-modal="true" aria-label={tr("助けを求める")} onClick={(e) => e.stopPropagation()}>
        <h3>{tr("🆘 助けを求める")}</h3>
        <p className="git-dialog-note">
          {trx("{issueRef} {title} に、呼んだ人あてのコメントとして残します（GitHub にも残ります）。呼ばれた人のアプリには赤い 🆘 の知らせが出ます", { issueRef: issueRef(issue.number), title: issue.title })}
        </p>

        <div className="help-label">{tr("だれに")}</div>
        {people.length === 0 ? (
          <p className="git-dialog-note">{tr("このリポジトリにはほかのメンバーがいません（設定 → 接続 で招待できます）")}</p>
        ) : (
          <div className="help-who" role="group" aria-label={tr("だれに")}>
            {people.map((p) => (
              <button key={p.login} type="button" className={`help-person${to.includes(p.login) ? " on" : ""}`} aria-pressed={to.includes(p.login)} onClick={() => toggle(p.login)} disabled={busy}>
                <Avatar login={p.login} url={p.avatar_url} className="avatar-sm" />
                {p.login}
              </button>
            ))}
          </div>
        )}

        <label className="help-label" htmlFor="help-message">{tr("困っていること")}</label>
        <textarea
          id="help-message"
          ref={textRef}
          className="textarea-full help-message"
          value={message}
          readOnly={busy}
          placeholder={tr("例: プッシュしようとしたら rejected と出て進めません{keyHint}", { keyHint: keyHint(tr("（Ctrl+Enter で送る）")) })}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (isEnter(e) && (e.ctrlKey || e.metaKey)) send();
          }}
        />

        <div className="help-label">{tr("いっしょに送るもの")}</div>
        <div className="help-ctx-opts">
          <label className={`chk${context.branch ? "" : " off"}`}>
            <input type="checkbox" checked={use.branch} disabled={!context.branch || busy} onChange={(e) => setUse({ ...use, branch: e.target.checked })} />
            {context.branch ? (
              <span>
                {trx("今のブランチ <0>{name}</0>・作業中の変更 {changes}", { name: context.branch.name, changes: context.branch.changes }, [<code />])}
              </span>
            ) : (
              <span>
                {trx("今のブランチ <0>（この PC の作業フォルダがありません）</0>", undefined, [<small />])}
              </span>
            )}
          </label>
          <label className={`chk${context.failure ? "" : " off"}`}>
            <input type="checkbox" checked={use.failure} disabled={!context.failure || busy} onChange={(e) => setUse({ ...use, failure: e.target.checked })} />
            {context.failure ? (
              <span>
                {trx("最後に失敗した git: <0>{command}</0>", { command: context.failure.command }, [<code />])}
                {failureHead && <small> → {failureHead}</small>}
              </span>
            ) : (
              <span>
                {trx("最後に失敗した git <0>（この 30 分はありません）</0>", undefined, [<small />])}
              </span>
            )}
          </label>
          <label className={`chk${context.conflicts?.length ? "" : " off"}`}>
            <input type="checkbox" checked={use.conflicts} disabled={!context.conflicts?.length || busy} onChange={(e) => setUse({ ...use, conflicts: e.target.checked })} />
            {context.conflicts?.length ? (
              <span>
                {tr("競合しているファイル")}{" "}
                {context.conflicts.map((f) => (
                  <code key={f}>{f}</code>
                ))}
              </span>
            ) : (
              <span>
                {trx("競合しているファイル <0>（今はありません）</0>", undefined, [<small />])}
              </span>
            )}
          </label>
        </div>

        <div className="help-preview">
          {trx("送るコメント: <0>🆘 助けてください</0>", undefined, [<b />])}{" "} {to.length > 0 ? to.map((l) => `@${l}`).join(" ") : <em>{tr("（だれかを選んでください）")}</em>}
          {firstLine && <> ／ {firstLine.length > 40 ? `${firstLine.slice(0, 40)}…` : firstLine}</>}
          {anyContext && <> {" "}{tr("／ ▸ いっしょに送るもの")}</>}
        </div>

        {error && <p className="git-dialog-error">{error}</p>}
        <div className="git-dialog-actions">
          <button type="button" className="btn-sm" onClick={onClose} disabled={busy}>
            {tr("やめる")}
          </button>
          <button type="button" className="btn-help" onClick={send} disabled={!canSend}>
            {busy ? tr("送っています…") : tr("🆘 送る")}
          </button>
        </div>
      </div>
    </div>
  );
}
