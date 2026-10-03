import { useCallback, useEffect, useState } from "react";
import { checkToken, type TokenReport } from "../../lib/auth";
import { setupStatus } from "../../lib/git";
import type { GitSetupStatus } from "../../lib/types";
import { isMobile } from "../../lib/platform";

interface SetupChecklistProps {
  owner: string;
  repo: string;
  login: string;
  /** この PC の作業フォルダ（スマホは undefined） */
  folder?: string;
  /** Git のインストール・名前とメールを変えたら増える（確かめ直す） */
  setupVersion: number;
  /** Life Manager の許可を直すところ（設定 → トークン） */
  onOpenAccess: () => void;
  /** 作業フォルダを決めるところ（作業をする） */
  onOpenFolder: () => void;
  /** Git のインストール・名前とメールのダイアログ */
  onOpenGitSetup: () => void;
}

type Status = "ok" | "todo" | "warn" | "checking";

interface Item {
  key: string;
  label: string;
  status: Status;
  detail?: string;
  fix?: { label: string; run: () => void };
}

const ICONS: Record<Status, string> = { ok: "✓", todo: "!", warn: "!", checking: "…" };

/**
 * はじめの準備のチェックリスト（#237）: ログイン・リポジトリ・Life Manager の許可・作業フォルダ・Git・名前とメール。
 * 済んでいないものには、直すところへ行くボタン。作業フォルダから下は PC だけ
 */
export function SetupChecklist({ owner, repo, login, folder, setupVersion, onOpenAccess, onOpenFolder, onOpenGitSetup }: SetupChecklistProps) {
  const [report, setReport] = useState<TokenReport | null>(null);
  const [reportError, setReportError] = useState(false);
  const [git, setGit] = useState<GitSetupStatus | null>(null);
  const [round, setRound] = useState(0);

  const recheck = useCallback(() => setRound((n) => n + 1), []);

  useEffect(() => {
    if (!owner || !repo) return;
    let alive = true;
    setReport(null);
    setReportError(false);
    checkToken({ owner, repo, repos: [{ owner, repo }] })
      .then((r) => { if (alive) setReport(r); })
      .catch(() => { if (alive) setReportError(true); });
    return () => { alive = false; };
  }, [owner, repo, round]);

  useEffect(() => {
    if (isMobile) return;
    let alive = true;
    setGit(null);
    setupStatus()
      .then((s) => { if (alive) setGit(s); })
      .catch(() => { if (alive) setGit({ git: null, user_name: null, user_email: null, installer: null }); });
    return () => { alive = false; };
  }, [setupVersion, round]);

  const items: Item[] = [
    {
      key: "login",
      label: "GitHub にログイン",
      status: "ok",
      detail: report ? `${report.login}（${report.kind === "app" ? "GitHub でログイン" : "トークン"}）` : login,
    },
    { key: "repo", label: "リポジトリ", status: owner && repo ? "ok" : "todo", detail: owner && repo ? `${owner}/${repo}` : undefined },
  ];

  // Life Manager の許可は「GitHub でログイン」のときだけ（トークンで使うときは要らない）
  const access = report?.repos[0];
  if (reportError) {
    items.push({ key: "access", label: "Life Manager の許可", status: "warn", detail: "確かめられませんでした", fix: { label: "もう一度", run: recheck } });
  } else if (!report) {
    items.push({ key: "access", label: "Life Manager の許可", status: "checking" });
  } else if (report.kind === "app" && access) {
    if (access.ok && access.can_push) {
      items.push({ key: "access", label: "Life Manager の許可", status: "ok" });
    } else if (access.ok) {
      items.push({ key: "access", label: "Life Manager の許可", status: "warn", detail: access.message ?? "見るだけ（書き込めません）" });
    } else {
      items.push({
        key: "access",
        label: "Life Manager の許可",
        status: "todo",
        detail: access.message ?? undefined,
        fix: { label: access.problem === "not_installed" ? "許可する…" : "直し方…", run: onOpenAccess },
      });
    }
  }

  if (!isMobile) {
    items.push({
      key: "folder",
      label: "作業フォルダ",
      status: folder ? "ok" : "todo",
      detail: folder,
      fix: folder ? undefined : { label: "決める…", run: onOpenFolder },
    });
    if (!git) {
      items.push({ key: "git", label: "Git", status: "checking" }, { key: "identity", label: "名前とメールアドレス", status: "checking" });
    } else {
      items.push({
        key: "git",
        label: "Git",
        status: git.git ? "ok" : "todo",
        detail: git.git ?? undefined,
        fix: git.git ? undefined : { label: "インストールする…", run: onOpenGitSetup },
      });
      const named = !!git.user_name && !!git.user_email;
      items.push({
        key: "identity",
        label: "名前とメールアドレス",
        status: named ? "ok" : "todo",
        detail: named ? `${git.user_name} <${git.user_email}>` : undefined,
        fix: named ? undefined : { label: "決める…", run: onOpenGitSetup },
      });
    }
  }

  const left = items.filter((i) => i.status === "todo" || i.status === "warn").length;
  const checking = items.some((i) => i.status === "checking");

  return (
    <section className={`setup-check${left ? " has-left" : ""}`} aria-label="準備のチェックリスト">
      <div className="setup-check-head">
        <b>📋 準備のチェックリスト</b>
        <span className={`setup-check-sum${left ? " left" : ""}`}>{checking ? "確かめています…" : left ? `あと ${left}` : "✓ そろっています"}</span>
        <span className="grow" />
        <button type="button" className="btn-sm" onClick={recheck} disabled={checking} title="確かめ直す">
          ↻
        </button>
      </div>
      <ul>
        {items.map((i) => (
          <li key={i.key} className={`sc-${i.status}`}>
            <span className="sc-icon" aria-hidden="true">
              {ICONS[i.status]}
            </span>
            <span className="sc-label">{i.label}</span>
            <span className="sc-detail" title={i.detail}>
              {i.detail}
            </span>
            {i.fix && (
              <button type="button" className={i.status === "todo" ? "btn-primary sc-fix" : "btn-sm sc-fix"} onClick={i.fix.run}>
                {i.fix.label}
              </button>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
