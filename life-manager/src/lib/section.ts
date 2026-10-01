// セクション（だれの仕事か: プログラマー・デザイナー・プランナー・その他 など）のラベル。「セクション:プログラマー」の形。
// 1.0 より前の「分野:」のラベル（仕事・学習 など）も、セクションとして読む（絞り込み・付箋・メモ・まとめ方）

export const SECTION_PREFIX = "セクション:";
const OLD_PREFIX = "分野:";

/** セクションのラベルか（前の「分野:」も） */
export function isSectionLabel(name: string): boolean {
  return name.startsWith(SECTION_PREFIX) || name.startsWith(OLD_PREFIX);
}

/** ラベルの名前から、セクションの名前（「セクション:プログラマー」→「プログラマー」） */
export function sectionOf(name: string): string {
  if (name.startsWith(SECTION_PREFIX)) return name.slice(SECTION_PREFIX.length);
  if (name.startsWith(OLD_PREFIX)) return name.slice(OLD_PREFIX.length);
  return name;
}

/** ラベルの種類（「種別:」「状態:」など）に入るか。セクションは前の「分野:」も入れる */
export function inCategory(name: string, prefix: string): boolean {
  return prefix === SECTION_PREFIX ? isSectionLabel(name) : name.startsWith(prefix);
}
