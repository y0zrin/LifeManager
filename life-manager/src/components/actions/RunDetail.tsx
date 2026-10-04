import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LEVELS,
  cancelRun,
  duration,
  eventLabel,
  isActive,
  isFailed,
  jobLog,
  rerunRun,
  resultOf,
  runJobs,
  type Job,
  type Run,
  type StackCard,
} from "../../lib/actions";
import { ago } from "../../lib/pulls";
import { LogView } from "./LogView";
import { tr, trx } from "../../lib/i18n";

interface RunDetailProps {
  owner: string;
  repo: string;
  run: Run;
  /** 解決する順の山から開いたとき（急ぎ具合・続けて失敗した回数） */
  card?: StackCard | null;
  /** もう一度動かせるか（非公開のリポジトリは持ち主だけ。Actions がオフなら false） */
  canRun: boolean;
  /** 動いている実行を止められるか（書き込める人。時間の節約なので） */
  canCancel: boolean;
  /** もう一度動かせないわけ（Actions がオフ・持ち主ではない） */
  runNote?: string | null;
  defaultBranch: string;
  /** このジョブを開いておく（プルリクのチェックから来たとき） */
  focusJob?: number | null;
  onChanged: () => void;
  onOpenPull: (n: number) => void;
  /** 非公開のリポジトリ（もう一度動かすと、無料の時間を使う。毎回確かめる） */
  privateRepo?: boolean;
  /** 無料の時間を使うアカウント（持ち主・組織の管理者） */
  ownerLabel?: string;
}

type LogState = { lines: string[]; truncated: boolean } | { error: string } | "loading";

/** 失敗したステップの名前から、手元で同じことをするコマンド（npm test など）を読む */
function commandOf(step: string): string | null {
  const m = /^(?:Run )?((?:npm|npx|pnpm|yarn|cargo|pytest|python|pip|dotnet|go|make|gradle|\.\/gradlew|mvn|bundle|rake|php|composer)\b.*)$/.exec(step.trim());
  return m ? m[1] : null;
}

/** 実行の中身: 何をすればよいか → ジョブ → ステップ → 失敗したステップのログ（エラーの行を赤く） */
export function RunDetail(props: RunDetailProps) {
  const { owner, repo, run, card, canRun, canCancel, runNote, defaultBranch, focusJob, onChanged, onOpenPull, privateRepo, ownerLabel } = props;
  // 非公開のリポジトリでもう一度動かすときは、毎回確かめる
  const [confirmRerun, setConfirmRerun] = useState<"failed" | "all" | null>(null);
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [jobsError, setJobsError] = useState<string | null>(null);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [logs, setLogs] = useState<Record<number, LogState>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const opened = useRef(false);

  const loadLog = useCallback(
    (jobId: number) => {
      setLogs((l) => ({ ...l, [jobId]: "loading" }));
      jobLog(owner, repo, jobId)
        .then((r) => setLogs((l) => ({ ...l, [jobId]: r })))
        .catch((e) => setLogs((l) => ({ ...l, [jobId]: { error: String(e) } })));
    },
    [owner, repo],
  );

  // もう一度動かして止めた実行は、前の回（失敗など）のジョブとログを出す
  const attempt = run.previous_attempt ?? null;
  const loadJobs = useCallback(() => {
    runJobs(owner, repo, run.id, attempt)
      .then((j) => {
        setJobs(j);
        setJobsError(null);
        // はじめて読んだとき: 失敗したジョブ（なければ指定のジョブ）を開いて、ログも読む
        if (!opened.current) {
          opened.current = true;
          const first = j.find((x) => x.id === focusJob) ?? j.find((x) => isFailed(x));
          if (first) {
            setOpen(new Set([first.id]));
            if (first.status === "completed") loadLog(first.id);
          }
        }
      })
      .catch((e) => setJobsError(String(e)));
  }, [owner, repo, run.id, attempt, focusJob, loadLog]);

  useEffect(() => {
    setJobs(null);
    setJobsError(null);
    setOpen(new Set());
    setLogs({});
    setError(null);
    setNote(null);
    opened.current = false;
    loadJobs();
  }, [run.id, loadJobs]);

  // 動いているあいだは、ジョブの進みを読み直す
  useEffect(() => {
    if (!isActive(run) && !(jobs ?? []).some(isActive)) return;
    const t = window.setInterval(loadJobs, 8000);
    return () => window.clearInterval(t);
  }, [run, jobs, loadJobs]);

  function toggle(job: Job) {
    const next = new Set(open);
    if (next.has(job.id)) next.delete(job.id);
    else {
      next.add(job.id);
      if (!logs[job.id] && job.status === "completed") loadLog(job.id);
    }
    setOpen(next);
  }

  function rerun(failedOnly: boolean) {
    setConfirmRerun(null);
    return act(
      tr("もう一度動かしています…"),
      () => rerunRun(owner, repo, run.id, failedOnly),
      failedOnly ? tr("失敗したジョブをもう一度動かしました") : tr("すべてのジョブをもう一度動かしました"),
    );
  }

  async function act(label: string, task: () => Promise<void>, done: string) {
    setBusy(label);
    setError(null);
    setNote(null);
    try {
      await task();
      setNote(done);
      window.setTimeout(onChanged, 2500);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  }

  const result = resultOf(run);
  const failed = isFailed(run);
  const active = isActive(run);
  const level = card ? LEVELS.find((l) => l.level === card.level) : null;
  const failures = card?.failures ?? [];
  const failedStep = (jobs ?? []).flatMap((j) => j.steps.filter((s) => isFailed(s)).map((s) => s.name))[0] ?? null;
  const command = failedStep ? commandOf(failedStep) : null;
  // ゲームエンジンのテストは、エディタの中で同じテストを動かして確かめる
  const engine = failedStep && /unity-test-runner|unity-builder/i.test(failedStep) ? "unity" : failedStep && /UnrealEditor|自動テスト|Build\.bat|C\+\+ をビルド/.test(failedStep) ? "unreal" : null;
  const onDefault = run.branch === defaultBranch;

  let todo: ReactNode = null;
  if (failed) {
    todo = (
      <ol>
        <li>
          {trx("下のログの<0>赤い行</0>を見ます（どこで何が起きたか）。", undefined, [<b />])}{failedStep && <>{trx("失敗したのは「{failedStep}」の手順です。", { failedStep })}</>}
        </li>
        {run.conclusion === "startup_failure" ? (
          <li>
            {trx("始められなかったときは、ワークフローのファイル（<0>{path}</0>）の書き方に誤りがあります。", { path: run.path }, [<code />])}
          </li>
        ) : run.conclusion === "timed_out" ? (
          <li>{tr("時間切れです。重すぎる処理や、終わらずに待ち続けている手順がないかを見ます。")}</li>
        ) : run.conclusion === "action_required" ? (
          <li>{tr("持ち主の承認がいる実行です（フォークからのプルリクなど）。GitHub の画面で承認します。")}</li>
        ) : engine === "unity" ? (
          <li>
            {trx("この PC の Unity で <0>Window → General → Test Runner</0> を開き、同じテスト（EditMode・PlayMode）を動かして確かめます。コンパイルエラーなら、Console に同じエラーが出ます。", undefined, [<b />])}
          </li>
        ) : engine === "unreal" ? (
          <li>
            {trx("この PC の Unreal で <0>Tools → Session Frontend → Automation</0> を開き、同じテストを動かして確かめます。C++ のビルドで失敗したときは、Visual Studio でビルドして同じエラーを見ます。", undefined, [<b />])}
          </li>
        ) : (
          <li>
            {tr("この PC の作業フォルダで")}{command ? <> {" "}{trx("<0>{command}</0> を動かして", { command }, [<code />])}</> : tr("同じことをして")}{tr("、同じ失敗が出るかを確かめます。")}
          </li>
        )}
        <li>
          {tr("直してコミットとプッシュをすると、自動でもう一度動きます。")}
          {onDefault
            ? tr("急ぐときは失敗を入れたコミットを打ち消す（リバート）こともできます。")
            : card?.pull
              ? tr("プルリク #{number} のチェックもやり直されます。", { number: card.pull.number })
              : ""}
          {tr("ネットの不調などたまたまの失敗なら「失敗したものをもう一度」。")}
        </li>
      </ol>
    );
  }

  return (
    <div className="ac-detail">
      <div className="ac-head">
        {level && card && card.level < 4 && <span className={`ac-level l${card.level}`}>{level.icon} {level.label}</span>}
        <span className={`ac-result t-${result.tone}`}>
          {result.icon} {result.label}
        </span>
        <h2 className="ac-title">
          {run.name} <span className="muted">#{run.run_number}</span>
        </h2>
        <span className="grow" />
        {canRun && failed && (
          <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => (privateRepo ? setConfirmRerun("failed") : rerun(true))}>
            {tr("↻ 失敗したものをもう一度")}{privateRepo ? "…" : ""}
          </button>
        )}
        {canRun && run.status === "completed" && (
          <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => (privateRepo ? setConfirmRerun("all") : rerun(false))}>
            {tr("↻ すべてもう一度")}{privateRepo ? "…" : ""}
          </button>
        )}
        {canCancel && active && (
          <button type="button" className="btn-sm" disabled={busy !== null} onClick={() => act(tr("止めています…"), () => cancelRun(owner, repo, run.id), tr("止めました"))}>
            {tr("■ 止める")}
          </button>
        )}
        <button type="button" className="btn-sm" onClick={() => openUrl(run.html_url).catch(() => {})}>
          {tr("GitHub で開く ↗")}
        </button>
      </div>
      {confirmRerun && (
        <div className="ac-cost-confirm ac-rerun-confirm">
          {tr("非公開のリポジトリなので、")}{ownerLabel ?? owner} {" "}{tr("の Actions の無料の時間を使います。")}{confirmRerun === "failed" ? tr("失敗したジョブを") : tr("すべてのジョブを")}{tr("もう一度動かしますか？")}
          <button type="button" className="btn-sm" onClick={() => setConfirmRerun(null)}>
            {tr("やめる")}
          </button>
          <button type="button" className="btn-sm primary" disabled={busy !== null} onClick={() => rerun(confirmRerun === "failed")}>
            {tr("無料の時間を使って動かす")}
          </button>
        </div>
      )}
      {!canRun && runNote && (failed || run.status === "completed") && <p className="muted">↻ {runNote}</p>}
      <div className="ac-meta">
        {trx("<0>{branch}</0> への{eventLabel}（<1>{slice}</1>", { branch: run.branch, eventLabel: eventLabel(run.event), slice: run.sha.slice(0, 7) }, [<code className="pr-branch" />, <code />])}{" "} {run.commit_message || run.title}{tr("）で動きました。")}
        {run.actor?.login ?? ""}
        {run.started_at && tr("・{duration}", { duration: duration(run.started_at, run.status === "completed" ? run.updated_at : null) })}
        {tr("・{ago}", { ago: ago(run.created_at) })}
        {run.run_attempt > 1 &&
          (attempt ? (
            <span className="muted">{trx("（もう一度動かした {run_attempt} 回目は止めました。下は {attempt} 回目の結果です）", { run_attempt: run.run_attempt, attempt })}</span>
          ) : (
            <span className="muted">{trx("（{run_attempt} 回目）", { run_attempt: run.run_attempt })}</span>
          ))}
        {card?.pull && (
          <>
            {" "}
            <button type="button" className="pr-ref" onClick={() => onOpenPull(card.pull!.number)}>
              {trx("プルリク #{number}", { number: card.pull.number })}
            </button>
          </>
        )}
      </div>
      {failures.length > 1 && (
        <div className="ac-streak">
          {failures.map((f) => `#${f.run_number}`).join(tr("・"))} {" "}{trx("が<0>続けて失敗</0>しています（最初は {ago}、<1>{slice}</1> {commit_message}・", { ago: ago(failures[failures.length - 1].created_at), slice: failures[failures.length - 1].sha.slice(0, 7), commit_message: failures[failures.length - 1].commit_message }, [<b />, <code />])}
          {failures[failures.length - 1].actor?.login ?? ""} {" "}{tr("から）")}
        </div>
      )}
      {card?.rerunning && <div className="ac-rerunning">{trx("● 今もう一度動いています（#{run_number}）", { run_number: card.rerunning.run_number })}</div>}
      {todo && (
        <div className={`ac-todo${card ? ` l${card.level}` : ""}`}>
          {trx("<0>何をすればよいか</0>{todo}", { todo }, [<b />])}
        </div>
      )}
      {busy && <p className="muted">{busy}</p>}
      {note && <p className="ac-note">{note}</p>}
      {error && <p className="git-dialog-error">{error}</p>}

      {jobsError ? (
        <p className="git-dialog-error">{jobsError}</p>
      ) : !jobs ? (
        <p className="muted">{tr("ジョブを読み込んでいます…")}</p>
      ) : jobs.length === 0 ? (
        <p className="muted">{tr("ジョブはまだありません（順番待ちなど）。")}</p>
      ) : (
        jobs.map((job) => {
          const r = resultOf(job);
          const isOpen = open.has(job.id);
          const log = logs[job.id];
          return (
            <div key={job.id} className={`ac-job t-${r.tone}${isOpen ? " open" : ""}`}>
              <button type="button" className="ac-job-head" onClick={() => toggle(job)} aria-expanded={isOpen}>
                <span className={`ac-icon t-${r.tone}`}>{r.icon}</span>
                <b>{job.name}</b>
                <span className="grow" />
                <span className="muted">{duration(job.started_at, job.completed_at)}</span>
                <span className="ac-caret">{isOpen ? "▾" : "▸"}</span>
              </button>
              {isOpen && (
                <div className="ac-job-body">
                  {job.steps.map((s) => {
                    const sr = resultOf(s);
                    return (
                      <div key={s.number} className={`ac-step t-${sr.tone}`}>
                        <span className={`ac-icon t-${sr.tone}`}>{sr.icon}</span>
                        <span className="ac-step-name">{s.name}</span>
                        <span className="muted">{s.conclusion === "skipped" ? tr("とばした") : duration(s.started_at, s.completed_at)}</span>
                      </div>
                    );
                  })}
                  {job.status !== "completed" ? (
                    <p className="muted">{tr("動いています。終わるとログを見られます。")}</p>
                  ) : log === "loading" ? (
                    <p className="muted">{tr("ログを読み込んでいます…")}</p>
                  ) : !log ? (
                    <button type="button" className="btn-sm" onClick={() => loadLog(job.id)}>
                      {tr("ログを見る")}
                    </button>
                  ) : "error" in log ? (
                    <p className="git-dialog-error">{log.error}</p>
                  ) : (
                    <LogView lines={log.lines} truncated={log.truncated} />
                  )}
                </div>
              )}
            </div>
          );
        })
      )}
    </div>
  );
}
