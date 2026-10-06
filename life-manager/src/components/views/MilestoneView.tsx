import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { motionOn } from "../../lib/motion";
import type { GitHubIssue, GitHubMilestone } from "../../lib/types";
import { TicketCard } from "../common/TicketCard";
import { DatePickerButton } from "../common/DatePickerButton";
import { SamplePlanDialog } from "../milestones/SamplePlanDialog";
import { Burndown } from "../common/Burndown";
import { estimateOf, formatEstimate, formatNumber, type EstimateUnit } from "../../lib/estimate";
import {
  average, dayOfDate, dayOfTime, descriptionText, finishedMilestones, velocity, weightOf, withStartDate, writtenStartDate, type PaceMode,
} from "../../lib/sprint";
import { useEstimateUnit } from "../common/EstimateChip";
import {
  buildStages, clearDetailOf, daysLeftText, defaultStage, formatAmount, markCelebrated, stageTeam, wasCelebrated,
  type MilestoneBar, type Stage,
} from "../../lib/milestoneStage";
import { celebrateMilestone } from "../../lib/celebrate";
import { StageArt } from "../milestones/StageArt";
import { StageMeter } from "../milestones/StageMeter";
import { tr, trx } from "../../lib/i18n";

interface MilestoneViewProps {
  milestones: GitHubMilestone[];
  issues: GitHubIssue[];
  closedIssues: GitHubIssue[];
  onCreateMilestone: (title: string, description: string, dueOn: string | null) => Promise<number | null>;
  /** 見本の計画のタスクを作る（#239） */
  onCreateIssue: (title: string, body: string, labels: string[], milestone: number | null) => Promise<number>;
  onUpdateMilestone: (milestoneNumber: number, updates: { title?: string; description?: string; dueOn?: string | null }) => Promise<void>;
  onCloseMilestone: (milestoneNumber: number) => Promise<void>;
  onReopenMilestone: (milestoneNumber: number) => Promise<void>;
  onRefresh: () => Promise<void>;
  onSelectIssue: (n: number) => void;
  /** 「owner/repo」（前に見たときの量・お祝いを覚える） */
  repoKey: string;
  /** クエストのテーマ（マイルストーン＝ボス） */
  quest: boolean;
  /** 進み具合のバー（設定 → 表示） */
  bar: MilestoneBar;
  /** 「📊 ボードでタスクを足す」: そのマイルストーンで絞ったボードを開く（「＋ ここにタスクを追加」で足すと、そのマイルストーンに入る） */
  onAddOnBoard: (milestoneNumber: number) => void;
}

/** 量の数え方（見積もり／件数）。次に開いたときも同じ */
const MODE_STORE = "pace-mode";

/** YYYY-MM-DD → 「9/28」 */
function md(date: string): string {
  const [, m, d] = date.split("-").map(Number);
  return `${m}/${d}`;
}

/** 期間の書き方（「9/24〜10/7」「〜10/21」） */
function rangeText(stage: Stage): string {
  const { start, end } = stage.range;
  if (start && end) return `${md(start)}〜${md(end)}`;
  return end ? `〜${md(end)}` : tr("期限なし");
}

/** 見出しの小さな字（STAGE 3・BOSS 3・GOAL・LAST BOSS） */
function kickerOf(stage: Stage, quest: boolean): string {
  if (quest) return stage.last ? "LAST BOSS" : `BOSS ${stage.no}`;
  return stage.last ? "GOAL" : `STAGE ${stage.no}`;
}

function Face({ login, url }: { login: string; url: string }) {
  return url ? <img className="ms-face" src={url} alt="" title={login} /> : <span className="ms-face" title={login}>{login.slice(0, 1).toUpperCase()}</span>;
}

/** 入力中・重ねて出している画面があるときは、← → を画面の移動に使わない */
function keysBusy(e: KeyboardEvent): boolean {
  const t = e.target as HTMLElement | null;
  if (t && (t.closest("input, textarea, select, [contenteditable='true']") || t.isContentEditable)) return true;
  return !!document.querySelector(".modal-content, .picker, .ms-cel, .palette-overlay");
}

/**
 * マイルストーンの画面（ゲームのステージセレクトのように）。上に、時間の順に並んだ道と、選んでいるマイルストーンの大きなパネル
 * （左右にとなりを小さく。← → か、道の印・となりを押して移る）。下に、そのマイルストーンのタスク。
 * クエストでは、マイルストーン＝ボス（絵・倒したら「撃破」）。進み具合は、設定で HP（減る）か達成率（のびる）。
 * ふと見たときに、前に見たときの量から今の量までバーが動く（HP なら減った分が飛ぶ）
 */
export function MilestoneView({
  milestones, issues, closedIssues, onCreateMilestone, onCreateIssue, onUpdateMilestone, onCloseMilestone, onReopenMilestone, onRefresh, onSelectIssue,
  repoKey, quest, bar, onAddOnBoard,
}: MilestoneViewProps) {
  const unit = useEstimateUnit();
  const hp = bar === "hp" || (bar === "auto" && quest);
  const [showForm, setShowForm] = useState(false);
  const [msTitle, setMsTitle] = useState("");
  // 見本の計画から作る（#239）
  const [planOpen, setPlanOpen] = useState(false);
  const [msDesc, setMsDesc] = useState("");
  const [msStart, setMsStart] = useState("");
  const [msDue, setMsDue] = useState("");
  const [editing, setEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editDesc, setEditDesc] = useState("");
  const [editStart, setEditStart] = useState("");
  const [editDue, setEditDue] = useState("");
  const [confirmClose, setConfirmClose] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showBurndown, setShowBurndown] = useState(false);
  // 選んでいるマイルストーン（番号）と、移った向き（パネルが入ってくる向き）
  const [picked, setPicked] = useState<number | null>(null);
  const [dir, setDir] = useState<"next" | "prev" | null>(null);
  // 作ったマイルストーン（名前）。読み直して道に出たら、それを選ぶ（すぐ「📊 ボードでタスクを足す」へ進めるように）
  const [justMade, setJustMade] = useState<string | null>(null);

  // 数え方: 選んだことがあればそれ、なければ見積もりのある Issue があるときは見積もり
  const hasEstimates = useMemo(() => [...issues, ...closedIssues].some((i) => estimateOf(i) !== null), [issues, closedIssues]);
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

  const stages = useMemo(() => buildStages(milestones, issues, closedIssues, mode, unit), [milestones, issues, closedIssues, mode, unit]);
  const at = useMemo(() => {
    const i = picked === null ? -1 : stages.findIndex((s) => s.ms.number === picked);
    return i >= 0 ? i : defaultStage(stages);
  }, [stages, picked]);
  const stage: Stage | undefined = stages[at];
  const prev = stages[at - 1];
  const next = stages[at + 1];

  // 最近のペース（終わったマイルストーンで終えた量の平均）。まだ終わっていないマイルストーンで、入れた量と比べる
  const entries = useMemo(() => velocity(issues, closedIssues, mode, unit), [issues, closedIssues, mode, unit]);
  const avg = average(entries.map((e) => (mode === "count" ? e.closedCount : e.done)));
  const finished = useMemo(() => finishedMilestones(issues, closedIssues), [issues, closedIssues]);
  const fmtMode = (v: number) => (mode === "count" ? tr("{formatNumber} 件", { formatNumber: formatNumber(v) }) : formatEstimate(Math.round(v * 10) / 10, unit));
  // 入れた量（画面の数え方で）。まだ終わっていないマイルストーンは、最近のペースと比べる
  const planned = stage ? [...stage.open, ...stage.done].reduce((sum, i) => sum + weightOf(i, mode, unit), 0) : 0;
  const compare = stage && avg !== null && !finished.has(stage.ms.number) && stage.total > 0;

  useEffect(() => {
    if (!justMade) return;
    const made = stages.filter((s) => s.ms.title === justMade).sort((a, b) => b.ms.number - a.ms.number)[0];
    if (!made) return;
    setDir("next");
    setPicked(made.ms.number);
    setJustMade(null);
  }, [stages, justMade]);

  const go = useCallback(
    (to: number) => {
      const s = stages[to];
      if (!s || to === at) return;
      setDir(to > at ? "next" : "prev");
      setPicked(s.ms.number);
      setEditing(false);
      setConfirmClose(false);
    },
    [stages, at],
  );

  // ← → でマイルストーンを移る
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.ctrlKey || e.metaKey || e.altKey || keysBusy(e)) return;
      if (e.key === "ArrowLeft") {
        e.preventDefault();
        go(at - 1);
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        go(at + 1);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [go, at]);

  async function handleCreate() {
    if (!msTitle.trim()) return;
    const dueOn = msDue ? msDue + "T00:00:00Z" : null;
    await onCreateMilestone(msTitle, withStartDate(msDesc, msStart || null), dueOn);
    setJustMade(msTitle);
    setMsTitle("");
    setMsDesc("");
    setMsStart("");
    setMsDue("");
    setShowForm(false);
  }

  function startEditing(ms: GitHubMilestone) {
    setEditing(true);
    setConfirmClose(false);
    setEditTitle(ms.title);
    setEditDesc(descriptionText(ms.description));
    setEditStart(writtenStartDate(ms.description) ?? "");
    setEditDue(ms.due_on ? ms.due_on.substring(0, 10) : "");
  }

  async function handleSaveEdit(milestoneNumber: number) {
    if (!editTitle.trim()) return;
    await onUpdateMilestone(milestoneNumber, {
      title: editTitle,
      description: withStartDate(editDesc, editStart || null),
      dueOn: editDue ? editDue + "T00:00:00Z" : null,
    });
    setEditing(false);
  }

  // 完了（GitHub でマイルストーンを閉じる）→ タスクを全部終えていて、まだ祝っていなければ、大きく祝う
  async function closeNow(s: Stage) {
    setBusy(true);
    try {
      await onCloseMilestone(s.ms.number);
      setConfirmClose(false);
      if (s.open.length === 0 && s.done.length > 0 && !wasCelebrated(repoKey, s.ms.number)) {
        markCelebrated(repoKey, s.ms.number);
        celebrateMilestone(clearDetailOf(s, repoKey, unit, false));
      }
    } finally {
      setBusy(false);
    }
  }

  async function reopen(s: Stage) {
    setBusy(true);
    try {
      await onReopenMilestone(s.ms.number);
    } finally {
      setBusy(false);
    }
  }

  const createForm = showForm && (
    <div className="form-card">
      <input value={msTitle} onChange={(e) => setMsTitle(e.target.value)} placeholder={quest ? tr("ボスの名前（マイルストーン名）") : tr("マイルストーン名")} className="input-full" />
      <input value={msDesc} onChange={(e) => setMsDesc(e.target.value)} placeholder={tr("説明")} className="input-full" />
      <div className="ms-dates">
        <DatePickerButton value={msStart} onChange={setMsStart} label={msStart ? tr("開始 {msStart}", { msStart }) : tr("開始日を選択（スプリントの始まり）")} />
        <DatePickerButton value={msDue} onChange={setMsDue} label={msDue || tr("期限を選択")} />
      </div>
      <button onClick={handleCreate} className="btn-primary">{tr("作成")}</button>
    </div>
  );

  return (
    <div className="content ms-view">
      <div className="toolbar">
        <button onClick={() => setShowForm(!showForm)} className="btn-sm">
          {showForm ? "×" : quest ? tr("+ ボスを置く") : tr("+ マイルストーン")}
        </button>
        <button type="button" onClick={() => setPlanOpen(true)} className="btn-sm">
          {tr("📋 見本の計画から作る…")}
        </button>
        <button onClick={onRefresh} className="btn-sm">{tr("更新")}</button>
        {(issues.length > 0 || closedIssues.length > 0) && (
          <span className="pace-mode ms-mode" role="group" aria-label={tr("数え方")} title={tr("バーと目安を見積もりで数えるか件数で数えるか（オーバービューのチームのペースと同じ）")}>
            {(["estimate", "count"] as PaceMode[]).map((m) => (
              <button key={m} type="button" className={mode === m ? "on" : ""} aria-pressed={mode === m} onClick={() => changeMode(m)}>
                {m === "estimate" ? tr("見積もり") : tr("件数")}
              </button>
            ))}
          </span>
        )}
      </div>
      {createForm}
      {planOpen && (
        <SamplePlanDialog milestones={milestones} onCreateMilestone={onCreateMilestone} onCreateIssue={onCreateIssue} onClose={() => setPlanOpen(false)} />
      )}

      {!stage ? (
        <div className={`ms-select ms-empty${quest ? " quest" : ""}`}>
          <p>{quest ? tr("まだボスがいません。") : tr("まだマイルストーンがありません。")}</p>
          {!showForm && (
            <div className="ms-empty-actions">
              <button type="button" className="btn-primary" onClick={() => setShowForm(true)}>
                {quest ? tr("+ 最初のボスを置く") : tr("+ 最初のマイルストーンを作る")}
              </button>
              <button type="button" className="btn-sm" onClick={() => setPlanOpen(true)}>
                {tr("📋 見本の計画から作る…")}
              </button>
            </div>
          )}
        </div>
      ) : (
        <>
          <div className={`ms-select${quest ? " quest" : ""}`}>
            {prev && <SidePanel stage={prev} side="l" quest={quest} onPick={() => go(at - 1)} />}
            <MainPanel
              key={stage.ms.number}
              stage={stage}
              dir={dir}
              quest={quest}
              hp={hp}
              repoKey={repoKey}
              unit={unit}
              paceText={compare && avg !== null ? tr("目安 {fmtMode} に対して {fmtMode2}", { fmtMode: fmtMode(avg), fmtMode2: fmtMode(planned) }) : null}
              over={!!compare && avg !== null && planned > avg * 1.1}
            />
            {next && <SidePanel stage={next} side="r" quest={quest} onPick={() => go(at + 1)} />}
            <button type="button" className="ms-arrow l" onClick={() => go(at - 1)} disabled={!prev} aria-label={tr("前のマイルストーン")} title={tr("前へ（←）")}>‹</button>
            <button type="button" className="ms-arrow r" onClick={() => go(at + 1)} disabled={!next} aria-label={tr("次のマイルストーン")} title={tr("次へ（→）")}>›</button>
            <Road stages={stages} at={at} quest={quest} onPick={go} />
          </div>

          <div className="ms-tasks">
            <div className="ms-tasks-head">
              <b>{quest ? tr("のこりのタスク {length}", { length: stage.open.length }) : tr("残り {length}", { length: stage.open.length })}</b>
              <span>{quest ? tr("倒したタスク {length}", { length: stage.done.length }) : tr("終わった {length}", { length: stage.done.length })}</span>
              <span className="grow" />
              {!stage.closed && (
                <button type="button" className="btn-sm ms-to-board" onClick={() => onAddOnBoard(stage.ms.number)} title={tr("このマイルストーンのタスクを表示したボードを開きます。「＋ ここにタスクを追加」で足したタスクは、このマイルストーンに入ります")}>
                  {tr("📊 ボードでタスクを足す")}
                </button>
              )}
              {stage.range.start && stage.total > 0 && (
                <button type="button" className={`btn-sm${showBurndown ? " on" : ""}`} aria-pressed={showBurndown} onClick={() => setShowBurndown(!showBurndown)}>
                  {tr("📉 バーンダウン")}
                </button>
              )}
              <button type="button" className="btn-sm" onClick={() => (editing ? setEditing(false) : startEditing(stage.ms))}>
                {editing ? tr("編集をやめる") : tr("編集")}
              </button>
              {stage.closed ? (
                <button type="button" className="btn-sm" disabled={busy} onClick={() => reopen(stage)}>{tr("再開")}</button>
              ) : (
                <button type="button" className="btn-primary ms-close" disabled={busy} onClick={() => setConfirmClose(true)}>{tr("完了")}</button>
              )}
            </div>
            {confirmClose && !stage.closed && (
              <div className="ms-confirm">
                {trx("「{title}」を完了にします（GitHub のマイルストーンを閉じます）。", { title: stage.ms.title })}
                {stage.open.length > 0 && tr(" まだ {length} 件のタスクが残っています（タスクはそのまま残ります）。", { length: stage.open.length })}
                <span className="ms-confirm-actions">
                  <button type="button" className="btn-primary" disabled={busy} onClick={() => closeNow(stage)}>{tr("完了にする")}</button>
                  <button type="button" className="btn-sm" onClick={() => setConfirmClose(false)}>{tr("やめる")}</button>
                </span>
              </div>
            )}
            {editing && (
              <div className="form-card ms-edit">
                <input value={editTitle} onChange={(e) => setEditTitle(e.target.value)} placeholder={tr("マイルストーン名")} className="input-full" />
                <input value={editDesc} onChange={(e) => setEditDesc(e.target.value)} placeholder={tr("説明")} className="input-full" />
                <div className="ms-dates">
                  <DatePickerButton value={editStart} onChange={setEditStart} label={editStart ? tr("開始 {editStart}", { editStart }) : tr("開始日を選択（決めなければ作った日）")} />
                  <DatePickerButton value={editDue} onChange={setEditDue} label={editDue || tr("期限を選択")} />
                </div>
                <div className="ms-confirm-actions">
                  <button className="btn-primary" onClick={() => handleSaveEdit(stage.ms.number)}>{tr("保存")}</button>
                  <button className="btn-sm" onClick={() => setEditing(false)}>{tr("キャンセル")}</button>
                </div>
              </div>
            )}
            {showBurndown && stage.range.start && stage.total > 0 && (
              <Burndown start={stage.range.start} end={stage.range.end} issues={[...stage.open, ...stage.done]} mode={mode} />
            )}
            <div className="ms-grid">
              {stage.open.map((i) => <TicketCard key={i.number} issue={i} onSelect={onSelectIssue} />)}
            </div>
            {stage.done.length > 0 && (
              <>
                <p className="ms-done-label">{quest ? tr("倒したタスク（{length}）", { length: stage.done.length }) : tr("終わったタスク（{length}）", { length: stage.done.length })}</p>
                <div className="ms-grid ms-grid-done">
                  {stage.done.map((i) => <TicketCard key={i.number} issue={i} onSelect={onSelectIssue} />)}
                </div>
              </>
            )}
            {stage.open.length === 0 && stage.done.length === 0 && (
              <p className="ms-none">{tr("このマイルストーンに入れたタスクはありません。")}</p>
            )}
          </div>
        </>
      )}
    </div>
  );
}

interface MainPanelProps {
  stage: Stage;
  dir: "next" | "prev" | null;
  quest: boolean;
  hp: boolean;
  repoKey: string;
  unit: EstimateUnit;
  /** 最近のペースとの比べ（「目安 21pt に対して 23pt」。終わったマイルストーンは null） */
  paceText: string | null;
  over: boolean;
}

/** 選んでいるマイルストーンの大きなパネル */
function MainPanel({ stage, dir, quest, hp, repoKey, unit, paceText, over }: MainPanelProps) {
  // HP が減った回数（ボスを揺らす）
  const [hit, setHit] = useState(0);
  const fmt = (v: number) => formatAmount(v, stage.measure, unit);
  const percent = stage.total > 0 ? Math.round(((stage.total - stage.remaining) / stage.total) * 100) : 0;
  const days = daysLeftText(stage);
  const desc = descriptionText(stage.ms.description).split("\n")[0];
  const team = stageTeam(stage);
  const done = stage.total - stage.remaining;
  return (
    <div className={`ms-panel main${dir ? ` from-${dir}` : ""}${stage.cleared ? " cleared" : ""}`}>
      <div className={`ms-art${quest && stage.cleared ? " defeated" : ""}`}>
        <div key={hit} className={hit > 0 ? "ms-art-inner hit" : "ms-art-inner"}>
          <StageArt no={stage.no} last={stage.last} quest={quest} />
        </div>
        {stage.cleared && quest && <span className="ms-gekiha">{tr("撃破")}</span>}
      </div>
      <div className="ms-info">
        <div className="ms-kick">
          {kickerOf(stage, quest)}
          <span>{rangeText(stage)}{days ? tr(" ・ {days}", { days }) : ""}</span>
          {stage.cleared && !quest && <span className="ms-clear">CLEAR {"★".repeat(stage.stars)}</span>}
        </div>
        <h2 className="ms-name">{stage.ms.title}</h2>
        {desc && <p className="ms-desc">{quest ? `── ${desc}` : desc}</p>}
        <div className="ms-meter-label">
          {hp ? (
            <>
              <span className="ms-hp-tag">HP</span>
              <b>{fmt(stage.remaining)}</b>
              <span>/ {fmt(stage.total)}</span>
            </>
          ) : (
            <>
              <b>{percent}%</b>
              <span>
                {stage.measure === "estimate"
                  ? tr("{done} / {n} 件 ・ {fmt} / {fmt2}", { done: stage.done.length, n: stage.done.length + stage.open.length, fmt: fmt(done), fmt2: fmt(stage.total) })
                  : tr("{done} / {n} 件", { done: stage.done.length, n: stage.done.length + stage.open.length })}
              </span>
            </>
          )}
          <span className="grow" />
          <span>{stage.cleared ? (quest ? tr("倒した！") : tr("ぜんぶ終えました")) : quest ? tr("倒すまで 残り {length} 件", { length: stage.open.length }) : tr("残り {length} 件", { length: stage.open.length })}</span>
        </div>
        <StageMeter seenKey={`${repoKey}#${stage.ms.number}#${stage.measure}`} remaining={stage.remaining} total={stage.total} hp={hp} fmt={fmt} onHit={() => setHit((h) => h + 1)} />
        <div className="ms-facts">
          {hp && done > 0 && <span>{quest ? tr("与えたダメージ") : tr("終えた量")} <b>{fmt(done)}</b></span>}
          {paceText && <span className={over ? "over" : ""} title={tr("最近のマイルストーンで終えた量の平均（チームのペース）と比べています")}>{paceText}</span>}
        </div>
        {team.length > 0 && (
          <div className="ms-party">
            {quest ? tr("パーティ") : tr("チーム")}
            {team.map((u) => <Face key={u.login} login={u.login} url={u.avatar_url} />)}
          </div>
        )}
      </div>
    </div>
  );
}

/** となりのマイルストーン（小さく。押すと移る） */
function SidePanel({ stage, side, quest, onPick }: { stage: Stage; side: "l" | "r"; quest: boolean; onPick: () => void }) {
  return (
    <button type="button" className={`ms-panel side ${side}${stage.cleared ? " cleared" : ""}`} onClick={onPick} title={tr("{title} へ", { title: stage.ms.title })} tabIndex={-1}>
      <span className={`ms-art${quest && stage.cleared ? " defeated" : ""}`}>
        <span className="ms-art-inner"><StageArt no={stage.no} last={stage.last} quest={quest} /></span>
        {stage.cleared && quest && <span className="ms-gekiha">{tr("撃破")}</span>}
      </span>
      <span className="ms-info">
        <span className="ms-kick">
          {kickerOf(stage, quest)}
          {stage.cleared && !quest && <span className="ms-clear">CLEAR</span>}
        </span>
        <span className="ms-name">{stage.ms.title}</span>
        {stage.cleared && !quest ? <span className="ms-stars">{"★".repeat(stage.stars)}</span> : <span className="ms-side-range">{rangeText(stage)}</span>}
      </span>
    </button>
  );
}

/** 道（時間の順の印。今日の線も） */
function Road({ stages, at, quest, onPick }: { stages: Stage[]; at: number; quest: boolean; onPick: (i: number) => void }) {
  const n = stages.length;
  const pos = (i: number) => `${((i + 0.5) / n) * 100}%`;
  // 道が窓より長いとき（マイルストーンが多い・窓がせまい）: 選んでいる印が、いつも道のまん中あたりに見えるよう、道を動かす
  // （← → や となりのパネルで移ったときも、スクロールバーがついてくる。はじめに開いたときは、すぐその場所へ）
  const wrapRef = useRef<HTMLDivElement>(null);
  const shown = useRef(false);
  useEffect(() => {
    const wrap = wrapRef.current;
    const road = wrap?.firstElementChild as HTMLElement | null;
    if (!wrap || !road || n === 0) return;
    const left = Math.max(0, road.scrollWidth * ((at + 0.5) / n) - wrap.clientWidth / 2);
    wrap.scrollTo({ left, behavior: shown.current && motionOn() ? "smooth" : "auto" });
    shown.current = true;
  }, [at, n]);
  // 今日の線: 期限が今日をはさむ 2 つの印のあいだ（期限の日の割合で）
  const today = dayOfTime(new Date());
  let todayAt: string | null = null;
  for (let i = 0; i < n - 1; i++) {
    const a = stages[i].range.end;
    const b = stages[i + 1].range.end;
    if (!a || !b) continue;
    const da = dayOfDate(a);
    const db = dayOfDate(b);
    if (da <= today && today < db) {
      todayAt = `${((i + 0.5 + (today - da) / Math.max(1, db - da)) / n) * 100}%`;
      break;
    }
  }
  return (
    <div className="ms-road-wrap" ref={wrapRef}>
      <div className="ms-road" style={{ minWidth: n * 90 }}>
        <div className="ms-road-line" />
        {todayAt && <span className="ms-today" style={{ left: todayAt }}><b>{tr("今日")}</b></span>}
        {stages.map((s, i) => (
          <button key={s.ms.number} type="button" className={`ms-node${i === at ? " on" : ""}${s.cleared ? " done" : ""}${s.last ? " goal" : ""}`}
            style={{ left: pos(i) }} onClick={() => onPick(i)} title={`${s.ms.title}（${rangeText(s)}）`} aria-current={i === at ? "true" : undefined}>
            {s.cleared ? (quest ? "💀" : "★") : s.last ? (quest ? "🏰" : "🚩") : s.no}
          </button>
        ))}
        <span className="ms-pointer" style={{ left: pos(at) }} aria-hidden="true" />
        {stages.map((s, i) => (
          <span key={`d${s.ms.number}`} className={`ms-node-date${i === at ? " on" : ""}`} style={{ left: pos(i) }}>
            {s.range.end ? `〜${md(s.range.end)}` : tr("期限なし")}
          </span>
        ))}
      </div>
    </div>
  );
}
