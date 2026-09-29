# Life Manager — CLAUDE.md

## プロジェクト概要
Tauri 2.0 (Rust + React/TypeScript) のGitHub Issues ベースタスク管理デスクトップアプリ。
GitHub Issues/Milestones/Labels をバックエンドストレージとして利用。

## 現在のバージョンと次の作業
- **公開済み**: v0.3.3（2026-04-22）
- **公開の準備中**: v0.9.0 — 0.4〜0.9 のロードマップ（タスク管理・リポジトリ管理・プルリク・Actions・リリース・アクティビティ）をまとめて出す。ブランチ `0.9.0` に保存してある（リリースノートは `docs/release-notes/0.9.0.md`）
  - 済み（2026-09-29）: GitHub App に権限を足して承認。本物のアプリ（非公開の y0zrin/lm-test）で W・X・Y を確かめ、見つかった 11 件の不具合を直した
    （X15・X16・X11・X2・X3・X6・X8・X9・X10・X12、W5・W7・W8・W9・W10・W11、Y2・Y3（タグと題名）・Y4・Y6 は本物で動いた）
  - 残り: 人が確かめること（W6 別のアカウントでのレビュー・X13 Unity のリポジトリ）→ main にまとめてタグ 0.9.0 → Release に setup と latest.json（手順は `docs/04_keys_and_tokens.md`。Y3 のファイルを添えるは、このときアプリの「＋ リリースを作る」で確かめる）
- **次回**: v1.0 "Foundation" — 画面側のテスト・E2E、状態管理、API キャッシュ、git ターミナル
- **ロードマップ詳細**: メモリの `next_tasks.md` を参照

### ロードマップの進み（2026-09-29 夜）
| 版 | 中身 | 状態 |
|---|---|---|
| v0.4 "Depth" | サブイシュー、AND/OR の絞り込み、一括操作、並び替え、テンプレート、期限、関連、変更の履歴 | 完了（0.9.0 に入る） |
| v0.5 "Intelligence" | 保存した見方、表、まとめる、見積もり、分析パネル | 完了（0.9.0 に入る） |
| v0.6 "Agile" | useGitHub の分割、スプリント、バーンダウン、ベロシティ、サイクルタイム | 完了（0.9.0 に入る） |
| v0.7 "Code" | プルリクの一覧・会話・変更されたファイル（差分・行コメント）・レビュー・マージ・作成、作業の流れの プルリク → マージ | 完了（0.9.0 に入る） |
| v0.8 "Pipeline" | Actions（解決する順の山・ログ・もう一度実行・手で実行・ひな形〔Unity・Unreal も〕・止める）、Dependabot・コードスキャン、プルリクのチェック | 完了（0.9.0 に入る） |
| v0.9 "Release" | リリース管理（マイルストーンからノート・ファイルを添える）、アクティビティ（あなたがすること＝通知の代わり・チームの動き）、ブランチ管理 | 完了（0.9.0 に入る） |
| v1.0 | 画面側のテスト・E2E、状態管理、API キャッシュ、git ターミナル（Rust のテスト 91 件はある） | 未着手 |

## 技術スタック
- **フロントエンド**: React 19 + TypeScript + Vite
- **バックエンド**: Rust (Tauri 2.0)
- **API**: GitHub REST API（「GitHub でログイン」= OAuth デバイスフロー、または Fine-grained PAT）
- **通知**: Discord Webhook + OS通知 (tauri-plugin-notification)
- **自動更新**: tauri-plugin-updater (minisign署名)
- **キー管理**: OS キーチェーン (keyring クレート)

## ビルド・開発
```bash
npm run dev          # 開発サーバー起動
npx tsc --noEmit     # 型チェック（変更後必ず実行）
cargo check          # Rustコンパイルチェック（バックエンド変更時）
release.bat          # リリースビルド（バージョンbump + ビルド + latest.json生成）
```

## 主要ディレクトリ
```
src/
├── App.tsx, App.css         # メインアプリ、グローバルCSS
├── hooks/useGitHub.ts       # GitHub API操作の中央フック（組み合わせと、全部を読む・プロジェクト切り替え・ログイン/ログアウトだけ）
├── hooks/github/           # 分野ごとのフック: useSession（リポジトリ・ログイン・プロジェクト）/ useRepoMeta（ラベル・マイルストーン・コラボレーター）/
│                           #   useRepoSettings（リポジトリに置く設定・Discord）/ useIssues（Issue 操作・コメント・親子・テンプレート・履歴・見積もり）/ useJournal / shared
├── lib/
│   ├── types.ts             # 型定義（EventType含む）
│   ├── ganttTypes.ts        # ガントチャート型定義（GanttBarColors含む）
│   ├── ganttParser.ts       # Issueメタデータ↔GanttTask変換
│   └── ganttRenderer.ts     # Canvas描画エンジン（クリティカルパス計算含む）
├── components/common/
│   ├── IssueDetailModal.tsx  # Issue詳細（ガント編集、先行タスク検索含む）
│   └── ...
└── components/views/
    ├── DashboardView.tsx     # タスク一覧（検索、サジェスト、ガント日程入力）
    ├── KanbanView.tsx        # カンバンボード
    ├── GanttView.tsx         # ガントチャート（ドラッグ移動/リサイズ、CP、色設定、遅延表示）
    ├── SettingsView.tsx      # 設定（ペイン化: 接続/ラベル/通知/その他）
    ├── TimelineView.tsx      # 日誌（Issue参照リンク付き）
    └── ...

src-tauri/src/
├── lib.rs                   # Tauriコマンド定義
├── github/client.rs         # GitHub REST APIクライアント
├── scheduler/routine.rs     # ルーチンIssue自動作成（イベント通知設定対応）
└── ...
```

## ガントチャート — 実装済み機能 (v0.3.2)
- Canvas描画エンジン: グリッド（水平罫線含む）、日付ヘッダー、今日線、バー、依存矢印
- Issue body内のHTMLコメントメタデータ:
  - `<!-- gantt:YYYY-MM-DD/YYYY-MM-DD -->` 開始/終了日
  - `<!-- depends:#N,#N -->` 依存関係
  - `<!-- progress-mode:checkbox|manual|binary -->` + `<!-- progress:値 -->`
- ドラッグでバー移動/リサイズ（日程変更、API自動保存）
- ホバーツールチップ（タイトル、日程、進捗、担当者）
- クリティカルパス常時赤色表示 + CPラベルトグル
- バーの色カスタマイズ（6種類: デフォルト/進行中/ブロック/完了/CP/優先高、localStorage永続化）
- 遅延/前倒し表示（赤い延長バー / 前倒しテキスト）
- 開始日>終了日の自動補正（パーサー/モーダル/ドラッグの3箇所）
- 先行タスク登録時のIssue検索サジェスト
- Issue作成フォームからガント日程設定
- マイルストーン単位フィルタ + 担当者/状態/分野フィルタ
- タイムスケール切替 (日/週/月)
- 仮想スクロール、マウスドラッグスクロール、横スクロールバー

## イベント通知タイプ
`issue_created`, `routine_created`, `issue_closed`, `issue_reopened`,
`status_changed`, `comment_added`, `todo_toggled`, `issue_promoted`, `issue_updated`

## コーディング規約
- ハードコードの色・サイズは使わない → CSS変数 (`--text-primary`, `--bg-secondary` 等)
- 変更後は必ず `npx tsc --noEmit` で型チェック
- Rust変更時は `cargo check` も実行
- Issue削除機能は実装しない（GitHub上で直接行う方針）
- グローバルフォールバックのような暗黙の動作は避ける
- メモ/Issue作成は楽観的UX（即座にフォームリセット→バックグラウンドでAPI）

## ラベル体系
`カテゴリ:値` 形式:
- `状態:未整理` / `状態:進行中` / `状態:ブロック` / `状態:いつか`
- `優先:高` / `優先:中` / `優先:低`
- `分野:仕事` / `分野:生活` / etc.
- `種別:ルーチン` / `種別:バグ` / `種別:メモ` / `種別:イシュー`

## milestone解除のAPI仕様
- TypeScript: `updateIssue(n, { milestone: null })` → useGitHub内で `null` を `0` に変換
- Rust: `milestone: Option<u32>` で `Some(0)` → GitHub APIに `"milestone": null` を送信
- `None` = 変更しない, `Some(0)` = 解除, `Some(n)` = 設定

## リリースフロー
1. `release.bat` 実行 → `scripts/release.ps1` が起動
2. バージョン入力 → package.json, tauri.conf.json, Cargo.toml を更新
3. `npm run tauri build` 実行
4. 署名付き .exe + latest.json 自動生成
5. GitHub Releases にアップロード
