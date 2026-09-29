import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { gitVersion } from "../../lib/git";

interface GitInfoCardProps {
  /** 使う準備（Git のインストール・コミットに使う名前）のダイアログを開く */
  onOpenSetup: () => void;
  /** 変わったら Git を確かめ直す（Git を入れたあとなど） */
  setupVersion: number;
}

/** 設定 → その他: この PC の git（使う git の版と、使う準備を確かめる。見つからなければ入れ方） */
export function GitInfoCard({ onOpenSetup, setupVersion }: GitInfoCardProps) {
  // git が使えるか。null は確認中
  const [git, setGit] = useState<{ version: string } | { error: string } | null>(null);

  useEffect(() => {
    gitVersion()
      .then((v) => setGit({ version: v.replace(/^git version\s*/, "") }))
      .catch((e) => setGit({ error: String(e) }));
  }, [setupVersion]);

  return (
    <div className="form-card">
      <h3 className="settings-section-title">この PC の git</h3>
      <p className="settings-hint" style={{ marginBottom: "var(--space-sm)" }}>
        「作業」「ブランチ」「全体図」で使う git です。リポジトリごとの作業フォルダは、左上のリポジトリの「⋯」で決めます。
      </p>
      {git === null && <p className="settings-hint">git を確認しています…</p>}
      {git && "version" in git && (
        <p className="settings-hint local-folder-git">
          使う git: {git.version}
          <button type="button" className="sec-btn" onClick={onOpenSetup}>
            使う準備を確かめる
          </button>
        </p>
      )}
      {git && "error" in git && (
        <div className="local-folder-message local-folder-message--error">
          Git が見つかりません。「作業」「ブランチ」「全体図」を使うには、Git をインストールします。
          <div className="local-folder-actions">
            <button type="button" className="btn-primary" onClick={onOpenSetup}>
              Git をインストールする…
            </button>
            <button type="button" className="btn-sm" onClick={() => openUrl("https://git-scm.com/downloads")}>
              Git のページを開く
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
