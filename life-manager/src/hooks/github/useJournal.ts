// 日誌（その日の Issue の動きのまとめと、手で書くノート）
import { invoke } from "@tauri-apps/api/core";
import type { JournalResult } from "../../lib/types";
import { PENDING_NOTE, type RepoScope } from "./shared";

export function useJournal({ owner, repo, setStatus }: RepoScope) {
  async function generateJournal(date: string): Promise<string> {
    try {
      const result = await invoke<JournalResult>("generate_journal", { owner, repo, date });
      setStatus(result.pending ? `つながっていないので、${date}のジャーナルはつながったら作ります` : `${date}のジャーナルを生成しました`);
      return result.content;
    } catch (e) {
      setStatus("ジャーナル生成エラー: " + e);
      throw e;
    }
  }

  async function getJournal(date: string): Promise<string> {
    try {
      const result = await invoke("get_journal", { owner, repo, date });
      return result as string;
    } catch {
      // ジャーナルが見つからない場合は空文字を返す
      return "";
    }
  }

  /** 日誌がある日（YYYY-MM-DD。日誌のカレンダーの 📓）。読めなければ空 */
  async function listJournalDates(): Promise<string[]> {
    try {
      return await invoke<string[]>("list_journal_dates", { owner, repo });
    } catch {
      return [];
    }
  }

  async function saveJournalNotes(date: string, notes: string): Promise<string> {
    try {
      const result = await invoke<JournalResult>("save_journal_notes", { owner, repo, date, notes });
      setStatus(`${date}のノートを保存しました${result.pending ? PENDING_NOTE : ""}`);
      return result.content;
    } catch (e) {
      setStatus("ノート保存エラー: " + e);
      throw e;
    }
  }

  return { generateJournal, getJournal, listJournalDates, saveJournalNotes };
}
