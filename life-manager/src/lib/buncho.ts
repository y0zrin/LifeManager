/** 文鳥のテーマの、文鳥の色（桜文鳥・白文鳥・シルバー文鳥・シナモン文鳥） */
export type BunchoKind = "sakura" | "shiro" | "silver" | "cinnamon";

export const BUNCHO_KINDS: BunchoKind[] = ["sakura", "shiro", "silver", "cinnamon"];

/** パートナーの文鳥。起動するたびに 4 羽からランダムに選ぶ（起動しているあいだは同じ） */
export const PARTNER: BunchoKind = BUNCHO_KINDS[Math.floor(Math.random() * BUNCHO_KINDS.length)];

/** n 羽の文鳥の色（パートナーから始めて、ほかの色を順に） */
export function bunchoFlock(n: number): BunchoKind[] {
  const start = BUNCHO_KINDS.indexOf(PARTNER);
  return Array.from({ length: n }, (_, i) => BUNCHO_KINDS[(start + i) % BUNCHO_KINDS.length]);
}
