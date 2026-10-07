// ラベルの区分（種別・状態・優先・セクション・見積・そのほか）。設定のラベルのタブで使う（#281）。
// Issue の詳細でラベルを選ぶ組（IssueDetailModal の LABEL_GROUPS と「そのほか」）と、同じ区分・同じ並び
import type { GitHubLabel } from "./types";
import { ESTIMATE_PREFIX } from "./estimate";
import { inCategory } from "./section";
import { tr } from "./i18n";

export interface LabelCategory {
  /** 名前の頭（「種別:」など）。そのほかは "" */
  prefix: string;
  /** 画面に出す区分の名前（今の言語） */
  name: string;
  /** 決まった区分か（そのほかも true） */
  builtin: boolean;
  labels: GitHubLabel[];
  /** 区分の「＋」で作れるか（見積は、タスクに見積もりを付けたときに作るので false） */
  canAdd: boolean;
}

/** 決まった区分（この並びで出す） */
export const BUILTIN_CATEGORIES = ["種別", "状態", "優先", "セクション", "見積"] as const;

/**
 * ラベルを区分に分ける。並びは 種別・状態・優先・セクション（前の「分野:」も）・見積 → そのほか。
 * ラベルがない区分も出す（その区分の「＋」で作れるように）
 */
export function labelCategories(labels: GitHubLabel[]): LabelCategory[] {
  const builtin: LabelCategory[] = BUILTIN_CATEGORIES.map((key) => {
    const prefix = `${key}:`;
    return { prefix, name: tr(key), builtin: true, labels: labels.filter((l) => inCategory(l.name, prefix)), canAdd: prefix !== ESTIMATE_PREFIX };
  });
  const other = labels.filter((l) => !builtin.some((c) => inCategory(l.name, c.prefix)));
  return [...builtin, { prefix: "", name: tr("そのほか"), builtin: true, labels: other, canAdd: true }];
}

/** ラベルの名前の頭（区分のラベルなら「セクション:」「分野:」など。そのほかは ""） */
export function prefixOf(name: string, category: LabelCategory): string {
  if (!category.prefix) return "";
  const i = name.indexOf(":");
  return i < 0 ? "" : name.slice(0, i + 1);
}
