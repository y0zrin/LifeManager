import { tr } from "./i18n";
// 見本の計画（#239）: 新しいチームが 1 回で作れる、マイルストーン 5 つと、よくあるタスク。
// 中身はここだけに置く（1.1 のローカルだけの版でも、同じものを使う）

export type PlanSection = "プランナー" | "プログラマー" | "デザイナー" | "その他";

export interface PlanTask {
  title: string;
  section: PlanSection;
}

export interface PlanStage {
  title: string;
  /** 始めから数えて、この段の終わりまでに使う日の割合（最後は 1） */
  until: number;
  tasks: PlanTask[];
}

/** ゲームを作るチームの見本: 企画 → プロトタイプ → α版 → β版 → 発表 */
export const GAME_PLAN: PlanStage[] = [
  {
    title: tr("企画"),
    until: 0.15,
    tasks: [
      { title: tr("企画書を書く"), section: "プランナー" },
      { title: tr("ゲームのいちばんおもしろいところを決める"), section: "プランナー" },
      { title: tr("参考にするゲームを集めて遊ぶ"), section: "その他" },
      { title: tr("役割と担当を決める"), section: "その他" },
      { title: tr("絵の雰囲気を決める"), section: "デザイナー" },
      { title: tr("エンジンとリポジトリを用意する"), section: "プログラマー" },
    ],
  },
  {
    title: tr("プロトタイプ"),
    until: 0.35,
    tasks: [
      { title: tr("キャラクターを操作して動かせるようにする"), section: "プログラマー" },
      { title: tr("いちばんおもしろいところを仮の絵で遊べるようにする"), section: "プログラマー" },
      { title: tr("仮の絵と音を用意する"), section: "デザイナー" },
      { title: tr("テストプレイして、おもしろいかを確かめる"), section: "プランナー" },
    ],
  },
  {
    title: tr("α版"),
    until: 0.65,
    tasks: [
      { title: tr("主な機能をすべて入れる"), section: "プログラマー" },
      { title: tr("1 ステージを最初から最後まで遊べるようにする"), section: "プランナー" },
      { title: tr("本番の絵とアニメーションを作る"), section: "デザイナー" },
      { title: tr("タイトル画面とゲームオーバーを作る"), section: "プログラマー" },
      { title: tr("見つけた不具合を Issue にする"), section: "その他" },
    ],
  },
  {
    title: tr("β版"),
    until: 0.9,
    tasks: [
      { title: tr("すべての素材を入れる"), section: "デザイナー" },
      { title: tr("効果音と BGM を入れる"), section: "デザイナー" },
      { title: tr("難しさを調整する"), section: "プランナー" },
      { title: tr("不具合を直す"), section: "プログラマー" },
      { title: tr("ほかの人にテストプレイしてもらう"), section: "プランナー" },
    ],
  },
  {
    title: tr("発表"),
    until: 1,
    tasks: [
      { title: tr("発表の資料を作る"), section: "プランナー" },
      { title: tr("プレイ動画を撮る"), section: "デザイナー" },
      { title: tr("提出用のビルドを作る"), section: "プログラマー" },
      { title: tr("振り返りをする"), section: "その他" },
    ],
  },
];

/** タスクに付けるラベル */
export function planTaskLabels(task: PlanTask): string[] {
  return ["種別:イシュー", "状態:未着手", `セクション:${task.section}`];
}

const DAY = 86400000;

function parseDay(day: string): number {
  const [y, m, d] = day.split("-").map(Number);
  return Date.UTC(y, m - 1, d);
}

function formatDay(t: number): string {
  const d = new Date(t);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

/**
 * 始める日から発表の日までを、段ごとの割合で分ける（YYYY-MM-DD）。
 * 段の始まりは前の段の期限の次の日。最後の段の期限は発表の日。日が足りないときは null
 */
export function planDates(stages: PlanStage[], start: string, end: string): { start: string; due: string }[] | null {
  const s = parseDay(start);
  const e = parseDay(end);
  const days = Math.round((e - s) / DAY);
  if (!Number.isFinite(days) || days < stages.length - 1) return null;
  const out: { start: string; due: string }[] = [];
  let from = s;
  stages.forEach((stage, i) => {
    const last = i === stages.length - 1;
    // どの段にも 1 日は残す
    const minDue = from;
    const maxDue = e - (stages.length - 1 - i) * DAY;
    const due = last ? e : Math.min(maxDue, Math.max(minDue, s + Math.round(days * stage.until) * DAY));
    out.push({ start: formatDay(from), due: formatDay(due) });
    from = due + DAY;
  });
  return out;
}
