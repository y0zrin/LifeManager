# Life Manager — CLAUDE.md

## プロジェクト概要
Tauri 2.0 (Rust + React/TypeScript) のGitHub Issues ベースタスク管理デスクトップアプリ。
GitHub Issues/Milestones/Labels をバックエンドストレージとして利用。

## 現在のバージョンと次の作業
- **現在**: v0.3.2 リリース済み
- **次回**: v0.4.0 "Depth" — Issue関連機能の大幅強化
- **ロードマップ詳細**: メモリの `next_tasks.md` を参照

### v0.4.0 計画
1. サブイシュー（GitHub Native API GA。親子階層、ツリー表示）
2. ラベル改善（AND/ORフィルタ）
3. 一括操作（複数Issue選択→クローズ/ラベル/マイルストーン一括変更）
4. Issue並び替え（優先度/更新日/作成日/期限）
5. Issueテンプレート（種別ごとのbody定型文）
6. 期限の第一級表示（カード/ダッシュボードに期限日常時表示、超過赤ハイライト）
7. 関連Issue（「関連」「重複」リンク。依存とは別の意味的関連付け）
8. アクティビティ履歴（GitHub Timeline APIで変更履歴をコメント風に表示）

## 技術スタック
- **フロントエンド**: React 19 + TypeScript + Vite
- **バックエンド**: Rust (Tauri 2.0)
- **API**: GitHub REST API (Fine-grained PAT)
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
├── hooks/useGitHub.ts       # GitHub API操作の中央フック（907行、v0.6.0前に分割予定）
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
