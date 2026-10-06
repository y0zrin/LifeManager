// バックエンド（Rust）を呼ぶ（#256）。Rust が日本語で返す文（断られたときの文・「保存しました」のような結果の文）を、今の言語に訳して渡す。
// 文に決まった言葉が入っているかで見分けるところは、jaOf()（lib/i18n）で元の日本語に戻して見る
import { invoke as tauriInvoke, type InvokeArgs, type InvokeOptions } from "@tauri-apps/api/core";
import { currentLang, translateMessage } from "./i18n";

export type { InvokeArgs, InvokeOptions };

const JA = /[぀-ヿ㐀-鿿]/;

/** 訳してよい、短い知らせの文か（ファイルの中身・JSON・長い出力は訳さない） */
function messageLike(s: string): boolean {
  return s.length <= 400 && JA.test(s) && !/^\s*[[{]/.test(s);
}

export async function invoke<T>(cmd: string, args?: InvokeArgs, options?: InvokeOptions): Promise<T> {
  let result: T;
  try {
    result = await tauriInvoke<T>(cmd, args, options);
  } catch (e) {
    throw typeof e === "string" && currentLang() !== "ja" ? translateMessage(e) : e;
  }
  if (typeof result === "string" && currentLang() !== "ja" && messageLike(result)) return translateMessage(result) as T;
  return result;
}
