# Life Manager — CLAUDE.md

## プロジェクト概要
Tauri 2.0 (Rust + React/TypeScript) のGitHub Issues ベースタスク管理デスクトップアプリ。
GitHub Issues/Milestones/Labels をバックエンドストレージとして利用。

## 技術スタック
- **フロントエンド**: React 18 + TypeScript + Vite
- **バックエンド**: Rust (Tauri 2.0)
- **API**: GitHub REST API (Fine-grained PAT)
- **通知**: Discord Webhook + OS通知 (tauri-plugin-notification)
- **自動更新**: tauri-plugin-updater (minisign署名)
- **キー管理**: OS キーチェーン (keyring クレート)

## ビルド・開発
```bash
npm run dev          # 開発サーバー起動
npx tsc --noEmit     # 型チェック（変更後必ず実行）
release.bat          # リリースビルド（バージョンbump + ビルド + latest.json生成）
```

## 主要ディレクトリ
```
src/
├── App.tsx, App.css         # メインアプリ、グローバルCSS
├── hooks/useGitHub.ts       # GitHub API操作の中央フック
├── lib/
│   ├── types.ts             # 型定義
│   ├── ganttTypes.ts        # ガントチャート型定義
│   ├── ganttParser.ts       # Issueメタデータ↔GanttTask変換
│   └── ganttRenderer.ts     # Canvas描画エンジン
├── components/common/       # 共通コンポーネント
│   ├── IssueDetailModal.tsx  # Issue詳細（ガントメタデータ編集含む）
│   └── ...
└── components/views/
    ├── DashboardView.tsx     # タスク一覧
    ├── KanbanView.tsx        # カンバンボード
    ├── GanttView.tsx         # ガントチャート（Canvas + 仮想スクロール）
    └── ...

src-tauri/src/
├── lib.rs                   # Tauriコマンド定義
├── github/client.rs         # GitHub REST APIクライアント
├── scheduler/routine.rs     # ルーチンIssue自動作成
└── ...
```

## ガントチャート (v0.3.0) — 実装状況

### 完了
- Canvas描画エンジン (ganttRenderer.ts): グリッド、日付ヘッダー、今日線、バー、依存矢印
- Issue body内のHTMLコメントメタデータ:
  - `<!-- gantt:YYYY-MM-DD/YYYY-MM-DD -->` 開始/終了日
  - `<!-- depends:#N,#N -->` 依存関係
  - `<!-- progress-mode:checkbox|manual|binary -->` + `<!-- progress:値 -->`
- IssueDetailModalでガントメタデータ編集UI
- マイルストーン単位フィルタ + 担当者/状態/分野フィルタ
- タイムスケール切替 (日/週/月)
- 仮想スクロール (1000+ Issue対応設計)
- 依存関係矢印 (S字カーブ + 行間迂回ルート)
- マウスドラッグスクロール (Canvas上でドラッグ&ドロップ)
- 横スクロールバー (上部固定、ドラッグ対応)
- マイルストーン選択のlocalStorage記憶
- 左パネル「Issue」ヘッダー固定
- マイルストーン「なし」設定 (milestone=0で解除)

### 未実装・改善候補
- ドラッグでバー移動/リサイズ（日程変更）
- ツールチップ（バーホバーで詳細表示）
- クリティカルパス表示
- バーの色のカスタマイズ
- エクスポート機能

## コーディング規約
- ハードコードの色・サイズは使わない → CSS変数 (`--text-primary`, `--bg-secondary` 等)
- 変更後は必ず `npx tsc --noEmit` で型チェック
- Issue削除機能は実装しない（GitHub上で直接行う方針）
- グローバルフォールバックのような暗黙の動作は避ける

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
