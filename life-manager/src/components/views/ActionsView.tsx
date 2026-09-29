import { useCallback, useEffect, useMemo, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import {
  LEVELS,
  STALE_DAYS,
  actionsWorkflows,
  duration,
  eventLabel,
  isActive,
  isFailed,
  resultOf,
  type Run,
  type StackCard,
  type Workflow,
} from "../../lib/actions";
import { ago } from "../../lib/pulls";
import { withTransition } from "../../lib/motion";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { ActionsState } from "../../hooks/useActions";
import { RunDetail } from "../actions/RunDetail";
import { SecurityDetail } from "../actions/SecurityDetail";
import { DispatchDialog } from "../actions/DispatchDialog";

type Tab = "stack" | "runs" | "workflows";
const TABS: Tab[] = ["stack", "runs", "workflows"];

const WORKFLOW_STATES: Record<string, string> = {
  active: "使っている",
  disabled_manually: "止めてある",
  disabled_inactivity: "長く使わないので止まった",
  disabled_fork: "フォークなので止まっている",
};

interface ActionsViewProps {
  owner: string;
  repo: string;
  actions: ActionsState;
  onOpenPull: (n: number) => void;
  /** この実行（とジョブ）を開く（プルリクのチェックから来たとき） */
  focus: { runId: number; jobId?: number | null } | null;
  onFocusHandled: () => void;
}

/** Actions: 直す順に積んだ山（解決する順）・すべての実行・ワークフロー。右に中身 */
export function ActionsView({ owner, repo, actions, onOpenPull, focus, onFocusHandled }: ActionsViewProps) {
  const { overview, stack, error, loading, reload } = actions;
  const wide = useMediaQuery("(min-width: 901px)");
  const [tab, setTab] = useState<Tab>("stack");
  const [picked, setPicked] = useState<string | null>(null);
  const [focusJob, setFocusJob] = useState<number | null>(null);
  const [showFine, setShowFine] = useState(false);
  const [workflows, setWorkflows] = useState<Workflow[] | null>(null);
  const [wfError, setWfError] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [dispatching, setDispatching] = useState<Workflow | null>(null);
  const [filters, setFilters] = useState({ workflow: "", branch: "", result: "" });
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    setPicked(null);
    setWorkflows(null);
    setWfError(null);
    setTab("stack");
  }, [owner, repo]);

  const loadWorkflows = useCallback(() => {
    actionsWorkflows(owner, repo)
      .then((w) => {
        setWorkflows(w);
        setWfError(null);
      })
      .catch((e) => setWfError(String(e)));
  }, [owner, repo]);

  useEffect(() => {
    if ((tab === "workflows" || menu) && !workflows && !wfError) loadWorkflows();
  }, [tab, menu, workflows, wfError, loadWorkflows]);

  const cards = useMemo(() => stack?.cards ?? [], [stack]);

  // プルリクのチェックから来たとき: その実行のカード（なければ、すべての実行の中）を開く
  useEffect(() => {
    if (!focus || !overview) return;
    const card = cards.find((c) => c.run?.id === focus.runId || c.failures?.some((f) => f.id === focus.runId));
    if (card && (card.run?.id === focus.runId || card.failures?.[0]?.id === focus.runId)) {
      setTab("stack");
      setPicked(`card:${card.key}`);
    } else if (overview.runs.some((r) => r.id === focus.runId)) {
      setTab("runs");
      setPicked(`run:${focus.runId}`);
    } else {
      setNotice(`その実行は、最近の 100 件にありません。GitHub で開いて見てください（https://github.com/${owner}/${repo}/actions/runs/${focus.runId}）`);
    }
    setFocusJob(focus.jobId ?? null);
    onFocusHandled();
  }, [focus, overview, cards, owner, repo, onFocusHandled]);

  const pickedCard = picked?.startsWith("card:") ? cards.find((c) => `card:${c.key}` === picked) ?? null : null;
  const pickedRun = picked?.startsWith("run:") ? overview?.runs.find((r) => `run:${r.id}` === picked) ?? null : null;
  // 選んでいたカードが山から消えたら（直った）、いちばん上を出す（広い窓だけ）
  const fallback = wide && tab === "stack" && cards[0] ? cards[0] : null;
  const card = pickedCard ?? (pickedRun ? null : fallback);
  const selectedKey = card ? `card:${card.key}` : pickedRun ? `run:${pickedRun.id}` : null;
  const hasSelection = !!(pickedCard || pickedRun);

  function changeTab(next: Tab) {
    if (next === tab) return;
    const dir = TABS.indexOf(next) > TABS.indexOf(tab) ? "vt-right" : "vt-left";
    withTransition(() => setTab(next), ["vt-filter", dir]);
  }

  function pick(key: string | null, order: string[]) {
    const from = selectedKey ? order.indexOf(selectedKey) : -1;
    const to = key ? order.indexOf(key) : -1;
    setFocusJob(null);
    withTransition(() => setPicked(key), ["vt-pick", ...(from >= 0 && to >= 0 && to < from ? ["vt-up"] : [])]);
  }

  const runs = overview?.runs ?? [];
  const workflowNames = useMemo(() => [...new Set(runs.map((r) => r.name))].sort(), [runs]);
  const branchNames = useMemo(() => [...new Set(runs.map((r) => r.branch))].sort(), [runs]);
  const shownRuns = runs.filter(
    (r) =>
      (!filters.workflow || r.name === filters.workflow) &&
      (!filters.branch || r.branch === filters.branch) &&
      (!filters.result ||
        (filters.result === "failed" && isFailed(r)) ||
        (filters.result === "success" && r.conclusion === "success") ||
        (filters.result === "active" && isActive(r))),
  );
  const dispatchable = (workflows ?? []).filter((w) => w.dispatch !== null && w.state === "active");
  const canPush = overview?.can_push ?? false;

  const cardOrder = cards.map((c) => `card:${c.key}`);
  const runOrder = shownRuns.map((r) => `run:${r.id}`);

  function renderCard(c: StackCard, i: number) {
    const level = LEVELS.find((l) => l.level === c.level)!;
    const key = `card:${c.key}`;
    return (
      <button
        key={c.key}
        type="button"
        className={`ac-card l${c.level}${c.streak > 1 ? " stacked" : ""}${selectedKey === key ? " on" : ""}`}
        onClick={() => pick(key, cardOrder)}
      >
        <span className="ac-no">{i + 1}</span>
        <span className="ac-card-body">
          <span className="ac-card-title">
            {c.title}
            {c.streak > 1 && <span className="ac-times">×{c.streak} 続けて</span>}
          </span>
          <span className="ac-card-why">{c.why}</span>
          <span className="ac-card-meta">
            <span className={`ac-tag l${c.level}`}>{level.label}</span>
            {c.run && <code className="pr-branch">{c.run.branch}</code>}
            {c.kind === "dependabot" && c.dependabot && <span>{c.dependabot.manifest}</span>}
            {c.rerunning && <span className="t-wait">● もう一度動いています</span>}
            <span className="muted">
              {ago(c.since)}
              {c.kind === "run" && c.level < 4 ? "から" : ""}
            </span>
          </span>
        </span>
      </button>
    );
  }

  function securityNote(kind: "dependabot" | "code") {
    const s = kind === "dependabot" ? overview?.dependabot : overview?.code_scanning;
    if (!s || s.state === "ok") return null;
    const icon = kind === "dependabot" ? "🛡" : "🔍";
    const name = kind === "dependabot" ? "Dependabot（古くて危ないライブラリのお知らせ）" : "コードスキャン（危ない書き方のお知らせ）";
    return (
      <p key={kind} className="ac-security-note">
        {icon}{" "}
        {s.state === "off"
          ? `${name}は使っていません。GitHub の Settings → Code security で有効にすると、この山に入ります`
          : s.message ?? `${name}を読めませんでした`}
      </p>
    );
  }

  const detail = (() => {
    if (card?.kind === "run" && card.run) {
      return (
        <RunDetail
          key={card.run.id}
          owner={owner}
          repo={repo}
          run={card.run}
          card={card}
          canPush={canPush}
          defaultBranch={overview?.default_branch ?? "main"}
          focusJob={focusJob}
          onChanged={reload}
          onOpenPull={onOpenPull}
        />
      );
    }
    if (card && (card.kind === "dependabot" || card.kind === "code")) return <SecurityDetail card={card} onOpenPull={onOpenPull} />;
    if (pickedRun) {
      return (
        <RunDetail
          key={pickedRun.id}
          owner={owner}
          repo={repo}
          run={pickedRun}
          canPush={canPush}
          defaultBranch={overview?.default_branch ?? "main"}
          focusJob={focusJob}
          onChanged={reload}
          onOpenPull={onOpenPull}
        />
      );
    }
    return (
      <div className="pulls-intro">
        <h3>Actions とは</h3>
        <p>
          プッシュやプルリクのたびに、GitHub がテストやビルドを自動で動かすしくみです（<code>.github/workflows/*.yml</code> に書きます）。赤い ✖ は、どこかの手順が失敗したということです。
        </p>
        <h3>解決する順の山</h3>
        <ol className="pulls-steps">
          {LEVELS.map((l) => (
            <li key={l.level}>
              {l.icon} <b>{l.label}</b>:{" "}
              {l.level === 1
                ? "既定のブランチ・保護されたブランチの失敗、セキュリティ「重大」"
                : l.level === 2
                  ? "開いているプルリクのブランチの失敗（マージを止める）、セキュリティ「高」"
                  : l.level === 3
                    ? "ほかのブランチの失敗、セキュリティ「中・低」"
                    : "実行中・順番待ち"}
            </li>
          ))}
        </ol>
        <p className="muted">
          1 枚はワークフロー × ブランチの最後の結果です。失敗が続くと重ねて ×N、成功すると山から消えます。同じ色の中は、長く直っていないものほど上。消したブランチと、{STALE_DAYS} 日以上動いていないブランチは入れません。
        </p>
      </div>
    );
  })();

  return (
    <div className={`actions pr-ui${hasSelection ? " has-selection" : ""}`}>
      <div className="ac-top">
        <div className="pulls-filters ac-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t} type="button" role="tab" aria-selected={tab === t} className={`pulls-filter${tab === t ? " on" : ""}`} onClick={() => changeTab(t)}>
              {t === "stack" ? (
                <>
                  解決する順 <b>{stack ? cards.filter((c) => c.level < 4).length : "…"}</b>
                </>
              ) : t === "runs" ? (
                "すべての実行"
              ) : (
                <>ワークフロー {workflows && <b>{workflows.length}</b>}</>
              )}
              {tab === t && <span className="tab-active-bar pulls-filter-bar" />}
            </button>
          ))}
        </div>
        <span className="grow" />
        {canPush && (
          <span className="pr-picker">
            <button type="button" className="btn-sm" onClick={() => setMenu((v) => !v)} aria-expanded={menu}>
              ▶ 手で実行 ▾
            </button>
            {menu && (
              <span className="pr-picker-menu ac-run-menu" role="menu">
                {wfError ? (
                  <span className="git-dialog-error">{wfError}</span>
                ) : !workflows ? (
                  <span className="muted">読み込んでいます…</span>
                ) : dispatchable.length === 0 ? (
                  <span className="muted">手で動かせるワークフローはありません（ファイルに workflow_dispatch と書くと動かせます）</span>
                ) : (
                  dispatchable.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      role="menuitem"
                      onClick={() => {
                        setMenu(false);
                        setDispatching(w);
                      }}
                    >
                      ▶ {w.name} <span className="muted">{w.path.replace(".github/workflows/", "")}</span>
                    </button>
                  ))
                )}
              </span>
            )}
          </span>
        )}
        <button type="button" className="btn-sm" onClick={reload} disabled={loading} title="読み直す">
          {loading ? "…" : "↻"}
        </button>
      </div>

      {error && !overview ? (
        <div className="pulls-empty">
          <p className="git-dialog-error">{error}</p>
          <button type="button" className="btn-sm" onClick={reload}>
            もう一度読み込む
          </button>
        </div>
      ) : !overview || !stack ? (
        <p className="pulls-empty muted">読み込んでいます…</p>
      ) : (
        <div className="ac-body">
          <div className="ac-list">
            {notice && (
              <p className="pulls-notice">
                {notice}
                <button type="button" className="git-notice-close" aria-label="閉じる" onClick={() => setNotice(null)}>
                  ×
                </button>
              </p>
            )}
            <div className="ac-items">
              {tab === "stack" && (
                <>
                  <div className="ac-meter" aria-hidden="true">
                    {LEVELS.map((l) => stack.counts[l.level] > 0 && <i key={l.level} className={`l${l.level}`} style={{ flex: stack.counts[l.level] }} />)}
                    {stack.fine.length > 0 && <i className="fine" style={{ flex: stack.fine.length }} />}
                  </div>
                  <div className="ac-legend">
                    {LEVELS.map((l) => (
                      <span key={l.level}>
                        <b className={`l${l.level}`}>
                          {l.icon} {stack.counts[l.level]}
                        </b>{" "}
                        {l.label}
                      </span>
                    ))}
                    <span>
                      <b className="ok">✔ {stack.fine.length}</b> 問題なし
                    </span>
                  </div>
                  {cards.length === 0 && (
                    <div className="ac-clear">
                      <b>✔ 直すものはありません</b>
                      <span>テスト・ビルドの最後の結果は、すべて成功です。</span>
                    </div>
                  )}
                  {cards.map(renderCard)}
                  {stack.fixed.map((f) => (
                    <button key={f.key} type="button" className="ac-fixed" onClick={() => pick(`run:${f.run.id}`, cardOrder)}>
                      ✔ {f.run.name}（{f.run.branch}）が直りました{" "}
                      <span className="muted">
                        {f.was} 回失敗のあと・{ago(f.run.updated_at)}
                      </span>
                    </button>
                  ))}
                  {stack.fine.length > 0 && (
                    <button type="button" className="ac-fine" onClick={() => setShowFine((v) => !v)} aria-expanded={showFine}>
                      ✔ 問題なし {stack.fine.length}（最後の結果が成功）<span className="grow" />
                      {showFine ? "▾ たたむ" : "▸ 見る"}
                    </button>
                  )}
                  {showFine &&
                    stack.fine.map((r) => (
                      <button key={r.id} type="button" className={`ac-fine-item${selectedKey === `run:${r.id}` ? " on" : ""}`} onClick={() => pick(`run:${r.id}`, cardOrder)}>
                        <span className="t-ok">✔</span> {r.name} <code className="pr-branch">{r.branch}</code>
                        <span className="grow" />
                        <span className="muted">{ago(r.updated_at)}</span>
                      </button>
                    ))}
                  {securityNote("dependabot")}
                  {securityNote("code")}
                  <p className="hint">直してプッシュすると自動でもう一度動き、成功すれば「✔ 直りました」と出て山から消えます。</p>
                </>
              )}

              {tab === "runs" && (
                <>
                  <div className="ac-filters">
                    <select className="select-sm" value={filters.workflow} onChange={(e) => setFilters({ ...filters, workflow: e.target.value })} aria-label="ワークフロー">
                      <option value="">ワークフロー: すべて</option>
                      {workflowNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <select className="select-sm" value={filters.branch} onChange={(e) => setFilters({ ...filters, branch: e.target.value })} aria-label="ブランチ">
                      <option value="">ブランチ: すべて</option>
                      {branchNames.map((n) => (
                        <option key={n} value={n}>
                          {n}
                        </option>
                      ))}
                    </select>
                    <select className="select-sm" value={filters.result} onChange={(e) => setFilters({ ...filters, result: e.target.value })} aria-label="結果">
                      <option value="">結果: すべて</option>
                      <option value="failed">失敗</option>
                      <option value="success">成功</option>
                      <option value="active">動いている</option>
                    </select>
                  </div>
                  {shownRuns.length === 0 && <p className="pulls-empty muted">{runs.length === 0 ? "まだ実行はありません。" : "当てはまる実行はありません。"}</p>}
                  {shownRuns.map((r: Run) => {
                    const res = resultOf(r);
                    const key = `run:${r.id}`;
                    return (
                      <button key={r.id} type="button" className={`ac-run${selectedKey === key ? " on" : ""}`} onClick={() => pick(key, runOrder)}>
                        <span className={`ac-icon t-${res.tone}`} title={res.label}>
                          {res.icon}
                        </span>
                        <span className="ac-card-body">
                          <span className="ac-card-title">
                            {r.name} <span className="muted">#{r.run_number}</span> {r.title}
                          </span>
                          <span className="ac-card-meta">
                            <code className="pr-branch">{r.branch}</code>
                            <span>{eventLabel(r.event)}</span>
                            <span>{r.actor?.login ?? ""}</span>
                            {r.started_at && <span>{duration(r.started_at, r.status === "completed" ? r.updated_at : null)}</span>}
                            <span className="muted">{ago(r.created_at)}</span>
                          </span>
                        </span>
                      </button>
                    );
                  })}
                </>
              )}

              {tab === "workflows" &&
                (wfError ? (
                  <p className="git-dialog-error">{wfError}</p>
                ) : !workflows ? (
                  <p className="pulls-empty muted">読み込んでいます…</p>
                ) : workflows.length === 0 ? (
                  <div className="pulls-empty">
                    <p>ワークフローはありません。</p>
                    <p className="hint">
                      <code>.github/workflows/</code> に YAML のファイルを置くと、プッシュのたびにテストなどが動きます（GitHub の Actions タブに、言語ごとのひな形があります）。
                    </p>
                  </div>
                ) : (
                  workflows.map((w) => {
                    const last = runs.find((r) => r.workflow_id === w.id && r.branch === overview.default_branch && r.status === "completed");
                    const res = last ? resultOf(last) : null;
                    return (
                      <div key={w.id} className="ac-workflow">
                        <span className={`ac-icon t-${res?.tone ?? "muted"}`} title={res ? `${overview.default_branch} の最後: ${res.label}` : "まだ動いていません"}>
                          {res?.icon ?? "○"}
                        </span>
                        <span className="ac-card-body">
                          <span className="ac-card-title">{w.name}</span>
                          <span className="ac-card-meta">
                            <code>{w.path}</code>
                            <span className={w.state === "active" ? "" : "t-warn"}>{WORKFLOW_STATES[w.state] ?? w.state}</span>
                            {w.dispatch !== null && <span>手で動かせる</span>}
                          </span>
                        </span>
                        {canPush && w.dispatch !== null && w.state === "active" && (
                          <button type="button" className="btn-sm" onClick={() => setDispatching(w)}>
                            ▶ 手で実行
                          </button>
                        )}
                        <button type="button" className="btn-sm" onClick={() => openUrl(w.html_url).catch(() => {})} title="GitHub で開く">
                          ↗
                        </button>
                      </div>
                    );
                  })
                ))}
            </div>
          </div>
          <div className="ac-detail-pane">
            {hasSelection && (
              <button type="button" className="btn-sm pr-back ac-back" onClick={() => pick(null, [])}>
                ← 一覧
              </button>
            )}
            {detail}
          </div>
        </div>
      )}

      {dispatching && overview && (
        <DispatchDialog
          owner={owner}
          repo={repo}
          workflow={dispatching}
          branches={overview.branches ?? []}
          defaultBranch={overview.default_branch}
          onClose={() => setDispatching(null)}
          onDone={() => {
            setNotice(`▶ ${dispatching.name} を動かしました。少しすると「すべての実行」に出ます`);
            setDispatching(null);
            setFilters({ workflow: "", branch: "", result: "" });
            setTab("runs");
            window.setTimeout(reload, 3000);
          }}
        />
      )}
    </div>
  );
}
