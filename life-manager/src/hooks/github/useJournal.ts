// 日誌（その日の Issue の動きのまとめと、手で書くノート）
import { invoke } from "../../lib/invoke";
import type { JournalResult } from "../../lib/types";
import { PENDING_NOTE, type RepoScope } from "./shared";
import { tr } from "../../lib/i18n";

export function useJournal({ owner, repo, setStatus }: RepoScope) {
  async function generateJournal(date: string): Promise<string> {
    try {
      const result = await invoke<JournalResult>("generate_journal", { owner, repo, date });
      setStatus(result.pending ? tr("つながっていないので、{date}のジャーナルはつながったら作ります", { date }) : tr("{date}のジャーナルを生成しました", { date }));
      return result.content;
    } catch (e) {
      setStatus(tr("ジャーナル生成エラー: ") + e);
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
      setStatus(tr("{date}のノートを保存しました{v}", { date, v: result.pending ? PENDING_NOTE : "" }));
      return result.content;
    } catch (e) {
      setStatus(tr("ノート保存エラー: ") + e);
      throw e;
    }
  }

  return { generateJournal, getJournal, listJournalDates, saveJournalNotes };
}
