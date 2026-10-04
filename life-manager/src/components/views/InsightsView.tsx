import { useMemo, useState } from "react";
import type { GitHubIssue, GitHubLabel, GitHubMilestone, GitHubUser, TimelineEvent } from "../../lib/types";
import { AnalyticsPanel } from "../common/AnalyticsPanel";
import { TeamPace } from "../common/TeamPace";
import { MemberNow } from "../common/MemberNow";
import type { ActivityEvent } from "../../lib/activity";
import { useEstimateUnit } from "../common/EstimateChip";
import { estimateOf } from "../../lib/estimate";
import { finishedMilestones, velocity, type PaceMode } from "../../lib/sprint";
import { isSectionLabel, sectionOf } from "../../lib/section";
import { MobileSheet } from "../common/MobileSheet";
import { isMobile } from "../../lib/platform";
import { tr, trx } from "../../lib/i18n";

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
  /** 小さく出す（スマホのメニュー。タスクの数の 4 つと状態の帯だけ。チームのペースは出さない。#212） */
  compact?: boolean;
  /** 「くわしく」を押したとき（全部の中身の画面を開く） */
  onMore?: () => void;
  /** チームの動き（メンバーの「今」の、最後に動いた時刻。#236）。まだ読めていなければ null */
  events?: ActivityEvent[] | null;
  /** 自分（メンバーの「今」で先に出す） */
  me?: string;
  /** メンバーの「今」で人を押したとき（#246） */
  onSelectMember?: (login: string) => void;
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
 * オーバービュー（サイドバーのタスクの一番上）。タスクの数（開いている数・期限切れ・もうすぐ・担当なし、状態ごと・担当ごと、
 * 8 週の作った数と閉じた数）と、チームのペース（ベロシティ・サイクルタイム）を 1 つの画面で見る。
 * タスクの数は、上のマイルストーン・担当・セクションで絞れる（チームのペースは、リポジトリ全体）
 */
export function InsightsView({ issues, closedIssues, milestones, labels, collaborators, owner, repo, stateOrder, onSelectIssue, onListTimeline, compact = false, onMore, events = null, me = "", onSelectMember }: InsightsViewProps) {
  const unit = useEstimateUnit();
  const [filters, setFilters] = useState<Filters>(loadFilters);
  // スマホの、下から出る絞り込みの板
  const [sheetOpen, setSheetOpen] = useState(false);

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
    milestone === "none" ? tr("マイルストーンなし") : milestone !== "all" ? tr("マイルストーン {v}", { v: milestones.find((m) => String(m.number) === milestone)?.title ?? "" }) : "",
    assignee === "none" ? tr("担当なし") : assignee !== "all" ? tr("担当 {assignee}", { assignee }) : "",
    domain !== "all" ? sectionOf(domain) : "",
  ]
    .filter(Boolean)
    .join("、");

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

  // マイルストーン・担当・セクションを選ぶ欄（PC は上の段、スマホは下から出る板）
  const filterSelects = (
    <>
      <select className="select-sm" value={milestone} onChange={(e) => change({ milestone: e.target.value })} aria-label={tr("マイルストーン")}>
        <option value="all">{tr("マイルストーン: 全て")}</option>
        {milestones.map((m) => (
          <option key={m.number} value={String(m.number)}>{trx("マイルストーン: {title}", { title: m.title })}</option>
        ))}
        <option value="none">{tr("マイルストーンなし")}</option>
      </select>
      <select className="select-sm" value={assignee} onChange={(e) => change({ assignee: e.target.value })} aria-label={tr("担当")}>
        <option value="all">{tr("担当: 全員")}</option>
        {collaborators.map((c) => (
          <option key={c.login} value={c.login}>{trx("担当: {login}", { login: c.login })}</option>
        ))}
        <option value="none">{tr("担当なし")}</option>
      </select>
      {domains.length > 0 && (
        <select className="select-sm" value={domain} onChange={(e) => change({ domain: e.target.value })} aria-label={tr("セクション")}>
          <option value="all">{tr("セクション: 全て")}</option>
          {domains.map((d) => (
            <option key={d} value={d}>{sectionOf(d)}</option>
          ))}
        </select>
      )}
    </>
  );
  const activeFilters = (milestone !== "all" ? 1 : 0) + (assignee !== "all" ? 1 : 0) + (domain !== "all" ? 1 : 0);
  // スマホの上の段に出す、かけている条件
  const filterSummary = [
    milestone === "all" ? null : milestone === "none" ? tr("マイルストーンなし") : `🎯 ${milestones.find((m) => String(m.number) === milestone)?.title ?? milestone}`,
    assignee === "all" ? null : assignee === "none" ? tr("担当なし") : `👤 ${assignee}`,
    domain === "all" ? null : sectionOf(domain),
  ]
    .filter(Boolean)
    .join(tr(" ・ ")) || tr("すべて");

  // スマホの「絞り込み」と、かけている条件（小さく出すときは、見出しの横に置く）
  const mobileFilter = (
    <>
      <button type="button" className={`btn-sm m-filter-btn${activeFilters ? " on" : ""}`} onClick={() => setSheetOpen(true)}>
        {tr("表示するタスク")}{activeFilters > 0 && <span className="m-filter-n">{activeFilters}</span>}
      </button>
      <span className="insights-filter-summary">{filterSummary}</span>
    </>
  );

  return (
    <div className={`content insights${compact ? " insights--compact" : ""}`}>
      {compact ? null : isMobile ? (
        // スマホ（メニューの中）: 「絞り込み」と、かけている条件だけ。選ぶ欄は下から出る板に（#207）
        <div className="toolbar insights-filters m-compact">{mobileFilter}</div>
      ) : (
        <div className="toolbar insights-filters">
          {trx("<0>表示するタスク</0>{filterSelects}", { filterSelects }, [<span className="insights-filter-label" />])}
          {(milestone !== "all" || assignee !== "all" || domain !== "all") && (
            <button type="button" className="link-button" onClick={() => change(ALL)}>{tr("すべて表示する")}</button>
          )}
        </div>
      )}
      {isMobile && (
        <MobileSheet
          open={sheetOpen}
          title={tr("表示するタスク")}
          onClose={() => setSheetOpen(false)}
          footer={
            <>
              <button type="button" className="btn-sm" disabled={!activeFilters} onClick={() => change(ALL)}>{tr("すべて外す")}</button>
              <button type="button" className="btn-primary" onClick={() => setSheetOpen(false)}>{tr("閉じる")}</button>
            </>
          }
        >
          <div className="m-sheet-row m-sheet-ctrl insights-sheet">{filterSelects}</div>
        </MobileSheet>
      )}

      <AnalyticsPanel scope={scope} scopeText={scopeText} stateOrder={stateOrder} onSelectIssue={onSelectIssue}
        title={compact ? tr("📈 オーバービュー") : tr("📈 タスクの数")} foldable={false}
        compact={compact} headExtra={compact ? mobileFilter : undefined} onMore={onMore} />

      {!compact && <MemberNow members={collaborators} issues={issues} events={events} me={me} onSelectIssue={onSelectIssue} onSelectMember={onSelectMember} />}

      {!compact && all.length > 0 && (
        <TeamPace owner={owner} repo={repo} entries={entries} finishedCount={finished.size} closedIssues={closedIssues}
          mode={mode} onModeChange={changeMode} onListTimeline={onListTimeline} onSelectIssue={onSelectIssue} />
      )}
    </div>
  );
}

