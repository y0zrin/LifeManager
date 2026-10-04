import { useCallback, useEffect, useState } from "react";
import {
  cancelInvitation, daysLeft, INVITATION_DAYS, INVITE_PERMISSIONS, inviteMember, parseNames, removeMember, ROLE_LABELS, teamOverview,
  type InviteOutcome, type RepoInvitation, type TeamOverview,
} from "../../lib/team";
import { InvitesForMe } from "./InvitesForMe";
import { tr, trx } from "../../lib/i18n";

/** アプリのダウンロード先（参加の案内に書く） */
const DOWNLOAD_URL = "https://github.com/y0zrin/LifeManager/releases/latest";

interface TeamPaneProps {
  /** 今のプロジェクト（リポジトリ） */
  owner: string;
  repo: string;
  /** ログインしている人 */
  login: string;
}

type Result = { name: string; outcome: InviteOutcome };

function ago(iso: string): string {
  const days = Math.floor((Date.now() - Date.parse(iso)) / 86400000);
  return days <= 0 ? tr("今日") : days === 1 ? tr("昨日") : tr("{days} 日前", { days });
}

/** 招待の結果の 1 行 */
function resultText({ name, outcome }: Result): { mark: string; tone: string; text: string } {
  switch (outcome.status) {
    case "invited":
      return { mark: "✔", tone: "ok", text: tr("{name} — 招待しました。GitHub からメールで届きます。メンバーはメールの View invitation から参加します", { name }) };
    case "already":
      return { mark: "―", tone: "warn", text: tr("{name} — もうこのリポジトリを使えます", { name }) };
    case "no_user":
      return { mark: "✖", tone: "bad", text: tr("{name} — その名前の人は GitHub にいません（綴りを確かめてください）", { name }) };
    default:
      return { mark: "✖", tone: "bad", text: `${name} — ${outcome.message ?? tr("招待できませんでした")}` };
  }
}

/**
 * 設定 → 接続。自分宛ての招待（参加する）、今のリポジトリへの招待（管理者だけ。名前をまとめて貼って送る）、
 * 送った招待（取り消す・送り直す）、メンバーの一覧（管理者は、その行で確かめてから外せる）
 */
export function TeamPane({ owner, repo, login }: TeamPaneProps) {
  const [overview, setOverview] = useState<TeamOverview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [text, setText] = useState("");
  const [permission, setPermission] = useState("push");
  const [sending, setSending] = useState<string | null>(null);
  const [results, setResults] = useState<Result[]>([]);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // メンバーを外す: 確かめている人・外しているところ・外した結果（組織のメンバーとしてまだ使えるか）
  const [removing, setRemoving] = useState<string | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [removed, setRemoved] = useState<{ login: string; still: boolean } | null>(null);
  const [removeError, setRemoveError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!owner || !repo) return;
    try {
      setOverview(await teamOverview(owner, repo));
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [owner, repo]);

  useEffect(() => {
    setOverview(null);
    setResults([]);
    setRemoving(null);
    setRemoved(null);
    setRemoveError(null);
    load();
  }, [load]);

  async function copy(value: string, key: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(key);
      setTimeout(() => setCopied((c) => (c === key ? null : c)), 1500);
    } catch {
      // コピーできなくても、画面には出ている
    }
  }

  const parsed = parseNames(text);

  // メンバーに送る「参加の案内」（チャット・メール・授業のページなどに貼る）
  const joinGuide = [
    tr("Life Manager で「{owner}/{repo}」を使います。", { owner, repo }),
    tr("① アプリを入れる：{DOWNLOAD_URL}", { DOWNLOAD_URL }),
    tr("② アプリを開いて「GitHub でログイン」→「招待を受ける」（アカウントがなければ「GitHub で作る」）"),
    tr("③ 画面に出る「あなたの GitHub の名前」を {login} に伝える", { login }),
    tr("④ 招待のメールが届いたら「View invitation」→「Accept invitation」"),
    tr("　（このリンクからも受けられます：https://github.com/{owner}/{repo}/invitations）", { owner, repo }),
    tr("⑤ アプリが気づくので「このリポジトリではじめる」"),
  ].join("\n");

  async function send() {
    if (parsed.names.length === 0 || sending) return;
    const done: Result[] = [];
    for (let i = 0; i < parsed.names.length; i++) {
      const name = parsed.names[i];
      setSending(tr("{v} / {length} 人目…", { v: i + 1, length: parsed.names.length }));
      try {
        done.push({ name, outcome: await inviteMember(owner, repo, name, overview?.organization ? permission : null) });
      } catch (e) {
        done.push({ name, outcome: { status: "failed", message: String(e) } });
      }
    }
    const invalid: Result[] = parsed.invalid.map((name) => ({ name, outcome: { status: "invalid", message: tr("GitHub の名前に使えない文字があります（英数字とハイフンだけ）") } }));
    setResults([...invalid, ...done]);
    setSending(null);
    // 招待できた名前は欄から消し、できなかった名前は直して送り直せるよう残す
    const left = [...parsed.invalid, ...done.filter((r) => r.outcome.status !== "invited" && r.outcome.status !== "already").map((r) => r.name)];
    setText(left.join("\n"));
    load();
  }

  async function cancel(inv: RepoInvitation) {
    setBusyId(inv.id);
    try {
      await cancelInvitation(owner, repo, inv.id);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  /** 切れた招待を送り直す（古い招待を消してから、同じ人をもう一度招待する） */
  async function resend(inv: RepoInvitation) {
    if (!inv.invitee) return;
    setBusyId(inv.id);
    try {
      await cancelInvitation(owner, repo, inv.id);
      const outcome = await inviteMember(owner, repo, inv.invitee.login, overview?.organization ? permission : null);
      setResults([{ name: inv.invitee.login, outcome }]);
      await load();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusyId(null);
    }
  }

  /** メンバーを外す（確かめたあと）。組織のリポジトリでは、組織のメンバーとしてまだ使える人は一覧に残る */
  async function remove(name: string) {
    setRemoveBusy(true);
    setRemoveError(null);
    try {
      await removeMember(owner, repo, name);
      const next = await teamOverview(owner, repo);
      const same = (m: { login: string }) => m.login.toLowerCase() === name.toLowerCase();
      const still = next.organization && next.members.some(same);
      // 個人のリポジトリは、GitHub の一覧に残っていても（反映が遅れても）外したものとして出す
      setOverview(still ? next : { ...next, members: next.members.filter((m) => !same(m)) });
      setRemoved({ login: name, still });
      setRemoving(null);
    } catch (e) {
      setRemoveError(String(e));
    } finally {
      setRemoveBusy(false);
    }
  }

  const invitations = [...(overview?.invitations ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="team-pane">

      {!owner || !repo ? (
        <p className="team-note">{tr("プロジェクト（リポジトリ）を選ぶと、ここでメンバーを招待できます。")}</p>
      ) : error ? (
        <p className="token-error">{trx("{owner}/{repo} のメンバーを読めませんでした（{error}）", { owner, repo, error })}</p>
      ) : !overview ? (
        <p className="team-note"><i className="spinner" aria-hidden="true" /> {" "}{trx("{owner}/{repo} のメンバーを読んでいます…", { owner, repo })}</p>
      ) : (
        <>
          {overview.admin ? (
            <div className="form-card team-card">
              <h3 className="team-h">
                {trx("{owner}/{repo} に招待する <0>あなたはこのリポジトリの管理者です</0>", { owner, repo }, [<small />])}
              </h3>
              {overview.invitations_error && <p className="token-error team-error">{overview.invitations_error}</p>}
              <div className="team-guide">
                <div className="team-guide-head">
                  <b>{tr("メンバーに送る「参加の案内」")}</b>
                  <button type="button" className="btn-sm" onClick={() => copy(joinGuide, "guide")}>
                    {copied === "guide" ? tr("✔ コピーしました") : tr("案内をコピー")}
                  </button>
                </div>
                <pre className="team-guide-text">{joinGuide}</pre>
                <p className="team-note">{tr("チャット、メール、授業のページなどに貼ります。届いた名前を下に貼って招待します。")}</p>
              </div>
              <textarea
                className="team-names"
                value={text}
                placeholder={tr("メンバーから届いた GitHub の名前を貼る（何人でも）\n例: sato-taro, baba-yui")}
                onChange={(e) => setText(e.target.value)}
                disabled={sending !== null}
              />
              <div className="team-form">
                <span className="team-note">
                  {tr("改行、カンマ、空白で区切れます")}
                  {parsed.names.length > 0 &&
                    (parsed.invalid.length > 0
                      ? tr("（{n} 人・名前に使えない文字 {bad} 件）", { n: parsed.names.length, bad: parsed.invalid.length })
                      : tr("（{n} 人）", { n: parsed.names.length }))}
                </span>
                <span className="team-form-right">
                  {overview.organization ? (
                    <label className="team-note">
                      {tr("権限")}{" "}
                      <select className="select-sm" value={permission} onChange={(e) => setPermission(e.target.value)} disabled={sending !== null}>
                        {INVITE_PERMISSIONS.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <span className="team-note" title={tr("個人のリポジトリでは招待した人はみな書き込みの権限になります")}>{tr("権限: 書き込み")}</span>
                  )}
                  <button type="button" className="btn-primary" disabled={parsed.names.length === 0 || sending !== null} onClick={send}>
                    {sending ?? tr("招待を送る")}
                  </button>
                </span>
              </div>
              {results.length > 0 && (
                <ul className="team-results">
                  {results.map((r) => {
                    const t = resultText(r);
                    return (
                      <li key={r.name} className={`team-result team-result--${t.tone}`}>
                        {t.mark} {t.text}
                      </li>
                    );
                  })}
                </ul>
              )}
              <div className="team-cmd">{trx("GitHub に送る内容: PUT /repos/{owner}/{repo}/collaborators/名前（1 人ずつ）", { owner, repo })}</div>
            </div>
          ) : (
            <div className="form-card team-card">
              <h3 className="team-h">{trx("{owner}/{repo} に招待する", { owner, repo })}</h3>
              <p className="team-note">
                {trx("招待できるのはこのリポジトリの管理者だけです。チームに入れてほしい人は、リーダーに GitHub の名前を伝えてもらいます。あなたの名前: <0>{login}</0>", { login }, [<b />])}{" "}
                <button type="button" className="btn-sm" onClick={() => copy(login, "me")}>{copied === "me" ? tr("コピーしました") : tr("コピー")}</button>
              </p>
            </div>
          )}

          <div className="team-two">
            {overview.admin && (
              <div className="form-card team-card">
                <h3 className="team-h">
                  {trx("送った招待 <0>まだ受けていない（{INVITATION_DAYS} 日で切れます）</0>", { INVITATION_DAYS }, [<small />])}
                </h3>
                {overview.invitations_error ? (
                  <p className="team-note">{tr("読めませんでした（上の「招待する」の欄を見てください）。")}</p>
                ) : (
                  invitations.length === 0 && <p className="team-note">{tr("ありません。")}</p>
                )}
                {invitations.map((inv) => {
                  const left = daysLeft(inv.created_at);
                  const expired = inv.expired || left <= 0;
                  return (
                    <div key={inv.id} className="team-row">
                      {inv.invitee?.avatar_url && <img src={inv.invitee.avatar_url} alt="" />}
                      <span className="team-row-main">
                        {inv.invitee?.login ?? tr("（名前なし）")}{" "}
                        <small className={expired ? "team-expired" : ""}>— {expired ? tr("切れました") : tr("{ago}・あと {left} 日", { ago: ago(inv.created_at), left })}</small>
                      </span>
                      {expired ? (
                        <button type="button" className="btn-sm" disabled={busyId !== null} onClick={() => resend(inv)}>{tr("送り直す")}</button>
                      ) : (
                        <>
                          <button type="button" className="link-button" onClick={() => copy(inv.html_url, `link-${inv.id}`)}
                            title={tr("招待を受けるページの URL（チャットで送る用）")}>
                            {copied === `link-${inv.id}` ? tr("コピーしました") : tr("リンクをコピー")}
                          </button>
                          <button type="button" className="btn-sm" disabled={busyId !== null} onClick={() => cancel(inv)}>{tr("取り消す")}</button>
                        </>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {overview.push && (
              <div className="form-card team-card">
                <h3 className="team-h">
                  {trx("メンバー <0>このリポジトリを使える人</0>", undefined, [<small />])}
                </h3>
                {overview.members_error && <p className="token-error">{overview.members_error}</p>}
                {overview.members.map((m) => {
                  // 外せるのは管理者だけ。持ち主と自分は外さない
                  const canRemove = overview.admin && m.login.toLowerCase() !== login.toLowerCase() && m.login.toLowerCase() !== owner.toLowerCase();
                  return (
                    <div key={m.login} className="team-row">
                      {m.avatar_url && <img src={m.avatar_url} alt="" />}
                      <span className="team-row-main">
                        {m.login}
                        {m.login === login && <small>{tr("（あなた）")}</small>}
                      </span>
                      {m.role_name && <span className="team-role">{ROLE_LABELS[m.role_name] ?? m.role_name}</span>}
                      {canRemove && removing !== m.login && (
                        <button type="button" className="btn-sm team-remove" disabled={removeBusy}
                          onClick={() => { setRemoving(m.login); setRemoved(null); setRemoveError(null); }}>
                          {tr("外す")}
                        </button>
                      )}
                      {removing === m.login && (
                        <div className="team-confirm">
                          {trx("<0>{login} を {owner}/{repo} から外しますか？</0><1>このリポジトリを使えなくなります（非公開なら見ることもできません）。もう一度招待すれば戻せます。</1>", { login: m.login, owner, repo }, [<b />, <span className="team-note" />])}
                          <span className="team-confirm-actions">
                            <button type="button" className="btn-danger" disabled={removeBusy} onClick={() => remove(m.login)}>
                              {removeBusy ? tr("外しています…") : tr("外す")}
                            </button>
                            <button type="button" className="btn-sm" disabled={removeBusy} onClick={() => setRemoving(null)}>{tr("やめる")}</button>
                          </span>
                        </div>
                      )}
                    </div>
                  );
                })}
                {removed && (
                  <p className={`team-removed ${removed.still ? "team-result--warn" : "team-result--ok"}`}>
                    {removed.still
                      ? tr("― {login} を外しましたが、組織のメンバーとしてまだ使えます（組織の画面の People・Teams で外します）", { login: removed.login })
                      : tr("✔ {login} を外しました", { login: removed.login })}
                  </p>
                )}
                {removeError && <p className="token-error">{removeError}</p>}
                <p className="team-note">
                  {overview.admin
                    ? tr("外した人はこのリポジトリを使えなくなります（書いた Issue やコメントは残ります）。もう一度招待すれば戻せます。")
                    : tr("メンバーを外せるのはこのリポジトリの管理者です。")}
                </p>
                {overview.admin && <div className="team-cmd">{trx("GitHub に送る内容: DELETE /repos/{owner}/{repo}/collaborators/名前", { owner, repo })}</div>}
              </div>
            )}
          </div>
          <p className="team-note">{tr("組織そのものへの招待（組織のメンバーにする）は、GitHub の組織の画面（People）で行います。")}</p>
        </>
      )}

      {/* あなた宛ての招待（トークンで入ったときなど。GitHub でログインでは、参加する前の招待はここに出ない） */}
      <div className="form-card team-card">
        <h3 className="team-h">
          {trx("あなた宛ての招待 <0>招待は GitHub から届くメールの「View invitation」で受けます</0>", undefined, [<small />])}
        </h3>
        <InvitesForMe empty={<p className="team-note">{tr("「GitHub でログイン」では、まだ参加していないリポジトリの招待は、ここには出ません（GitHub の決まり）。")}</p>} />
      </div>
    </div>
  );
}
