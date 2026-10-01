import { useMemo, useState } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser, TimelineEvent } from "../../lib/types";
import { AnalyticsPanel } from "../common/AnalyticsPanel";
import { TeamPace } from "../common/TeamPace";
import { useEstimateUnit } from "../common/EstimateChip";
import { estimateOf } from "../../lib/estimate";
import { finishedMilestones, velocity, type PaceMode } from "../../lib/sprint";
import { isSectionLabel, sectionOf } from "../../lib/section";

interface InsightsViewProps {
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  milestones: GitHubMilestone[];
  labels: GitHubLabel[];
  collaborators: GitHubUser[];
  /** 今のリポジトリ（サイクルタイムのために読んだ変更の履歴を、リポジトリごとに覚える） */
  owner: string;
  repo: string;
  /** 状態の順番（ボードの列の順）。色もこの順に決める */
  stateOrder: string[];
  onSelectIssue: (n: number) => void;
  onListTimeline: (issueNumber: number) => Promise<TimelineEvent[]>;
}

/** 量の数え方（見積もり／件数）。マイルストーンの画面と同じ決め方で、次に開いたときも同じ */
const MODE_STORE = "pace-mode";
/** 絞り込み（マイルストーン・担当・セクション）。次に開いたときも同じ */
const FILTER_STORE = "insights-filters";

type Filters = { milestone: string; assignee: string; domain: string };
const ALL: Filters = { milestone: "all", assignee: "all", domain: "all" };

function loadFilters(): Filters {
  try {
    return { ...ALL, ...JSON.parse(localStorage.getItem(FILTER_STORE) ?? "{}") };
  } catch {
    return ALL;
  }
}

/**
 * オーバービュー（サイドバーのタスクの一番上）。いまの状況（開いている数・期限切れ・もうすぐ・担当なし、状態ごと・担当ごと、
 * 8 週の作った数と閉じた数）と、チームのペース（ベロシティ・サイクルタイム）を 1 つの画面で見る。
 * いまの状況は、上のマイルストーン・担当・セクションで絞れる（チームのペースは、リポジトリ全体）
 */
export function InsightsView({ issues, closedIssues, milestones, labels, collaborators, owner, repo, stateOrder, onSelectIssue, onListTimeline }: InsightsViewProps) {
  const unit = useEstimateUnit();
  const [filters, setFilters] = useState<Filters>(loadFilters);

  function change(patch: Partial<Filters>) {
    const next = { ...filters, ...patch };
    setFilters(next);
    try {
      localStorage.setItem(FILTER_STORE, JSON.stringify(next));
    } catch {
      // 覚えられなくても、今は絞り込める
    }
  }

  // 前のリポジトリで選んだマイルストーン・担当が、今のリポジトリにないときは「全て」として扱う
  const milestone = filters.milestone === "all" || filters.milestone === "none" || milestones.some((m) => String(m.number) === filters.milestone)
    ? filters.milestone
    : "all";
  const assignee = filters.assignee === "all" || filters.assignee === "none" || collaborators.some((c) => c.login === filters.assignee)
    ? filters.assignee
    : "all";
  const domains = useMemo(() => labels.filter((l) => isSectionLabel(l.name)).map((l) => l.name), [labels]);
  const domain = filters.domain === "all" || domains.includes(filters.domain) ? filters.domain : "all";

  const all = useMemo(() => [...issues, ...closedIssues], [issues, closedIssues]);
  const scope = useMemo(
    () =>
      all.filter((i) => {
        if (milestone === "none" ? !!i.milestone : milestone !== "all" && String(i.milestone?.number ?? "") !== milestone) return false;
        const logins = (i.assignees ?? []).map((a) => a.login);
        if (assignee === "none" ? logins.length > 0 : assignee !== "all" && !logins.includes(assignee)) return false;
        if (domain !== "all" && !i.labels.some((l) => l.name === domain)) return false;
        return true;
      }),
    [all, milestone, assignee, domain],
  );
  const scopeText = [
    milestone === "none" ? "マイルストーンなし" : milestone !== "all" ? `マイルストーン:${milestones.find((m) => String(m.number) === milestone)?.title ?? ""}` : "",
    assignee === "none" ? "担当なし" : assignee !== "all" ? `担当:${assignee}` : "",
    domain !== "all" ? domain : "",
  ]
    .filter(Boolean)
    .join("／");

  // チームのペース: 数え方（見積もり／件数）。選んだことがなければ、見積もりのある Issue があるときは見積もり
  const hasEstimates = useMemo(() => all.some((i) => estimateOf(i) !== null), [all]);
  const [chosenMode, setChosenMode] = useState<PaceMode | null>(() => {
    try {
      const v = localStorage.getItem(MODE_STORE);
      return v === "estimate" || v === "count" ? v : null;
    } catch {
      return null;
    }
  });
  const mode: PaceMode = chosenMode ?? (hasEstimates ? "estimate" : "count");
  function changeMode(m: PaceMode) {
    setChosenMode(m);
    try {
      localStorage.setItem(MODE_STORE, m);
    } catch {
      // 覚えられなくても、今は切り替わる
    }
  }
  const entries = useMemo(() => velocity(issues, closedIssues, mode, unit), [issues, closedIssues, mode, unit]);
  const finished = useMemo(() => finishedMilestones(issues, closedIssues), [issues, closedIssues]);

  return (
    <div className="content insights">
      <div className="toolbar insights-filters">
        <select className="select-sm" value={milestone} onChange={(e) => change({ milestone: e.target.value })} aria-label="マイルストーン">
          <option value="all">マイルストーン: 全て</option>
          {milestones.map((m) => (
            <option key={m.number} value={String(m.number)}>マイルストーン: {m.title}</option>
          ))}
          <option value="none">マイルストーンなし</option>
        </select>
        <select className="select-sm" value={assignee} onChange={(e) => change({ assignee: e.target.value })} aria-label="担当">
          <option value="all">担当: 全員</option>
          {collaborators.map((c) => (
            <option key={c.login} value={c.login}>担当: {c.login}</option>
          ))}
          <option value="none">担当なし</option>
        </select>
        {domains.length > 0 && (
          <select className="select-sm" value={domain} onChange={(e) => change({ domain: e.target.value })} aria-label="セクション">
            <option value="all">セクション: 全て</option>
            {domains.map((d) => (
              <option key={d} value={d}>{sectionOf(d)}</option>
            ))}
          </select>
        )}
        {(milestone !== "all" || assignee !== "all" || domain !== "all") && (
          <button type="button" className="link-button" onClick={() => change(ALL)}>絞り込みを外す</button>
        )}
      </div>

      <AnalyticsPanel scope={scope} scopeText={scopeText} stateOrder={stateOrder} onSelectIssue={onSelectIssue} title="📈 いまの状況" foldable={false} />

      {all.length > 0 && (
        <TeamPace owner={owner} repo={repo} entries={entries} finishedCount={finished.size} closedIssues={closedIssues}
          mode={mode} onModeChange={changeMode} onListTimeline={onListTimeline} onSelectIssue={onSelectIssue} />
      )}
    </div>
  );
}

