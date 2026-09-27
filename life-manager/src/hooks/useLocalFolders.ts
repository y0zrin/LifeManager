import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isMobile } from "../lib/platform";

/**
 * この PC でのリポジトリの場所（git を操作するフォルダ）。キーは "owner/repo"。
 * スマホ版では git を使わないので読み込まない
 */
export function useLocalFolders() {
  const [folders, setFolders] = useState<Record<string, string>>({});

  useEffect(() => {
    if (isMobile) return;
    invoke<string>("load_local_folders")
      .then((json) => setFolders(JSON.parse(json)))
      .catch((e) => console.error("作業フォルダの読み込みに失敗しました:", e));
  }, []);

  /** path が null なら設定を外す */
  const setFolder = useCallback(async (owner: string, repo: string, path: string | null) => {
    const json = await invoke<string>("set_local_folder", { owner, repo, path });
    setFolders(JSON.parse(json));
  }, []);

  return { folders, setFolder };
}
