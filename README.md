# Life Manager

GitHubリポジトリをバックエンドとしたデスクトップ向けタスク管理ツール。
Issue・マイルストーン・ラベルをそのまま活用し、独自のUIで日々のタスクを管理する。

## 必要なもの

- GitHubアカウント
- GitHub Personal Access Token（`repo` スコープ）
- 管理用のGitHubリポジトリ（新規でも既存でも可）

## セットアップ

### 1. リポジトリを用意する

GitHubに管理用のリポジトリを作成する。プライベートリポジトリ推奨。

### 2. Personal Access Tokenを発行する

1. GitHub → Settings → Developer settings → [Personal access tokens](https://github.com/settings/tokens)
2. **Fine-grained token（推奨）** または Classic token を作成
3. 必要な権限:
   - **Issues**: Read and Write
   - **Contents**: Read and Write（ルーチン・通知設定の保存に使用）
   - **Metadata**: Read（自動付与）
4. 対象リポジトリを管理用リポジトリに限定する（Fine-grained tokenの場合）

### 3. アプリを起動する

初回起動時にセットアップ画面が表示される。

1. リポジトリの **オーナー名** と **リポジトリ名** を入力
2. 発行した **トークン** を入力
3. 「接続してはじめる」

トークンはOSのキーチェーン（Windows: 資格情報マネージャー / macOS: Keychain）に保存される。

### 4. ラベルを初期化する

設定画面 → ラベル管理 → 「ラベル一括作成」でLife Manager用のラベル体系がセットアップされる。

| カテゴリ | ラベル例 | 用途 |
|---------|---------|------|
| 種別 | 種別:イシュー, 種別:メモ, 種別:ルーチン | Issueの分類 |
| 分野 | 分野:仕事, 分野:私用, 分野:学習 など | 領域の分類 |
| 状態 | 状態:未整理, 状態:進行中, 状態:ブロック, 状態:いつか | 進捗管理 |
| 優先 | 優先:高, 優先:中, 優先:低 | 優先度 |

## 主な機能

### ダッシュボード

Issueの一覧表示。ラベルによるフィルタリング、ステータス変更、クローズ/リオープンが可能。

### メモ投入

`Ctrl+K` でコマンドパレットを開き、テキストを入力するだけでメモ（種別:メモ ラベル付きIssue）として投入できる。あとからイシューに昇華可能。

### ボード（カンバン）

状態ラベルに基づいたカンバンボード。ボードのカラム構成は設定画面でカスタマイズ可能。

### マイルストーン

期限付きの目標管理。Issue をマイルストーンに紐づけて進捗を可視化。

### ルーチン

繰り返しタスクの自動Issue作成。`config/routines.yaml` としてリポジトリに保存される。

### ガントチャート

マイルストーン内のIssueをガントチャートで可視化。Canvas描画による高速レンダリング。

- マイルストーン単位でIssueをタイムラインに表示
- 担当者・状態・分野によるフィルタリング
- タイムスケール切替（日 / 週 / 月）
- Issue間の依存関係を矢印で表示
- 進捗率の可視化（チェックボックス / 手動 / 達成可否）
- マウスドラッグでスクロール、横スクロールバー

**ガントメタデータ（Issue本文に埋め込み）:**

Issue詳細画面の「ガントチャート」セクションから設定する。本文にHTMLコメントとして保存される。

```
<!-- gantt:2026-03-10/2026-03-20 -->    開始日/終了日
<!-- depends:#12,#15 -->                依存関係（先行タスク）
<!-- progress-mode:manual -->           進捗モード（checkbox / manual / binary）
<!-- progress:60 -->                    手動進捗値
```

### タイムライン

日付ごとのジャーナル生成・閲覧。

### リマインダー

Issue単位でリマインダーを設定。OS通知・Discord通知に対応。

## 通知

### Discord Webhook

設定画面でプロジェクトごとにDiscord Webhook URLを登録すると、各種イベントがDiscordに通知される。通知にはIssueへのリンクが含まれる。

**設定手順:**

1. Discordでサーバーの「サーバー設定」→「連携サービス」→「ウェブフック」
2. 「新しいウェブフック」を作成し、通知先チャンネルを選択
3. 「ウェブフックURLをコピー」
4. Life Manager の設定画面 → Discord Webhook通知 に貼り付けて保存

**Webhookの解除:** 入力欄を空にして「解除」ボタンを押す。

> **スマホで通知が届かない場合:** Androidではバッテリー最適化によりDiscordのバックグラウンド通知が抑制されることがある。Discord → バッテリー設定 →「制限なし」に変更する。また、PC版Discordを起動したままだとスマホへの通知が抑制されるため、PC版を終了するか全デバイスでログアウトして整理する。

### イベント通知

以下のイベントごとに通知の有効/無効、通知先（OS / Discord）を設定できる。

- Issue作成 / 完了 / 再開 / 状態変更
- コメント追加 / チェックボックス操作
- メモ昇華 / Issue編集

### 通知スケジュール

定時通知（今日のタスク一覧、期限超過チェックなど）をスケジュール設定可能。

## 複数プロジェクト

複数のGitHubリポジトリをプロジェクトとして登録し、ヘッダーのドロップダウンから切り替えできる。

- プロジェクトごとに個別のトークンを設定可能（未設定時はグローバルトークンを使用）
- Discord Webhookもプロジェクトごとに個別設定

### トークンの解決順序

アプリ起動時・プロジェクト切替時のトークン解決:

1. **プロジェクト固有トークン** (`project-token-{owner}/{repo}`) → 設定されていればこれを使用
2. **グローバルトークン** (`github-token`) → フォールバック

Fine-grained PATでリポジトリごとに異なるトークンを使い分ける場合でも、起動時に正しいトークンが選択される。

## チームでの利用

### Organization の利用を推奨

2人以上で継続的に作業する場合は、**GitHub Organization**（無料）を利用することを推奨する。

| | 個人リポジトリ | Organization |
|---|---|---|
| 権限管理 | Collaborator単位 | Team単位で一括管理 |
| リポジトリ所有 | 個人に紐づく | Orgに紐づく（人が抜けても残る） |
| Fine-grained PAT | オーナーのみリポ個別指定可能 | **メンバー全員がリポ個別指定可能** |

### Fine-grained PAT の制限事項

Fine-grained PATでリポジトリを個別指定する場合、選択肢に表示されるのは**自分がオーナーのリポジトリ**と**所属Organization内のリポジトリ**のみ。他人の個人リポジトリにCollaboratorとして招待されたものは表示されない。

**対処法:**

| 方法 | 説明 |
|------|------|
| Organization に移行 | メンバー全員がFine-grainedでリポ個別指定可能になる |
| Classic PAT を使用 | `repo`スコープで招待先リポジトリにもアクセス可能 |
| Fine-grained「All repositories」 | 全リポジトリ対象（スコープが広い） |

Life Managerではプロジェクトごとにトークンを設定できるため、自分のリポにはFine-grained、招待リポにはClassicと使い分けが可能。

### トークンについて

GitHub PATは**個人アカウントに紐づく**。チームで利用する場合:

- **各メンバーが自分のPATを発行する**（他人のトークンでは操作が全てそのアカウント名義になる）
- リポジトリのリンクだけではアクセス不可。必ずCollaboratorとして追加（またはOrgメンバーとして招待）が必要

### チーム運用の手順

#### 既存リポジトリを Organization に移行する

すでに個人アカウントで運用しているリポジトリを Organization に移すことができる。

1. Organization を作成（未作成の場合: Settings → Organizations → New organization、Freeプランで可）
2. リポジトリの Settings → General → 最下部「**Danger Zone**」→「**Transfer ownership**」
3. 移行先に Organization 名を入力し、確認して転送
4. リポジトリの URL が `個人名/リポ名` → `org名/リポ名` に変わる
5. 各メンバーの Life Manager でプロジェクト設定のオーナー名を Organization 名に更新
6. 各メンバーが Fine-grained PAT を再発行（Resource owner を Organization に変更し、対象リポジトリを選択）

> **注意**: 転送後、旧URLからのリダイレクトは一定期間有効だが、GitHub API のエンドポイントは新URL（`org名/リポ名`）を使用する必要がある。Issue番号やデータはすべて維持される。

#### Organization を使う場合（推奨）

**リポジトリ所有者（リーダー）が行うこと:**

1. GitHub Organizationを作成（Settings → Organizations → New organization、Freeプランで可）
2. Organization内にリポジトリを作成（Private推奨）
3. メンバーをOrganizationに招待（Organization Settings → Members → Invite member）
4. メンバーに **Write** 以上のロールを付与（Issue操作・Contents書き込みに必要）

**各メンバーが行うこと:**

1. Organization招待を承認
2. GitHub → Settings → Developer settings → [Fine-grained tokens](https://github.com/settings/personal-access-tokens/new) でPATを発行
3. トークン設定:
   - **Resource owner**: Organization名を選択
   - **Repository access**: 「Only select repositories」→ 対象リポジトリを選択
   - **Permissions**:

     | Permission | Access | 用途 |
     |-----------|--------|------|
     | **Issues** | Read and Write | Issue・コメントの作成/編集/クローズ |
     | **Contents** | Read and Write | ルーチン・通知設定・ボード設定の保存 |
     | **Metadata** | Read | 自動付与（リポジトリ情報の取得） |

4. Life Managerにトークンとリポジトリ（`org名/リポ名`）を設定

#### 個人リポジトリの場合

**リポジトリ所有者（リーダー）が行うこと:**

1. リポジトリを作成（Private推奨）
2. メンバーをCollaboratorとして招待（Settings → Collaborators → Add people）
3. メンバーに **Write** 以上のロールを付与

**各メンバーが行うこと:**

1. Collaborator招待を承認
2. Fine-grained PATでは招待先リポジトリを個別指定**できない**ため、以下のいずれかでトークンを発行:
   - **Classic PAT**（`repo`スコープ）— 簡単だがスコープが広い
   - **Fine-grained PAT**（「All repositories」）— リポジトリ限定不可
3. Life Managerにトークンとリポジトリを設定

> **注意**: リポジトリ所有者本人はFine-grained PATでリポジトリ個別指定が可能。制限があるのはCollaboratorとして招待された側のみ。

## 技術スタック

| Layer | Technology |
|-------|-----------|
| Framework | Tauri 2.0 |
| Frontend | React 19 + TypeScript 5.8 |
| Backend | Rust |
| Build | Vite 7 + Tauri CLI |
| Data | GitHub REST API (Issues, Labels, Milestones, Contents) |
| HTTP | reqwest 0.12 (rustls-tls) |
| Async | Tokio 1 |
| Auth | OS Keyring (Windows Credential Manager) |
| Config | YAML (routines, reminders, board config) |
| Platforms | Windows, Android |

### Rust Dependencies (src-tauri/Cargo.toml)

| Crate | Purpose |
|-------|---------|
| tauri 2.x | Application framework |
| serde / serde_json / serde_yaml | Serialization (JSON, YAML) |
| reqwest 0.12 | GitHub API HTTP client |
| tokio 1 | Async runtime |
| chrono 0.4 | Date/time handling |
| base64 0.22 | Base64 encoding |
| keyring 3 | OS credential storage |
| tauri-plugin-notification | OS notifications |
| tauri-plugin-updater | In-app auto update |
| tauri-plugin-process | Process management (relaunch) |
| tauri-plugin-opener | External URL/file open |

### Frontend Dependencies (package.json)

| Package | Purpose |
|---------|---------|
| react 19 / react-dom | UI framework |
| @tauri-apps/api | Tauri IPC bridge |
| @tauri-apps/plugin-* | Plugin frontend bindings |
| vite 7 | Build tool / dev server |
| typescript 5.8 | Type checking |

## Architecture

```
src/                              # Frontend (React/TypeScript)
├── App.tsx                       # Root component, routing
├── App.css                       # Global styles (CSS custom properties)
├── hooks/
│   └── useGitHub.ts              # Central state management hook
├── lib/
│   ├── types.ts                  # Type definitions
│   ├── ganttTypes.ts             # Gantt chart type definitions
│   ├── ganttParser.ts            # Issue metadata ↔ GanttTask conversion
│   └── ganttRenderer.ts          # Canvas rendering engine
├── components/
│   ├── common/                   # Shared components
│   │   ├── CommandPalette.tsx    # Ctrl+K quick actions
│   │   ├── DatePickerButton.tsx  # Native date picker wrapper
│   │   ├── IssueCard.tsx         # Dashboard issue card
│   │   ├── IssueDetailModal.tsx  # Issue detail/edit modal
│   │   ├── LabelBadge.tsx        # Label color badge
│   │   ├── TaskListBody.tsx      # Checkbox task list
│   │   └── TicketCard.tsx        # Kanban compact card
│   └── views/                    # 7 main views
│       ├── DashboardView.tsx     # Issue list, create, filter
│       ├── KanbanView.tsx        # Kanban board (drag & drop)
│       ├── GanttView.tsx         # Gantt chart (Canvas + virtual scroll)
│       ├── MilestoneView.tsx     # Milestone management
│       ├── RoutinesView.tsx      # Routine configuration
│       ├── SettingsView.tsx      # Settings, labels, notifications
│       ├── SetupView.tsx         # Initial setup wizard
│       └── TimelineView.tsx      # Daily journal

src-tauri/                        # Backend (Rust)
├── src/
│   ├── lib.rs                    # 45 Tauri IPC commands
│   ├── credential.rs             # OS keyring abstraction
│   ├── github/client.rs          # GitHub REST API client
│   ├── journal/generator.rs      # Journal generation
│   ├── notify/discord.rs         # Discord webhook
│   └── scheduler/routine.rs      # Background task scheduler
├── tauri.conf.json               # Tauri config, updater, window
└── Cargo.toml
```

## Build

### Prerequisites

- Rust toolchain
- Node.js
- Android SDK + NDK (mobile build)

### Development

```bash
npm run tauri dev
```

### Release Build (Windows)

```
release.bat
```

Interactive: version bump → 3-file update → signed build → latest.json generation.

Outputs:
- `src-tauri/target/release/bundle/nsis/Life Manager_x.x.x_x64-setup.exe`
- `src-tauri/target/release/bundle/nsis/latest.json`

### Android Build

```bash
npm run tauri android build
```

Output: `src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk`

## Update Flow

1. `release.bat` で version bump + signed build + `latest.json` 自動生成
2. GitHub Release 作成 → `latest.json` + exe をアセットにアップロード
3. 利用者のアプリが起動時に `latest.json` を確認 → バナー表示 → ワンクリック更新
