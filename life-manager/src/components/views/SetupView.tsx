import { useState } from "react";

interface SetupViewProps {
  onComplete: (token: string, owner: string, repo: string) => Promise<void>;
  status: string;
}

export function SetupView({ onComplete, status }: SetupViewProps) {
  const [step, setStep] = useState(1);
  const [token, setToken] = useState("");
  const [owner, setOwner] = useState("");
  const [repo, setRepo] = useState("");
  const [submitting, setSubmitting] = useState(false);

  async function handleSubmit() {
    if (!token.trim() || !owner.trim() || !repo.trim()) return;
    setSubmitting(true);
    try {
      await onComplete(token.trim(), owner.trim(), repo.trim());
    } catch {
      setSubmitting(false);
    }
  }

  return (
    <div style={{
      display: "flex", justifyContent: "center", alignItems: "center",
      minHeight: "100vh", background: "var(--bg-primary)", padding: "var(--space-lg)",
    }}>
      <div style={{
        background: "var(--bg-secondary)", border: "1px solid var(--border-default)", borderRadius: "var(--radius-lg)",
        padding: "40px", maxWidth: "480px", width: "100%",
      }}>
        <h1 style={{ fontSize: "24px", color: "var(--text-primary)", marginBottom: "var(--space-sm)", textAlign: "center" }}>
          Life Manager
        </h1>
        <p style={{ color: "var(--text-muted)", fontSize: "var(--font-md)", textAlign: "center", marginBottom: "32px" }}>
          GitHubリポジトリをバックエンドとしたタスク管理ツール
        </p>

        {/* ステップインジケーター */}
        <div style={{ display: "flex", justifyContent: "center", gap: "var(--space-sm)", marginBottom: "var(--space-xl)" }}>
          {[1, 2, 3].map((s) => (
            <div key={s} style={{
              width: "8px", height: "8px", borderRadius: "50%",
              background: s <= step ? "var(--accent-blue)" : "var(--border-default)",
              transition: "background 0.2s",
            }} />
          ))}
        </div>

        {step === 1 && (
          <div>
            <h2 style={{ fontSize: "var(--font-xl)", color: "var(--text-primary)", marginBottom: "var(--space-md)" }}>
              1. GitHubリポジトリ
            </h2>
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", marginBottom: "var(--space-lg)" }}>
              Issueやマイルストーンを管理するリポジトリを指定してください。
              新規リポジトリでも既存でも構いません。
            </p>
            <div className="flex-row" style={{ marginBottom: "var(--space-md)" }}>
              <input value={owner} onChange={(e) => setOwner(e.target.value)}
                placeholder="オーナー名" className="input-full" style={{ flex: 1 }} />
              <span style={{ color: "var(--text-muted)", fontSize: "var(--font-2xl)" }}>/</span>
              <input value={repo} onChange={(e) => setRepo(e.target.value)}
                placeholder="リポジトリ名" className="input-full" style={{ flex: 1 }} />
            </div>
            <p style={{ fontSize: "var(--font-xs)", color: "var(--text-faint)", marginBottom: "var(--space-lg)" }}>
              例: y0zrin / life
            </p>
            <button className="btn-primary" style={{ width: "100%", padding: "10px" }}
              disabled={!owner.trim() || !repo.trim()} onClick={() => setStep(2)}>
              次へ
            </button>
          </div>
        )}

        {step === 2 && (
          <div>
            <h2 style={{ fontSize: "var(--font-xl)", color: "var(--text-primary)", marginBottom: "var(--space-md)" }}>
              2. GitHubトークン
            </h2>
            <p style={{ fontSize: "var(--font-sm)", color: "var(--text-muted)", marginBottom: "var(--space-lg)" }}>
              Personal Access Token (Classic) を入力してください。
              repo スコープが必要です。トークンはOSキーチェーンに安全に保存されます。
            </p>
            <input type="password" value={token} onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_xxxxxxxxxxxx" className="input-full" style={{ marginBottom: "var(--space-lg)" }} />
            <div className="flex-row">
              <button className="btn-sm" onClick={() => setStep(1)} style={{ flex: 1, padding: "10px" }}>戻る</button>
              <button className="btn-primary" style={{ flex: 2, padding: "10px" }}
                disabled={!token.trim()} onClick={() => setStep(3)}>次へ</button>
            </div>
          </div>
        )}

        {step === 3 && (
          <div>
            <h2 style={{ fontSize: "var(--font-xl)", color: "var(--text-primary)", marginBottom: "var(--space-md)" }}>
              3. 確認
            </h2>
            <div style={{
              background: "var(--bg-primary)", borderRadius: "var(--radius-lg)", padding: "var(--space-lg)",
              border: "1px solid var(--border-default)", marginBottom: "var(--space-lg)",
            }}>
              <div style={{ marginBottom: "var(--space-sm)" }}>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)" }}>リポジトリ</span>
                <p style={{ color: "var(--text-primary)", fontSize: "var(--font-lg)", margin: "2px 0 0" }}>
                  {owner} / {repo}
                </p>
              </div>
              <div>
                <span style={{ color: "var(--text-muted)", fontSize: "var(--font-sm)" }}>トークン</span>
                <p style={{ color: "var(--text-primary)", fontSize: "var(--font-lg)", margin: "2px 0 0" }}>
                  {token.substring(0, 8)}{"•".repeat(Math.max(0, token.length - 8))}
                </p>
              </div>
            </div>
            <p style={{ fontSize: "var(--font-xs)", color: "var(--text-muted)", marginBottom: "var(--space-lg)" }}>
              接続後、ラベルの一括作成を行うことでLife Managerのラベル体系がセットアップされます。
              設定画面からいつでも変更できます。
            </p>
            {status && (
              <p style={{ fontSize: "var(--font-sm)", color: "var(--accent-red)", marginBottom: "var(--space-md)" }}>{status}</p>
            )}
            <div className="flex-row">
              <button className="btn-sm" onClick={() => setStep(2)} style={{ flex: 1, padding: "10px" }}>戻る</button>
              <button className="btn-primary" style={{ flex: 2, padding: "10px" }}
                disabled={submitting} onClick={handleSubmit}>
                {submitting ? "接続中..." : "接続してはじめる"}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
