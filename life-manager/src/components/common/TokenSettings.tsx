import { useCallback, useEffect, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { Project } from "../../lib/types";
import {
  authClientId,
  authInstallUrl,
  checkToken,
  listInstallations,
  clearProjectToken,
  expiryOf,
  EXPIRY_WARN_DAYS,
  KIND_LABELS,
  setDefaultToken,
  setProjectToken,
  SIGNED_OUT_STORE,
  tokenOverview,
  type Installation,
  type TokenOverview,
  type TokenReport,
} from "../../lib/auth";
import { isEscape } from "../../lib/keys";
import { GitHubLogin } from "./GitHubLogin";
import { RepoAccess } from "./RepoAccess";
import { TokenEntry } from "./TokenEntry";
import { TokenReportView } from "./TokenReportView";

interface TokenSettingsProps {
  projects: Project[];
  /** トークンを変えたあと（今のプロジェクトを読み直す） */
  onChanged: () => Promise<void>;
  onSignOut: () => Promise<void>;
}

type Check = { loading: boolean; report?: TokenReport; error?: string };
type Dialog = { kind: "login" } | { kind: "default" } | { kind: "project"; owner: string; repo: string; name: string };

const keyOf = (owner: string, repo: string) => `${owner}/${repo}`;
const onTop = (node: ReactNode) => createPortal(node, document.querySelector("main.app") ?? document.body);

/** 確かめた結果を、ひとことの状態にする */
function statusOf(check: Check | undefined, repoIndex = 0): { tone: "ok" | "warn" | "ng" | "wait"; text: string } {
  if (!check || check.loading) return { tone: "wait", text: "確かめています…" };
  if (check.error) return { tone: "ng", text: check.error };
  const report = check.report!;
  const expiry = expiryOf(report);
  if (expiry && expiry.days < 0) return { tone: "ng", text: "期限が切れています" };
  const repo = report.repos[repoIndex];
  if (repo && !repo.ok) return { tone: "ng", text: repo.problem === "not_found" ? "このリポジトリが見えません" : repo.problem === "org_restricted" ? "組織の許可がまだです" : "使えません" };
  if (expiry && expiry.days <= EXPIRY_WARN_DAYS) return { tone: "warn", text: `あと ${expiry.days} 日で期限` };
  if (repo?.message) return { tone: "warn", text: "見るだけ（書き込めません）" };
  return { tone: "ok", text: "使える" };
}

const ICON = { ok: "🟢", warn: "🟡", ng: "🔴", wait: "⚪" };

/**
 * 設定 → 接続 の「GitHub トークン」。いつものトークン（だれ・種類・期限）と、プロジェクトごとにどのトークンを使っていて使えるかを 1 か所で見せ、
 * 入れ替える（GitHub でログインし直す・トークンを入れる）、プロジェクト専用にする・いつものに戻す、ログアウトができる
 */
export function TokenSettings({ projects, onChanged, onSignOut }: TokenSettingsProps) {
  const [clientId, setClientId] = useState("");
  const [installUrl, setInstallUrl] = useState("");
  const [installations, setInstallations] = useState<Installation[] | null>(null);
  const [overview, setOverview] = useState<TokenOverview | null>(null);
  const [mine, setMine] = useState<Check>({ loading: true });
  const [checks, setChecks] = useState<Record<string, Check>>({});
  const [open, setOpen] = useState<string | null>(null);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirmOut, setConfirmOut] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [checkedAt, setCheckedAt] = useState<Date | null>(null);

  useEffect(() => {
    authClientId().then(setClientId).catch(() => {});
    authInstallUrl().then(setInstallUrl).catch(() => {});
  }, []);

  const projectKey = projects.map((p) => keyOf(p.owner, p.repo)).join(",");
  const refresh = useCallback(async () => {
    const ov = await tokenOverview().catch(() => null);
    setOverview(ov);
    setMine({ loading: true });
    if (ov?.has_default) {
      checkToken({ repos: [] })
        .then((report) => setMine({ loading: false, report }))
        .catch((e) => setMine({ loading: false, error: String(e) }));
    } else {
      setMine({ loading: false });
    }
    // プロジェクトごとに、そのプロジェクトで使うトークンで確かめる（順に）
    setChecks({});
    for (const p of projects) {
      const key = keyOf(p.owner, p.repo);
      setChecks((c) => ({ ...c, [key]: { loading: true } }));
      try {
        const report = await checkToken({ owner: p.owner, repo: p.repo, repos: [{ owner: p.owner, repo: p.repo }] });
        setChecks((c) => ({ ...c, [key]: { loading: false, report } }));
      } catch (e) {
        setChecks((c) => ({ ...c, [key]: { loading: false, error: String(e) } }));
      }
    }
    setCheckedAt(new Date());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectKey]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // ダイアログは Esc で閉じる
  useEffect(() => {
    if (!dialog) return;
    const onKey = (e: KeyboardEvent) => isEscape(e) && setDialog(null);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [dialog]);

  async function changed(text: string) {
    setDialog(null);
    setMessage(text);
    await onChanged();
    await refresh();
  }

  const sourceOf = (owner: string, repo: string) => overview?.projects.find((p) => p.owner === owner && p.repo === repo)?.source ?? "none";
  const myStatus = statusOf(mine, -1);
  const expiry = mine.report ? expiryOf(mine.report) : null;
  // 「GitHub でログイン」（選んだリポジトリだけ・鍵は 8 時間ごとに新しくなる）
  const byLogin = mine.report?.kind === "app";

  // Life Manager App を入れてある先（初回は「使用するリポジトリを選ぶ」、あれば「リポジトリを追加する」）
  const loadInstallations = useCallback(async () => {
    try {
      setInstallations(await listInstallations());
    } catch {
      setInstallations([]);
    }
  }, []);
  useEffect(() => {
    if (byLogin) loadInstallations();
  }, [byLogin, loadInstallations]);

  async function signOutNow() {
    try {
      // 最初の画面で、GitHub での許可の取り消し方を出すため
      sessionStorage.setItem(SIGNED_OUT_STORE, mine.report?.kind ?? "token");
    } catch {
      // 出せなくても、ログアウトはできる
    }
    await onSignOut();
  }

  return (
    <div className="form-card token-settings">
      <h3 className="settings-section-title" style={{ marginBottom: "var(--space-sm)" }}>GitHub トークン</h3>

      {/* いつものトークン */}
      <div className="token-card">
        <div className="token-card-row">
          <span className="token-card-label">いつものトークン</span>
          {overview && !overview.has_default ? (
            <span className="token-status token-status--ng">⚪ ありません（プロジェクト専用のトークンだけ）</span>
          ) : (
            <span className={`token-status token-status--${myStatus.tone}`}>
              {ICON[myStatus.tone]} {myStatus.text}
            </span>
          )}
        </div>
        {mine.report && (
          <div className="token-card-row">
            {mine.report.avatar_url && <img className="token-avatar" src={mine.report.avatar_url} alt="" />}
            <span>
              <b>{mine.report.login}</b> としてつながっています
            </span>
            <span className="token-kind">{KIND_LABELS[mine.report.kind]}</span>
          </div>
        )}
        {mine.report && (
          <div className="token-card-sub">
            {expiry ? `期限 ${expiry.date}（${expiry.days < 0 ? "切れています" : `あと ${expiry.days} 日`}）` : "期限なし"}
            {byLogin && " ・ 鍵は 8 時間ごとに自動で新しくなります"}
            {checkedAt && ` ・ 確かめた日時 ${checkedAt.getMonth() + 1}/${checkedAt.getDate()} ${String(checkedAt.getHours()).padStart(2, "0")}:${String(checkedAt.getMinutes()).padStart(2, "0")}`}
          </div>
        )}
        {byLogin && installUrl && mine.report && (
          <div className="token-card-row token-card-access">
            <RepoAccess me={{ login: mine.report.login, id: mine.report.id }} installUrl={installUrl} installations={installations}
              onChanged={async (added) => { await loadInstallations(); await changed(`使えるリポジトリが増えました（${added.join("、")}）。プロジェクト管理の「＋ 追加」で登録できます`); }} />
          </div>
        )}
        <div className="token-card-actions">
          {clientId && (
            <button type="button" className="btn-sm" onClick={() => setDialog({ kind: "login" })}>
              {byLogin ? "ログインし直す（期限を延ばす）" : "GitHub でログインし直す"}
            </button>
          )}
          <button type="button" className="btn-sm" onClick={() => setDialog({ kind: "default" })}>
            トークンを入れる…
          </button>
          <button type="button" className="btn-sm" onClick={() => { setMessage(null); refresh(); }}>
            確かめる
          </button>
          {!confirmOut ? (
            <button type="button" className="btn-sm token-signout" onClick={() => setConfirmOut(true)}>
              ログアウト
            </button>
          ) : (
            <span className="token-confirm">
              この PC から、あなたのトークンをすべて消します。
              <button type="button" className="btn-sm token-signout" onClick={signOutNow}>
                ログアウトする
              </button>
              <button type="button" className="btn-sm" onClick={() => setConfirmOut(false)}>
                やめる
              </button>
            </span>
          )}
        </div>
      </div>
      {message && <p className="sub-issues-note sub-issues-note--ok">{message}</p>}

      {/* プロジェクトごと */}
      <div className="token-projects">
        <div className="token-projects-title">プロジェクトごとに使うトークン</div>
        <table>
          <thead>
            <tr>
              <th>プロジェクト</th>
              <th>使うトークン</th>
              <th>状態</th>
            </tr>
          </thead>
          <tbody>
            {projects.map((p) => {
              const key = keyOf(p.owner, p.repo);
              const source = sourceOf(p.owner, p.repo);
              const check = checks[key];
              const st = statusOf(check);
              const name = p.name || key;
              return (
                <tr key={key}>
                  <td>
                    {name}
                    <div className="token-projects-sub">{key}</div>
                  </td>
                  <td>
                    {source === "project" ? "このプロジェクト専用" : source === "default" ? "いつもの" : "ありません"}
                    {check?.report && <div className="token-projects-sub">{check.report.login}（{KIND_LABELS[check.report.kind]}）</div>}
                  </td>
                  <td>
                    <span className={`token-status token-status--${st.tone}`}>
                      {ICON[st.tone]} {st.text}
                    </span>
                    {(st.tone === "ng" || st.tone === "warn") && check?.report && (
                      <button type="button" className="link-button token-howto" onClick={() => setOpen(open === key ? null : key)}>
                        {open === key ? "閉じる" : "直し方"}
                      </button>
                    )}
                    {open === key && check?.report && <TokenReportView report={check.report} installUrl={installUrl} />}
                    <div className="token-projects-actions">
                      <button type="button" className="btn-sm" onClick={() => setDialog({ kind: "project", owner: p.owner, repo: p.repo, name })}>
                        {source === "project" ? "入れ替える…" : "専用のトークンにする…"}
                      </button>
                      {source === "project" && (
                        <button type="button" className="btn-sm"
                          onClick={async () => { await clearProjectToken(p.owner, p.repo); await changed(`${name} は、いつものトークンを使うようにしました`); }}>
                          いつものに戻す
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="settings-hint">
        プロジェクトで使うトークンは「このプロジェクト専用 → いつもの」の順に決まります。チームの人のトークンは使わず、それぞれが自分のアカウントでログインします（リーダーは、リポジトリに招待するだけ）。
      </p>

      {dialog &&
        onTop(
          <div className="palette-overlay git-dialog-back" onClick={() => setDialog(null)}>
            <div className="git-dialog token-dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
              <h3>
                {dialog.kind === "login" ? "GitHub でログインし直す" : dialog.kind === "default" ? "トークンを入れる（いつもの）" : `トークンを入れる（${dialog.name} 専用）`}
              </h3>
              {dialog.kind === "login" ? (
                <>
                  <p className="git-dialog-note">ログインし直すと、いつものトークンが新しくなり、この PC で使う期限も今日から数え直します（プロジェクト専用のトークンはそのまま）。</p>
                  <GitHubLogin label="GitHub でログイン" onDone={() => changed("GitHub にログインし直しました")} />
                </>
              ) : dialog.kind === "default" ? (
                <TokenEntry
                  repos={projects.filter((p) => sourceOf(p.owner, p.repo) !== "project").map((p) => ({ owner: p.owner, repo: p.repo }))}
                  onSave={async (t) => { await setDefaultToken(t); await changed("いつものトークンを入れ替えました"); }}
                  onCancel={() => setDialog(null)}
                />
              ) : (
                <TokenEntry
                  repos={[{ owner: dialog.owner, repo: dialog.repo }]}
                  owner={dialog.owner}
                  saveLabel="このプロジェクト専用にする"
                  onSave={async (t) => { await setProjectToken(dialog.owner, dialog.repo, t); await changed(`${dialog.name} 専用のトークンにしました`); }}
                  onCancel={() => setDialog(null)}
                />
              )}
            </div>
          </div>
        )}
    </div>
  );
}
