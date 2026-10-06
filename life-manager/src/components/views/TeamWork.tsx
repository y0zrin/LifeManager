import { useEffect, useRef, useState } from "react";
import type { GitHubUser } from "../../lib/types";
import { Avatar } from "../common/Avatar";
import { TEAM_PARTS, crossedStep, fillMissing, fmt, loadTeamSeen, roadOf, saveTeamSeen, sumTotals, teamTotals, type TeamSeen, type TeamTotals } from "../../lib/teamWork";
import { tr, trx } from "../../lib/i18n";

interface TeamWorkProps {
  owner: string;
  repo: string;
  /** チームの人（顔だけ出す。人ごとの数は出さない） */
  team: GitHubUser[];
  /** 画面の動きが「ふつう」か（少なめなら、数えあがらずに出す） */
  motion: boolean;
  /** 小さく出す（スマホのメニューのいちばん上。数と次の節目までの道だけ。#214） */
  compact?: boolean;
  /** 押したとき（スマホのメニューでは、ヒストリーを開く） */
  onOpen?: () => void;
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
export function TeamWork({ owner, repo, team, motion, compact = false, onOpen }: TeamWorkProps) {
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
      <section className={`tw${compact ? " tw--compact" : ""}`}>
        <div className="tw-head">
          <span className="tw-title">{tr("チームの仕事")}</span>
          <span className="tw-sub">{error ? tr("読めませんでした（{error}）", { error }) : tr("数えています…")}</span>
        </div>
      </section>
    );
  }

  const now = shown ?? total;
  const road = roadOf(now);
  const pct = Math.max(0, Math.min(100, ((now - road.from) / (road.to - road.from)) * 100));
  const delta = seen ? total - seen.total : 0;
  const faces = team.slice(0, 5);
  const facesNode = faces.length > 0 && (
    <span className="tw-faces" title={team.map((u) => u.login).join(tr("・"))}>
      {faces.map((u) => (
        <Avatar key={u.login} login={u.login} url={u.avatar_url} className="avatar-sm" />
      ))}
      <small>{trx("{length} 人で", { length: team.length })}</small>
    </span>
  );

  if (compact) {
    // スマホのメニュー: 見出し・数・前に見たときからの数・次の節目までの道を 3 段で。押すとヒストリー
    return (
      <button type="button" className={`tw tw--compact${reached && settled ? " reached" : ""}`} onClick={onOpen}
        aria-label={tr("チームの仕事 これまでの合計 {fmt} 件（押すとヒストリーを開きます）", { fmt: fmt(total) })}>
        <span className="tw-head">
          {trx("<0>チームの仕事</0><1>これまでの合計</1>", undefined, [<span className="tw-title" />, <span className="tw-sub" />])}
          <span className="grow" />
          {facesNode}
        </span>
        <span className="tw-cline">
          <span className="tw-num">
            {trx("<0>{fmt}</0><1>件</1>", { fmt: fmt(now) }, [<b />, <span />])}
          </span>
          {settled && delta > 0 && (
            <span className="tw-delta">
              {trx("前に見たときから <0>+{fmt}</0>", { fmt: fmt(delta) }, [<b />])}
            </span>
          )}
          <span className="grow" />
          <span className="tw-next">
            {trx("次の節目 <0>{fmt}</0> まで あと <1>{fmt2}</1>", { fmt: fmt(road.to), fmt2: fmt(Math.max(0, road.to - now)) }, [<b />, <b />])}
          </span>
        </span>
        <span className="tw-bar">
          <i style={{ width: `${pct}%` }} />
        </span>
      </button>
    );
  }

  return (
    <section className={`tw${reached && settled ? " reached" : ""}`} aria-label={tr("チームの仕事 これまでの合計 {fmt} 件", { fmt: fmt(total) })}>
      <div className="tw-head">
        {trx("<0>チームの仕事</0><1>これまでの合計</1>", undefined, [<span className="tw-title" />, <span className="tw-sub" />])}
        <span className="grow" />
        {facesNode}
      </div>
      <div className="tw-body">
        <div>
          <div className="tw-lead">{tr("これまでにチームで積み重ねたこと")}</div>
          <div className="tw-num">
            {trx("<0>{fmt}</0><1>件</1>", { fmt: fmt(now) }, [<b />, <span />])}
          </div>
          {settled && delta > 0 && (
            <div className="tw-delta">
              {trx("前に見たとき（{md}）から <0>+{fmt}</0>", { md: md(seen!.at), fmt: fmt(delta) }, [<b />])}
            </div>
          )}
          {settled && reached && (
            <div className="tw-reach">{trx("✦ {fmt} に届きました（{md}）", { fmt: fmt(reached), md: md(new Date().toISOString()) })}</div>
          )}
        </div>
        <div className="tw-road">
          <div className="tw-road-top">
            <span>{fmt(road.from)}</span>
            <span>
              {trx("次の節目 <0>{fmt}</0> まで あと <1>{fmt2}</1>", { fmt: fmt(road.to), fmt2: fmt(Math.max(0, road.to - now)) }, [<b />, <b />])}
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
          <span key={p.key} className="tw-part" title={totals?.[p.key] === null ? tr("読めませんでした") : undefined}>
            {p.icon} {p.label} <b>{totals?.[p.key] === null ? "—" : fmt(totals?.[p.key] ?? 0)}</b>
          </span>
        ))}
      </div>
    </section>
  );
}
