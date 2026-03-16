# Life Manager — 設計議論ログ

## 2026-03-12: 初期設計決定

### コンセプト
- 「GitHubで人生を管理する」(hand_dot, 2021) に触発
- 核心思想: 「自動化」ではなく「行動の抽象化」
- 行動パターンを宣言的に定義し、GitHubリポジトリに実行可能な仕様として記述する
- ソフトウェア設計における「実装と仕様の分離」を人生に適用

### 技術選定
- **バックエンド**: GitHub (既存の貯蔵庫。Issue, Milestone, Labels, Contents API)
- **フロントエンド**: Tauri 2.0 (Rust + WebView)
  - デスクトップ・モバイル両対応
  - Rustバックエンドで GitHub API通信・スケジューリングを統一
- **通知**: Slack Webhook + OS通知 (ブラウザ/PWA通知)

### 粒度モデル（5層）
1. Theme（テーマ）→ Label
2. Milestone → GitHub Milestone
3. Issue → GitHub Issue
4. Todo → Issue内 Task List
5. Memo → Issue (grain:memo ラベル)

### 主要設計判断
- **リポジトリ構成**: 単一 `life` リポジトリに集約。大規模プロジェクトのみ分離
- **メモの扱い**: 全てIssueに統一（grain:memo ラベル）。昇華時はラベル変更のみ。Issue番号が不変のため履歴が残る
- **ラベル体系**: `grain:*`, `theme:*`, `status:*`, `priority:*` の4軸タグシステム
- **ルーチン**: GUI → routines.yaml → Rustバッチで Issue自動生成
- **日次ログ**: Rustバッチが完了Issue+Memoを集約してMarkdownコミット
- **モバイル**: Tauri 2.0 で統一（PWA併用せず）

### 参考資料
- hand_dot「githubで人生を管理する」(Zenn, 2021)
- mzk_tech「GitHub IssuesをDBにする人生管理アプリ」(Qiita, 2026-02)
- syuya2036「AIにGitHubで人生を管理させる【OpenClaw】」(Zenn, 2026-03)
