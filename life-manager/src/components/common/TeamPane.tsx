import { useCallback, useEffect, useState } from "react";
import {
  cancelInvitation, daysLeft, INVITATION_DAYS, INVITE_PERMISSIONS, inviteMember, parseNames, ROLE_LABELS, teamOverview,
  type InviteOutcome, type RepoInvitation, type TeamOverview,
} from "../../lib/team";
import { InvitesForMe } from "./InvitesForMe";

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
  return days <= 0 ? "今日" : days === 1 ? "昨日" : `${days} 日前`;
}

/** 招待の結果の 1 行 */
function resultText({ name, outcome }: Result): { mark: string; tone: string; text: string } {
  switch (outcome.status) {
    case "invited":
      return { mark: "✔", tone: "ok", text: `${name} — 招待しました（メールと、Life Manager の「あなた宛ての招待」に届きます）` };
    case "already":
      return { mark: "―", tone: "warn", text: `${name} — もうこのリポジトリを使えます` };
    case "no_user":
      return { mark: "✖", tone: "bad", text: `${name} — その名前の人は GitHub にいません（綴りを確かめてください）` };
    default:
      return { mark: "✖", tone: "bad", text: `${name} — ${outcome.message ?? "招待できませんでした"}` };
  }
}

/**
 * 設定 → チーム。自分宛ての招待（参加する）、今のリポジトリへの招待（管理者だけ。名前をまとめて貼って送る）、
 * 送った招待（取り消す・送り直す）、メンバーの一覧。メンバーを外すのは GitHub の画面で（間違えて外さないように）
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
    `Life Manager で「${owner}/${repo}」を使います。`,
    `① アプリを入れる：${DOWNLOAD_URL}`,
    "② アプリを開いて「GitHub でログイン」（アカウントがなければ「GitHub で作る」）",
    `③ 画面に出る「あなたの GitHub の名前」を、${login} に伝える`,
    "④ 招待が届くとアプリに出るので「参加してはじめる」を押す",
    "　（GitHub から届く招待のメールは、開かなくてかまいません）",
  ].join("\n");

  async function send() {
    if (parsed.names.length === 0 || sending) return;
    const done: Result[] = [];
    for (let i = 0; i < parsed.names.length; i++) {
      const name = parsed.names[i];
      setSending(`${i + 1} / ${parsed.names.length} 人目…`);
      try {
        done.push({ name, outcome: await inviteMember(owner, repo, name, overview?.organization ? permission : null) });
      } catch (e) {
        done.push({ name, outcome: { status: "failed", message: String(e) } });
      }
    }
    const invalid: Result[] = parsed.invalid.map((name) => ({ name, outcome: { status: "invalid", message: "GitHub の名前に使えない文字があります（英数字とハイフンだけ）" } }));
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

  const invitations = [...(overview?.invitations ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at));

  return (
    <div className="team-pane">
      <div className="form-card team-card">
        <h3 className="team-h">
          あなた宛ての招待 <small>リーダーがこのアプリから送った招待も、GitHub から送った招待も、ここに届きます</small>
        </h3>
        <InvitesForMe empty={<p className="team-note">今は届いていません。</p>} />
      </div>

      {!owner || !repo ? (
        <p className="team-note">プロジェクト（リポジトリ）を選ぶと、ここでメンバーを招待できます。</p>
      ) : error ? (
        <p className="token-error">{owner}/{repo} のメンバーを読めませんでした（{error}）</p>
      ) : !overview ? (
        <p className="team-note"><i className="spinner" aria-hidden="true" /> {owner}/{repo} のメンバーを読んでいます…</p>
      ) : (
        <>
          {overview.admin ? (
            <div className="form-card team-card">
              <h3 className="team-h">
                {owner}/{repo} に招待する <small>あなたはこのリポジトリの管理者です</small>
              </h3>
              {overview.invitations_error && <p className="token-error team-error">{overview.invitations_error}</p>}
              <div className="team-guide">
                <div className="team-guide-head">
                  <b>メンバーに送る「参加の案内」</b>
                  <button type="button" className="btn-sm" onClick={() => copy(joinGuide, "guide")}>
                    {copied === "guide" ? "✔ コピーしました" : "案内をコピー"}
                  </button>
                </div>
                <pre className="team-guide-text">{joinGuide}</pre>
                <p className="team-note">チャット・メール・授業のページなどに貼ります。届いた名前を、下に貼って招待します。</p>
              </div>
              <textarea
                className="team-names"
                value={text}
                placeholder={"メンバーから届いた GitHub の名前を貼る（何人でも）\n例: sato-taro, baba-yui"}
                onChange={(e) => setText(e.target.value)}
                disabled={sending !== null}
              />
              <div className="team-form">
                <span className="team-note">
                  改行・カンマ・空白で区切れます
                  {parsed.names.length > 0 && <>（{parsed.names.length} 人{parsed.invalid.length > 0 && `・名前に使えない文字 ${parsed.invalid.length} 件`}）</>}
                </span>
                <span className="team-form-right">
                  {overview.organization ? (
                    <label className="team-note">
                      権限{" "}
                      <select className="select-sm" value={permission} onChange={(e) => setPermission(e.target.value)} disabled={sending !== null}>
                        {INVITE_PERMISSIONS.map((p) => (
                          <option key={p.value} value={p.value}>{p.label}</option>
                        ))}
                      </select>
                    </label>
                  ) : (
                    <span className="team-note" title="個人のリポジトリでは、招待した人はみな書き込みの権限になります">権限: 書き込み</span>
                  )}
                  <button type="button" className="btn-primary" disabled={parsed.names.length === 0 || sending !== null} onClick={send}>
                    {sending ?? "招待を送る"}
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
              <div className="team-cmd">GitHub に送る内容: PUT /repos/{owner}/{repo}/collaborators/名前（1 人ずつ）</div>
            </div>
          ) : (
            <div className="form-card team-card">
              <h3 className="team-h">{owner}/{repo} に招待する</h3>
              <p className="team-note">
                招待できるのは、このリポジトリの管理者だけです。チームに入れてほしい人は、リーダーに GitHub の名前を伝えてもらいます。あなたの名前:{" "}
                <b>{login}</b>{" "}
                <button type="button" className="btn-sm" onClick={() => copy(login, "me")}>{copied === "me" ? "コピーしました" : "コピー"}</button>
              </p>
            </div>
          )}

          <div className="team-two">
            {overview.admin && (
              <div className="form-card team-card">
                <h3 className="team-h">
                  送った招待 <small>まだ受けていない（{INVITATION_DAYS} 日で切れます）</small>
                </h3>
                {overview.invitations_error ? (
                  <p className="team-note">読めませんでした（上の「招待する」の欄を見てください）。</p>
                ) : (
                  invitations.length === 0 && <p className="team-note">ありません。</p>
                )}
                {invitations.map((inv) => {
                  const left = daysLeft(inv.created_at);
                  const expired = inv.expired || left <= 0;
                  return (
                    <div key={inv.id} className="team-row">
                      {inv.invitee?.avatar_url && <img src={inv.invitee.avatar_url} alt="" />}
                      <span className="team-row-main">
                        {inv.invitee?.login ?? "（名前なし）"}{" "}
                        <small className={expired ? "team-expired" : ""}>— {expired ? "切れました" : `${ago(inv.created_at)}・あと ${left} 日`}</small>
                      </span>
                      {expired ? (
                        <button type="button" className="btn-sm" disabled={busyId !== null} onClick={() => resend(inv)}>送り直す</button>
                      ) : (
                        <>
                          <button type="button" className="link-button" onClick={() => copy(inv.html_url, `link-${inv.id}`)}
                            title="招待を受けるページの URL（チャットで送る用）">
                            {copied === `link-${inv.id}` ? "コピーしました" : "リンクをコピー"}
                          </button>
                          <button type="button" className="btn-sm" disabled={busyId !== null} onClick={() => cancel(inv)}>取り消す</button>
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
                  メンバー <small>このリポジトリを使える人</small>
                </h3>
                {overview.members_error && <p className="token-error">{overview.members_error}</p>}
                {overview.members.map((m) => (
                  <div key={m.login} className="team-row">
                    {m.avatar_url && <img src={m.avatar_url} alt="" />}
                    <span className="team-row-main">
                      {m.login}
                      {m.login === login && <small>（あなた）</small>}
                    </span>
                    {m.role_name && <span className="team-role">{ROLE_LABELS[m.role_name] ?? m.role_name}</span>}
                  </div>
                ))}
                <p className="team-note">外すのは GitHub の画面（リポジトリの Settings → Collaborators）で行います。間違えて外さないよう、このアプリからは外しません。</p>
              </div>
            )}
          </div>
          <p className="team-note">組織そのものへの招待（組織のメンバーにする）は、GitHub の組織の画面（People）で行います。</p>
        </>
      )}
    </div>
  );
}
