// 画面の言語（#256）: 日本語・English・简体中文・繁體中文。
// 日本語の文をそのまま鍵にして、src/locales/<言語>.json の辞書から訳を引く（辞書にない文は日本語のまま出す）。tr() は文、trx() は要素の入る文。
// 辞書は、画面のもの（ここで決まる文を含む）を読み込む前に読む（main.tsx）。言語を変えたら、画面を読み直す。
// アプリが GitHub に書く文（日誌の見出し・作業報告や 🆘 の決まった文・ラベルの名前）は日本語のまま（ユーザー決定 2026-10-04）
import { cloneElement, createElement, Fragment, isValidElement, type ReactElement, type ReactNode } from "react";

export type Lang = "ja" | "en" | "zh-Hans" | "zh-Hant";

/** 選べる言語（名前はその言語で書く） */
export const LANGS: { key: Lang; name: string }[] = [
  { key: "ja", name: "日本語" },
  { key: "en", name: "English" },
  { key: "zh-Hans", name: "简体中文" },
  { key: "zh-Hant", name: "繁體中文" },
];

/** 辞書の値: 訳の文。数で形の変わる文（英語の 1 hour / 2 hours）は { one, other } */
type Entry = string | { one?: string; other: string };

const STORE = "lang";
let lang: Lang = "ja";
let dict: Record<string, Entry> = {};
let plural: Intl.PluralRules | null = null;

function isLang(v: unknown): v is Lang {
  return v === "ja" || v === "en" || v === "zh-Hans" || v === "zh-Hant";
}

/** OS（ブラウザ）の言語から。日本語・中国語・英語のどれでもなければ英語 */
export function detectLang(): Lang {
  const list = typeof navigator !== "undefined" ? (navigator.languages?.length ? navigator.languages : [navigator.language]) : [];
  for (const raw of list) {
    const l = (raw ?? "").toLowerCase();
    if (l.startsWith("ja")) return "ja";
    if (l.startsWith("zh")) return /hant|tw|hk|mo/.test(l) ? "zh-Hant" : "zh-Hans";
    if (l.startsWith("en")) return "en";
  }
  return list.length ? "en" : "ja";
}

/** 選んで覚えている言語（なければ null） */
export function savedLang(): Lang | null {
  try {
    const v = localStorage.getItem(STORE);
    return isLang(v) ? v : null;
  } catch {
    return null;
  }
}

/** 今の言語 */
export function currentLang(): Lang {
  return lang;
}

/** html の lang（字の形が言語に合うように） */
function htmlLang(l: Lang): string {
  return l === "zh-Hans" ? "zh-CN" : l === "zh-Hant" ? "zh-TW" : l;
}

const LOADERS: Record<Exclude<Lang, "ja">, () => Promise<{ default: Record<string, Entry> }>> = {
  en: () => import("../locales/en.json"),
  "zh-Hans": () => import("../locales/zh-Hans.json"),
  "zh-Hant": () => import("../locales/zh-Hant.json"),
};

/** 言語を決めて、辞書を読む（画面を読み込む前に 1 回） */
export async function loadLanguage(force?: Lang): Promise<void> {
  lang = force ?? savedLang() ?? detectLang();
  try {
    document.documentElement.lang = htmlLang(lang);
  } catch {
    // 窓のないところ（テスト）では付けない
  }
  plural = lang === "ja" ? null : new Intl.PluralRules(lang === "en" ? "en" : "zh");
  dict = {};
  if (lang === "ja") return;
  try {
    dict = (await LOADERS[lang]()).default;
  } catch {
    // 読めなければ日本語のまま
    dict = {};
  }
}

/** 言語を変える（覚えて、画面を読み直す） */
export function setLang(next: Lang) {
  try {
    localStorage.setItem(STORE, next);
  } catch {
    // 覚えられなくても、今回は読み直して変える
  }
  window.location.reload();
}

/** 数で形を選ぶときの数: vars.n・vars.count、なければ vars のはじめの数 */
function countOf(vars?: Record<string, unknown>): number {
  if (!vars) return NaN;
  const direct = vars.n ?? vars.count;
  if (direct !== undefined) return Number(direct);
  for (const v of Object.values(vars)) if (typeof v === "number") return v;
  return NaN;
}

/** 訳の文（数で形の変わるものは、countOf の数で選ぶ） */
function lookup(ja: string, vars?: Record<string, unknown>): string {
  const e = dict[ja];
  if (e === undefined) return ja;
  if (typeof e === "string") return e;
  const n = countOf(vars);
  const cat = plural && Number.isFinite(n) ? plural.select(n) : "other";
  return (cat === "one" && e.one) || e.other;
}

// 訳した文 → 元の日本語（エラーの文などを、言語によらず見分けるため。jaOf）。古いものから忘れる
const ORIGINALS_MAX = 2000;
const originals = new Map<string, string>();
function remember(translated: string, ja: string) {
  if (translated === ja || originals.has(translated)) return;
  originals.set(translated, ja);
  if (originals.size > ORIGINALS_MAX) originals.delete(originals.keys().next().value as string);
}

/**
 * 訳した文の、元の日本語（訳していない文はそのまま）。
 * エラーの文に決まった言葉が入っているかを見るときに使う（例: jaOf(message).includes("認証エラー")）
 */
export function jaOf(s: string): string {
  return originals.get(s) ?? s;
}

/** 辞書に、その文の訳があるか */
export function hasTranslation(ja: string): boolean {
  return dict[ja] !== undefined;
}

/** 辞書の鍵（訳す文の日本語）のうち、{0} の形の場所を持つもの（Rust のエラーの文の形）。はじめて使うときに作る */
let patterns: { re: RegExp; key: string; slots: string[] }[] | null = null;
function messagePatterns() {
  if (patterns) return patterns;
  patterns = [];
  for (const key of Object.keys(dict)) {
    if (!/\{\d+\}/.test(key)) continue;
    const slots: string[] = [];
    const src = key
      .split(/(\{\d+\})/)
      .map((part) => {
        const m = /^\{(\d+)\}$/.exec(part);
        if (m) {
          slots.push(m[1]);
          return "([\\s\\S]*?)";
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      })
      .join("");
    patterns.push({ re: new RegExp(`^${src}$`), key, slots });
  }
  // 長い（決まった字の多い）形から当てる
  patterns.sort((a, b) => b.key.length - a.key.length);
  return patterns;
}

/**
 * バックエンド（Rust）から届いた文を、今の言語に。辞書にそのままあればその訳、
 * {0} の形の文（format! の文）に当てはまれば、その訳に {0} の中身を入れる。当てはまらなければ、そのまま
 */
export function translateMessage(msg: string): string {
  if (lang === "ja" || !msg) return msg;
  if (dict[msg] !== undefined) {
    const out = lookup(msg);
    remember(out, msg);
    return out;
  }
  for (const p of messagePatterns()) {
    const m = p.re.exec(msg);
    if (!m) continue;
    const vars: Record<string, unknown> = {};
    p.slots.forEach((slot, i) => {
      // 中身も、辞書にあれば訳す（「…: 〈Rust の別のエラー〉」のような入れ子）
      vars[slot] = translateMessage(m[i + 1]);
    });
    const out = fill(lookup(p.key, vars), vars);
    remember(out, msg);
    return out;
  }
  return msg;
}

/** {name} を値に（vars にない名前は、そのまま残す）。名前は日本語でもよい（{名前}） */
function fill(s: string, vars?: Record<string, unknown>): string {
  if (!vars) return s;
  return s.replace(/\{([^{}\s]+)\}/g, (m, k: string) => (Object.prototype.hasOwnProperty.call(vars, k) ? String(vars[k]) : m));
}

/**
 * 文を今の言語で。鍵は日本語の文そのもの。数や名前は {n} の形で書き、vars で渡す
 * 例: tr("{n} 件のタスク", { n: 3 }) → "3 tasks"
 */
export function tr(ja: string, vars?: Record<string, unknown>): string {
  const out = fill(lookup(ja, vars), vars);
  if (lang !== "ja") remember(out, vars ? fill(ja, vars) : ja);
  return out;
}

/**
 * 太字やコードなど、要素の入る文を今の言語で（文を 1 つのまま訳すため。語順が変わっても崩れない）。
 * 要素は <0>…</0> の形で書き、tags に同じ番号の要素を渡す（中身は訳した文の <0>…</0> の中に置き換える）。
 * {name} は vars の値（文字・数・要素）にする
 * 例: trx("<0>{name}</0> を招待しました", { name }, [<b />])
 */
export function trx(ja: string, vars?: Record<string, ReactNode>, tags?: ReactElement[]): ReactNode {
  const s = lookup(ja, vars as Record<string, unknown> | undefined);
  let key = 0;
  // <n>…</n>（入れ子も）と {name} を、要素と値にする
  function parse(src: string): ReactNode[] {
    const out: ReactNode[] = [];
    let i = 0;
    let text = "";
    const flush = () => {
      if (text) out.push(text);
      text = "";
    };
    while (i < src.length) {
      const open = /^<(\d+)>/.exec(src.slice(i));
      if (open) {
        const n = Number(open[1]);
        const close = `</${n}>`;
        // 同じ番号の入れ子は数えて、対の閉じを探す
        let depth = 1;
        let j = i + open[0].length;
        while (j < src.length && depth > 0) {
          if (src.startsWith(`<${n}>`, j)) {
            depth++;
            j += open[0].length;
          } else if (src.startsWith(close, j)) {
            depth--;
            if (depth === 0) break;
            j += close.length;
          } else {
            j++;
          }
        }
        const inner = src.slice(i + open[0].length, j);
        const el = tags?.[n];
        flush();
        if (el && isValidElement(el)) out.push(cloneElement(el, { key: `t${key++}` }, ...parse(inner)));
        else out.push(...parse(inner));
        i = j + close.length;
        continue;
      }
      const ph = /^\{([^{}\s]+)\}/.exec(src.slice(i));
      if (ph && vars && Object.prototype.hasOwnProperty.call(vars, ph[1])) {
        flush();
        const v = vars[ph[1]];
        out.push(isValidElement(v) ? cloneElement(v, { key: `v${key++}` }) : v);
        i += ph[0].length;
        continue;
      }
      text += src[i];
      i++;
    }
    flush();
    return out;
  }
  const nodes = parse(s);
  return nodes.length === 1 && !isValidElement(nodes[0]) ? nodes[0] : createElement(Fragment, null, ...nodes);
}

/** 曜日の短い名前（日本語は「日」、英語は「Sun」、中国語は「日」） */
export function weekdayShort(d: Date): string {
  return weekdayName(d.getDay());
}

/** 曜日の短い名前を、曜日の番号（0 = 日曜）から */
export function weekdayName(day: number): string {
  if (lang === "ja") return "日月火水木金土"[day] ?? "";
  if (lang === "en") return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][day] ?? "";
  return "日一二三四五六"[day] ?? "";
}

/** 曜日の名前のならび（日本語・中国語はつなげる「月水金」、英語は「Mon, Wed, Fri」） */
export function joinWeekdays(names: string[]): string {
  return names.join(lang === "en" ? ", " : "");
}

/** 月の名前（カレンダーの見出し。日本語・中国語は「10 月」、英語は「October」） */
export function monthLong(m: number): string {
  if (lang === "en") return ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1] ?? String(m);
  return `${m} 月`;
}

/** ラベルの分類（「種別:」「状態:」など）。この形のラベルは、分類と値を訳して出す */
const LABEL_CATEGORY = /^(種別|状態|優先|セクション|分野|見積)[:：](.*)$/;

/**
 * ラベルの名前を、画面に出す形に（「種別:イシュー」→「Type: Issue」）。ラベルの名前（データ）は日本語のまま。
 * 分類の付いたラベルだけ訳す。知らない値（チームで足したラベル）は値をそのまま
 */
export function labelText(name: string): string {
  if (lang === "ja") return name;
  const m = LABEL_CATEGORY.exec(name);
  if (!m) return name;
  // 丸ごとの訳があればそれを（「種別:メモ」→「Type: Memo」）。なければ分類と値をそれぞれ
  const whole = `${m[1]}:${m[2]}`;
  if (dict[whole] !== undefined) return tr(whole);
  return `${tr(m[1])}: ${tr(m[2])}`;
}

/** ラベルの値だけを、画面に出す形に（「種別:メモ」→「Memo」。分類のないラベルはそのまま） */
export function labelValueText(name: string): string {
  const m = LABEL_CATEGORY.exec(name);
  if (!m) return name;
  if (lang === "ja") return m[2];
  const shown = labelText(name);
  // 英語は「Type: Memo」、中国語は「类型：备忘」
  const sep = /: |：/.exec(shown);
  return sep ? shown.slice(sep.index + sep[0].length) : tr(m[2]);
}

/** 月の短い名前（日本語・中国語は「10月」、英語は「Oct」） */
export function monthShort(m: number): string {
  if (lang === "en") return ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1] ?? String(m);
  return `${m}月`;
}

/** ならびの区切り（日本語・中国語は「、」、英語は ", "） */
export function listSep(): string {
  return lang === "en" ? ", " : "、";
}

/** 名前のならび（日本語・中国語は「、」、英語は ", "） */
export function joinNames(names: string[]): string {
  return names.join(lang === "en" ? ", " : "、");
}

/** 日付や数の書き方に使う、言語の名前（ja-JP・en-US・zh-CN・zh-TW） */
export function localeTag(): string {
  return lang === "ja" ? "ja-JP" : lang === "en" ? "en-US" : htmlLang(lang);
}

/** 言語ごとの、数の区切り（1,284） */
export function formatNumber(n: number): string {
  return n.toLocaleString(lang === "ja" ? "ja-JP" : lang === "en" ? "en-US" : htmlLang(lang));
}
