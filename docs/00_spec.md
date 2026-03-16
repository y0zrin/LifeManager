# Life Manager — 仕様書 v0.1

> GitHubをバックエンドとした人生管理ツール
> 「行動の抽象化」をコードベースで実現する

---

## 1. 設計思想

本ツールの根本思想は「行動の抽象化」である。

人間の行動パターンを宣言的に定義し、実行可能な仕様としてGitHubリポジトリに記述する。
日々の生活はその仕様のインスタンスを生成・消化するプロセスとなる。

GitHubは貯蔵庫（バックエンド）として既に完成している。
本ツールが提供するのは以下の3つの機能レイヤーのみである:

1. **表示（GUI）** — 粒度に応じた適切なビューで情報を閲覧する
2. **通知（Notification）** — 必要なタイミングでユーザーにアクションを促す
3. **状態変更（Mutation）** — タスクの作成・更新・完了・昇華を行う

---

## 2. 粒度モデル（Granularity Model）

人生の行動を5つの粒度で階層化する。

```
Theme（テーマ）
 └── Milestone（マイルストーン）
      └── Issue（イシュー）
           └── Todo（タスク）
                └── Memo（メモ）
```

### 2.1 各粒度の定義

| 粒度 | 定義 | 例 | GitHubマッピング |
|------|------|-----|-----------------|
| **Theme** | 人生の領域カテゴリ。コンテキストの最上位単位 | 仕事、私用、やりたいことリスト、健康、学習 | Label (`theme:work`, `theme:personal`, `theme:wishlist`, `theme:health`, `theme:learning`) |
| **Milestone** | 中期目標。期限と達成条件を持つ | 2026Q2に副業月10万、年内にRust習得 | GitHub Milestone（期限・進捗率自動計算） |
| **Issue** | 具体的な成果単位。完了条件が明確 | LP作成、確定申告、引越し手続き | GitHub Issue |
| **Todo** | Issueを分解した作業ステップ | ヘッダーデザイン、書類記入、見積もり比較 | Issue内 Task List (`- [ ]` 記法) |
| **Memo** | タスク未満の思考の断片。将来Issueに昇華しうる | 「あのライブラリ試したい」「洗剤買う」 | Issue (`grain:memo` ラベル付き) |

### 2.2 昇華（Promotion）

Memoは他の粒度に昇華できる:

- **Memo → Issue**: `grain:memo` ラベルを削除し、本文を構造化。Issue番号は不変のため思いつき段階からの履歴が残る
- **Memo → Todo**: 既存Issueの Task List に追記
- **複数Memo → Issue**: 関連するMemoを束ねて新Issueを作成（元Memoはクロスリファレンスで参照）

### 2.3 ラベル体系（Tag System）

全Issueに対して以下のプレフィックス付きラベルを付与する:

```
粒度ラベル:
  grain:issue        — 通常のイシュー（デフォルト）
  grain:memo         — メモ・思いつき
  grain:routine      — ルーチン（自動生成タスク）

テーマラベル:
  theme:work         — 仕事
  theme:personal     — 私用
  theme:wishlist     — やりたいことリスト
  theme:health       — 健康
  theme:learning     — 学習
  （ユーザーが自由に追加可能）

状態ラベル:
  status:inbox       — 未整理（投入直後）
  status:active      — 進行中
  status:blocked     — ブロック中
  status:someday     — いつかやる
  （Note: Open/Closedはissue自体の状態で管理）

優先度ラベル:
  priority:high      — 高優先
  priority:medium    — 中優先
  priority:low       — 低優先
```

1つのIssueに複数テーマのラベルを付与できる（例: 転職 = `theme:work` + `theme:personal`）。

---

## 3. リポジトリ構成

単一の `life` リポジトリに全てを集約する。
コードを伴う大規模プロジェクトのみ別リポジトリとし、life側Issueからクロスリファレンスする。

```
life/
├── .github/
│   └── workflows/          # GitHub Actions（将来拡張用）
├── config/
│   └── routines.yaml       # ルーチン定義（行動の宣言的仕様）
├── journal/
│   ├── 2026-03-12.md       # 日次ログ（Rustバッチが自動生成）
│   └── ...
├── knowledge/               # ナレッジベース（任意のMarkdown）
│   ├── tech/
│   ├── books/
│   └── ...
├── README.md                # 人生のREADME（ビジョン・価値観・現在の注力事項）
└── CHANGELOG.md             # 大きな意思決定の記録
```

---

## 4. ルーチンシステム

### 4.1 routines.yaml

繰り返しタスクを宣言的に定義する。

```yaml
routines:
  - name: "朝の筋トレ"
    schedule:
      frequency: daily
      days: [mon, wed, fri]
      time: "07:00"
    issue:
      title: "筋トレ: {{date}}"
      labels: ["grain:routine", "theme:health"]
      body: |
        - [ ] ストレッチ 5分
        - [ ] スクワット 3セット
        - [ ] プランク 3セット
    auto_close: "23:59"

  - name: "週次レビュー"
    schedule:
      frequency: weekly
      day: sun
      time: "20:00"
    issue:
      title: "週次レビュー: {{week}}"
      labels: ["grain:routine", "theme:personal"]
      body: |
        - [ ] 今週のIssue棚卸し
        - [ ] 来週の優先順位設定
        - [ ] journal振り返り

  - name: "家賃振込"
    schedule:
      frequency: monthly
      day: 25
      time: "09:00"
    issue:
      title: "家賃振込: {{month}}"
      labels: ["grain:routine", "theme:personal", "priority:high"]
```

### 4.2 ルーチンのライフサイクル

1. GUIでルーチンを追加・編集 → `routines.yaml` が更新されコミット
2. Rustスケジューラが `routines.yaml` を監視
3. 該当日時にGitHub APIでIssueを自動生成
4. ユーザーがTodoをチェック → Issueをクローズ
5. `auto_close` 設定時は日次バッチで自動クローズ

---

## 5. 日次ログシステム

### 5.1 自動生成フロー

毎日23:59（または設定時刻）にRustバッチが以下を実行:

1. その日にCloseされたIssueを収集
2. その日に作成されたMemo (`grain:memo`) を収集
3. `journal/YYYY-MM-DD.md` としてMarkdownを生成しコミット

### 5.2 日次ログのフォーマット

```markdown
# 2026-03-12 (水)

## Completed
- [#42] LP作成 (theme:work)
- [#45] 筋トレ: 2026-03-12 (theme:health)

## Memos
- [#48] あのRustクレート試したい
- [#49] 歯医者の予約する

## Stats
- Closed: 3
- Created: 5
- Active: 12
```

---

## 6. アーキテクチャ

### 6.1 技術スタック

```
┌─────────────────────────────────────────┐
│              Tauri 2.0 App              │
│  ┌──────────────┐  ┌────────────────┐   │
│  │  Frontend    │  │  Rust Backend  │   │
│  │  (WebView)   │  │                │   │
│  │  - HTML/CSS  │◄►│  - GitHub API  │   │
│  │  - TypeScript│  │  - Scheduler   │   │
│  │  - React     │  │  - YAML Parser │   │
│  │              │  │  - Notifier    │   │
│  └──────────────┘  └───────┬────────┘   │
│                            │            │
│         Desktop & Mobile (Tauri 2.0)    │
└────────────────────────────┼────────────┘
                             │
                    GitHub API (REST/GraphQL)
                             │
                  ┌──────────┴──────────┐
                  │   life repository   │
                  │  - Issues           │
                  │  - Milestones       │
                  │  - Labels           │
                  │  - Markdown files   │
                  │  - routines.yaml    │
                  └─────────────────────┘
```

### 6.2 Rustバックエンド構成

```
src-tauri/src/
├── main.rs              # Tauriエントリポイント
├── github/
│   ├── mod.rs
│   ├── client.rs        # GitHub API クライアント
│   ├── issues.rs        # Issue CRUD
│   ├── milestones.rs    # Milestone CRUD
│   └── contents.rs      # ファイル読み書き（Contents API）
├── scheduler/
│   ├── mod.rs
│   ├── routine.rs       # routines.yaml パーサー & Issue生成
│   └── journal.rs       # 日次ログ生成
├── notification/
│   ├── mod.rs
│   ├── system.rs        # OS通知（デスクトップ）
│   ├── webhook.rs       # Slack/Discord Webhook
│   └── schedule.rs      # 通知スケジューリング
└── commands.rs          # Tauriコマンド（Frontend ⇔ Rust）
```

### 6.3 フロントエンド構成

```
src/
├── App.tsx
├── components/
│   ├── views/
│   │   ├── DashboardView.tsx    # 今日のダッシュボード
│   │   ├── KanbanView.tsx       # カンバンボード（状態別）
│   │   ├── TimelineView.tsx     # タイムライン（日次）
│   │   ├── MilestoneView.tsx    # マイルストーン一覧
│   │   └── JournalView.tsx      # 日次ログ閲覧
│   ├── forms/
│   │   ├── IssueForm.tsx        # Issue作成・編集
│   │   ├── MemoCapture.tsx      # メモ即時投入（最小UI）
│   │   └── RoutineForm.tsx      # ルーチン設定
│   ├── common/
│   │   ├── LabelBadge.tsx       # ラベル表示
│   │   ├── GrainIcon.tsx        # 粒度アイコン
│   │   └── FilterBar.tsx        # テーマ・状態フィルタ
│   └── layout/
│       ├── Sidebar.tsx          # テーマナビゲーション
│       └── CommandPalette.tsx   # クイックアクション（Cmd+K）
├── hooks/
│   ├── useIssues.ts
│   ├── useMilestones.ts
│   └── useRoutines.ts
└── lib/
    ├── tauri.ts                 # Tauriコマンド呼び出し
    └── types.ts                 # 型定義
```

---

## 7. GUI設計

### 7.1 画面一覧

| 画面 | 用途 | 主要操作 |
|------|------|---------|
| **Dashboard** | 今日やるべきことの一覧。朝最初に見る画面 | タスクチェック、メモ投入 |
| **Kanban** | 全Issueを状態別に俯瞰（Inbox / Active / Blocked / Done） | ドラッグ&ドロップでステータス変更 |
| **Timeline** | 日次のタイムライン。何をしたか振り返る | Journal閲覧、日付ナビゲーション |
| **Milestones** | 中期目標の進捗一覧。進捗率バー表示 | マイルストーン作成・Issue紐付け |
| **Routines** | ルーチン設定の管理画面 | 追加・編集・削除・一時停止 |
| **Memo Capture** | メモ即時投入。最小限のUI | Enter で即Issue作成 |

### 7.2 クイックアクション（Command Palette）

`Cmd+K` / `Ctrl+K` で呼び出し。モバイルでは画面下部のフローティングボタン。

- `m <text>` — メモ即時投入
- `i <text>` — Issue作成
- `/ <query>` — 全文検索
- `#<number>` — Issue番号でジャンプ
- `@<theme>` — テーマフィルタ

### 7.3 通知設計

| トリガー | チャネル | 内容 |
|---------|---------|------|
| 毎朝（設定時刻） | Slack + OS通知 | 今日の締切タスク一覧 |
| ルーチン時刻 | OS通知 | ルーチンタスクのリマインド |
| Issue期限当日 | Slack + OS通知 | 期限アラート |
| 期限超過 | Slack | 未完了タスク警告 |
| 週次レビュー | Slack | 週次サマリー |

---

## 8. 認証・セキュリティ

- GitHub OAuth App → Fine-grained Personal Access Token
- スコープ: `repo`（Issues, Milestones, Contents の読み書き）
- トークンはTauriセキュアストレージ（OS Keychain連携）に保存
- Slack Incoming Webhook URLもセキュアストレージに保存
- トークンを平文でファイルシステムに置かない

---

## 9. 開発ロードマップ

### Phase 1: Core（MVP）
- [ ] GitHub OAuth認証
- [ ] Issue CRUD（作成・一覧・更新・クローズ）
- [ ] ラベル体系の初期セットアップ
- [ ] Dashboard画面
- [ ] Memo Capture（即時投入）
- [ ] デスクトップ版ビルド

### Phase 2: Structure
- [ ] Milestone管理
- [ ] Kanban画面
- [ ] テーマフィルタリング
- [ ] Issue内Task Listの操作
- [ ] Command Palette

### Phase 3: Automation
- [ ] routines.yaml パーサー
- [ ] Rustスケジューラ（ルーチンIssue自動生成）
- [ ] 日次ログ自動生成
- [ ] Slack Webhook通知

### Phase 4: Mobile
- [ ] Tauri 2.0 モバイルビルド（iOS/Android）
- [ ] モバイル向けUI最適化
- [ ] プッシュ通知対応

### Phase 5: Intelligence
- [ ] 週次レビュー自動サマリー
- [ ] 期限超過分析
- [ ] テーマ別時間配分の可視化

---

## 10. 未決定事項

- [ ] フロントエンドのUIフレームワーク選定（React vs Solid vs Leptos）
- [ ] モバイル版でのバックグラウンドスケジューラの実現方法
- [ ] GitHub API レートリミット対策（キャッシュ戦略）
- [ ] オフライン時の挙動（ローカルキュー → オンライン時に同期）
- [ ] Discord対応の要否
- [ ] routines.yamlのバリデーションルール詳細
