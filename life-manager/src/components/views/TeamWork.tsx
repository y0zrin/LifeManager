import { useEffect, useRef, useState } from "react";
import type { GitHubUser } from "../../lib/types";
import { Avatar } from "../common/Avatar";
import { TEAM_PARTS, crossedStep, fillMissing, fmt, loadTeamSeen, roadOf, saveTeamSeen, sumTotals, teamTotals, type TeamSeen, type TeamTotals } from "../../lib/teamWork";

interface TeamWorkProps {
  owner: string;
  repo: string;
  /** チームの人（顔だけ出す。人ごとの数は出さない） */
  team: GitHubUser[];
  /** 画面の動きが「ふつう」か（少なめなら、数えあがらずに出す） */
  motion: boolean;
}

/** 「9/29」 */
const md = (iso: string) => {
  const d = new Date(iso);
  return `${d.getMonth() + 1}/${d.getDate()}`;
};

/**
 * ヒストリーのいちばん上の「チームの仕事」: これまでの合計（減らない数）を大きく。しっかり・静かに・達成感を。
 * 開いたとき、前に見た数から今の数へ静かに数えあがり、「前に見たときから +12」を添える。次の節目までの細い道を、光る点が進む。
 * 節目に届いたときだけ、数字の上を光が 1 回すべり、「✦ 1,000 に届きました」と残す。人ごとの数は出さない（くらべない）
 */
export function TeamWork({ owner, repo, team, motion }: TeamWorkProps) {
  const key = `${owner}/${repo}`;
  // 開いたときの「前に見た数」（+12 と、数えあがるはじまり）
  const [seen] = useState<TeamSeen | null>(() => loadTeamSeen(key));
  const [totals, setTotals] = useState<TeamTotals | null>(seen?.parts ?? null);
  const [error, setError] = useState<string | null>(null);
  const [shown, setShown] = useState<number | null>(seen?.total ?? null);
  const [settled, setSettled] = useState(false);
  const [reached, setReached] = useState<number | null>(null);
  const raf = useRef(0);

  useEffect(() => {
    let alive = true;
    teamTotals(owner, repo)
      .then((t) => {
        if (!alive) return;
        setTotals(fillMissing(t, seen?.parts));
        setError(null);
      })
      .catch((e) => alive && setError(String(e)));
    return () => {
      alive = false;
    };
  }, [owner, repo]);

  const total = totals ? sumTotals(totals) : null;

  // 前に見た数から今の数へ、静かに数えあがる（1 秒）。届いた節目があれば、ひとこと残す。見た数を覚える
  useEffect(() => {
    if (total === null || !totals) return;
    const from = seen?.total ?? total;
    const still = !motion || window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (from >= total || still) {
      setShown(total);
      setSettled(true);
    } else {
      const start = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / 1000);
        const eased = 1 - Math.pow(1 - p, 3);
        setShown(Math.round(from + (total - from) * eased));
        if (p < 1) raf.current = requestAnimationFrame(step);
        else setSettled(true);
      };
      raf.current = requestAnimationFrame(step);
    }
    if (seen) setReached(crossedStep(seen.total, total));
    // 読めなかった数が残っている（前に見た数もない）ときは、覚えない（次に全部読めたとき、まちがった「+」にしない）
    if (!TEAM_PARTS.some((p) => totals[p.key] === null)) saveTeamSeen(key, { total, at: new Date().toISOString(), parts: totals });
    return () => cancelAnimationFrame(raf.current);
    // 読めた数が変わったときだけ（前に見た数は、開いたときのもの）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [total]);

  if (total === null) {
    return (
      <section className="tw">
        <div className="tw-head">
          <span className="tw-title">チームの仕事</span>
          <span className="tw-sub">{error ? `読めませんでした（${error}）` : "数えています…"}</span>
        </div>
      </section>
    );
  }

  const now = shown ?? total;
  const road = roadOf(now);
  const pct = Math.max(0, Math.min(100, ((now - road.from) / (road.to - road.from)) * 100));
  const delta = seen ? total - seen.total : 0;
  const faces = team.slice(0, 5);

  return (
    <section className={`tw${reached && settled ? " reached" : ""}`} aria-label={`チームの仕事 これまでの合計 ${fmt(total)} 件`}>
      <div className="tw-head">
        <span className="tw-title">チームの仕事</span>
        <span className="tw-sub">これまでの合計</span>
        <span className="grow" />
        {faces.length > 0 && (
          <span className="tw-faces" title={team.map((u) => u.login).join("・")}>
            {faces.map((u) => (
              <Avatar key={u.login} login={u.login} url={u.avatar_url} className="avatar-sm" />
            ))}
            <small>{team.length} 人で</small>
          </span>
        )}
      </div>
      <div className="tw-body">
        <div>
          <div className="tw-lead">これまでに、チームで積み重ねたこと</div>
          <div className="tw-num">
            <b>{fmt(now)}</b>
            <span>件</span>
          </div>
          {settled && delta > 0 && (
            <div className="tw-delta">
              前に見たとき（{md(seen!.at)}）から <b>+{fmt(delta)}</b>
            </div>
          )}
          {settled && reached && (
            <div className="tw-reach">✦ {fmt(reached)} に届きました（{md(new Date().toISOString())}）</div>
          )}
        </div>
        <div className="tw-road">
          <div className="tw-road-top">
            <span>{fmt(road.from)}</span>
            <span>
              次の節目 <b>{fmt(road.to)}</b> まで あと <b>{fmt(Math.max(0, road.to - now))}</b>
            </span>
            <span>{fmt(road.to)}</span>
          </div>
          <div className="tw-bar">
            <i style={{ width: `${pct}%` }} />
          </div>
        </div>
      </div>
      <div className="tw-parts">
        {TEAM_PARTS.map((p) => (
          <span key={p.key} className="tw-part" title={totals?.[p.key] === null ? "読めませんでした" : undefined}>
            {p.icon} {p.label} <b>{totals?.[p.key] === null ? "—" : fmt(totals?.[p.key] ?? 0)}</b>
          </span>
        ))}
      </div>
    </section>
  );
}
