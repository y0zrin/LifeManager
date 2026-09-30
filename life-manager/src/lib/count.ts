/**
 * 数の数え方（日本語）。「3 つ」は自然でも「113 つ」は不自然なので、10 からは助数詞（件・個 など）にする
 * 例: countOf(3, "件") → "3 つ"、countOf(113, "件") → "113 件"
 */
export function countOf(n: number, counter: string): string {
  return n < 10 ? `${n} つ` : `${n} ${counter}`;
}
