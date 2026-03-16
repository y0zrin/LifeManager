# Life Manager — Claude Code 実装ガイド

> このドキュメントはClaude Codeが読み取ることで、本プロジェクトの全体像・設計思想・現在の実装状態・残りの作業を完全に把握できることを目的とする。

---

## 1. プロジェクト概要

**Life Manager** は、GitHubリポジトリをバックエンドとした人生管理デスクトップ/モバイルアプリである。

核心思想は「行動の抽象化」。人間の行動パターンを宣言的に定義し、GitHubリポジトリ上のIssue・Milestone・Labelとして管理する。本アプリはGitHub APIを叩くGUIクライアントであり、データの実体は全てGitHub上に存在する。

### 対象ユーザー
- GitHubユーザー名: `y0zrin`
- GitHubリポジトリ: `y0zrin/life`（Private）
- 対象OS: Windows（デスクトップ）→ iOS/Android（モバイル、将来）

---

## 2. 技術スタック

| レイヤー | 技術 | バージョン |
|---------|------|-----------|
| フレームワーク | Tauri 2.0 | ^2 |
| バックエンド | Rust | 1.94.0 |
| フロントエンド | React + TypeScript | React 19, TS 5.8 |
| ビルドツール | Vite | ^7 |
| HTTP通信 | reqwest | 0.12 |
| 非同期ランタイム | tokio | 1 |
| JSON処理 | serde / serde_json | 1 |
| 日時処理 | chrono | 0.4 |
| 秘密情報管理 | keyring | 3 (windows-native) |
| パッケージ管理 | npm + cargo | - |

---

## 3. プロジェクト構造

```
D:\creative\LifeManager\
├── docs/                          # 設計ドキュメント
│   ├── 00_spec.md                 # 仕様書 v0.1
│   ├── 01_setup.md                # 環境構築手順
│   ├── 02_discussion_log.md       # 設計議論ログ
│   ├── 03_work_steps.md           # 作業ステップ計画
│   └── CLAUDE.md                  # ★ このファイル
│
└── life-manager/                  # Tauri プロジェクトルート
    ├── package.json
    ├── tsconfig.json
    ├── vite.config.ts
    ├── index.html
    │
    ├── src/                       # フロントエンド（TypeScript/React）
    │   ├── main.tsx               # Reactエントリポイント
    │   ├── App.tsx                # メインアプリケーション（全画面の実装）
    │   └── App.css                # スタイルシート（GitHubライクなダークテーマ）
    │
    └── src-tauri/                 # バックエンド（Rust）
        ├── Cargo.toml
        ├── tauri.conf.json
        ├── src/
        │   ├── main.rs            # エントリポイント（lib::run()を呼ぶだけ）
        │   ├── lib.rs             # Tauriコマンド定義・アプリ起動
        │   └── github/
        │       ├── mod.rs         # モジュール宣言
        │       └── client.rs      # GitHub REST APIクライアント
        └── icons/                 # アプリアイコン
```

---

## 4. 粒度モデル（データ設計の核心）

人生の行動を5つの粒度で階層化し、GitHubの機能にマッピングする:

```
分野（テーマ）     → GitHub Label（プレフィックス: 分野:）
 └── マイルストーン → GitHub Milestone
      └── イシュー  → GitHub Issue
           └── Todo  → Issue本文内の Task List（- [ ] 記法）
                └── メモ → GitHub Issue（種別:メモ ラベル付き）
```

### ラベル体系（全て日本語）

```
種別ラベル:
  種別:イシュー   #0E8A16  具体的な成果単位
  種別:メモ       #FBCA04  思いつき・タスク未満の断片
  種別:ルーチン   #1D76DB  繰り返しタスク

分野ラベル:
  分野:仕事       #B60205  仕事関連
  分野:私用       #D93F0B  プライベート
  分野:やりたい   #F9D0C4  やりたいことリスト
  分野:健康       #0E8A16  健康・運動
  分野:学習       #5319E7  学習・スキルアップ

状態ラベル:
  状態:未整理     #C2E0C6  投入直後・未分類
  状態:進行中     #0075CA  着手済み
  状態:ブロック   #E4E669  外部要因で停止中
  状態:いつか     #D4C5F9  いつかやる

優先度ラベル:
  優先:高         #B60205
  優先:中         #FBCA04
  優先:低         #0E8A16
```

### 昇華（Promotion）

メモは他の粒度に昇華できる:
- **メモ → イシュー**: `種別:メモ` ラベルを `種別:イシュー` に変更。Issue番号は不変のため履歴が残る
- **メモ → Todo**: 既存Issueの本文にTask Listとして追記

---

## 5. 現在の実装状態

### Rust側（src-tauri/src/）

#### lib.rs — Tauriコマンド一覧

| コマンド名 | 引数 | 機能 |
|-----------|------|------|
| `get_app_version` | なし | バージョン文字列を返す |
| `set_token` | token: String | トークンをOS Keychainに保存しGitHubClientを初期化 |
| `load_token` | なし | OS Keychainからトークンを読みGitHubClientを復元 |
| `list_issues` | owner, repo, issue_state?(open/closed) | Issue一覧をJSON文字列で返す |
| `create_issue` | owner, repo, title, body, labels, milestone? | Issueを作成 |
| `update_issue` | owner, repo, issue_number, title?, body?, issue_state?, labels?, milestone? | Issueを更新（部分更新対応） |
| `list_labels` | owner, repo | ラベル一覧をJSON文字列で返す |
| `setup_labels` | owner, repo | 仕様で定義した15個のラベルを一括作成（既存はスキップ） |
| `list_milestones` | owner, repo | マイルストーン一覧をJSON文字列で返す |
| `create_milestone` | owner, repo, title, description, due_on? | マイルストーン作成 |
| `update_milestone` | owner, repo, milestone_number, title?, milestone_state? | マイルストーン更新 |

**重要な設計パターン:**
- 全コマンドは `tauri::State<'_, Mutex<Option<GitHubClient>>>` で共有状態にアクセス
- `tokio::sync::Mutex` を使用（std::sync::Mutexではない。async対応のため）
- トークンはOS Keychainに保存（keyringクレート、サービス名: "life-manager"、キー名: "github-token"）
- APIレスポンスはJSON文字列のまま返し、フロント側でパースする

#### github/client.rs — GitHub REST APIクライアント

- `GitHubClient` 構造体が `reqwest::Client` と `token` を保持
- 共通HTTPメソッド `get()`, `post()`, `patch()` でHTTPステータスチェックを統一
- POST/PATCHは非2xxレスポンスを `Err` として返す
- GETは全レスポンスをそのまま `Ok` で返す（GitHub APIのエラーもJSON文字列として返る）
- `BASE_URL` 定数で `https://api.github.com` を一元管理
- `per_page=100` をクエリパラメータで指定（ページネーション未実装）

### フロントエンド側（src/）

#### App.tsx — 単一ファイルに全画面を実装

4つのビュー（タブ切り替え）:
1. **ダッシュボード** — メモ即時投入バー、ラベルフィルタ、Issue作成フォーム、Issue一覧（IssueCard）
2. **カンバン** — 5カラム（未整理/進行中/ブロック/いつか/未分類）にIssueを分類表示
3. **マイルストーン** — 進捗率バー付きマイルストーン一覧、作成フォーム
4. **設定** — トークン入力、ラベル一括作成ボタン

共通UIコンポーネント:
- `LabelBadge` — カラーコードに応じた色付きバッジ
- `IssueCard` — Issue情報の表示、完了/再開/昇華/状態変更ボタン、Todoプログレスバー
- Command Palette（Ctrl+K）— `m テキスト` でメモ投入、`#番号` でジャンプ、`@ラベル` でフィルタ

**定数:**
- `OWNER = "y0zrin"` — GitHubユーザー名がハードコード
- `REPO = "life"` — リポジトリ名がハードコード

#### App.css — GitHubライクなダークテーマ
- 背景色: #0d1117（GitHub Dark）
- カードやヘッダー: #161b22
- ボーダー: #30363d
- アクセントカラー: #1f6feb（青）、#238636（緑）

---

## 6. 開発マイルストーン

### MS1: デスクトップ版完成（Phase 2完了 + デスクトップビルド）

**実装タスク:**

#### 6.1.1 ルーチンシステム（Phase 3の前倒し — デスクトップ版に含める）
- [ ] `config/routines.yaml` のスキーマ定義と パーサー（serde_yaml）
- [ ] Rustスケジューラ: `routines.yaml` を読み、該当日時にIssueを自動生成
  - Tauriのバックグラウンドタスクとして起動時にスケジューラを開始
  - `tokio::time::interval` で定期チェック
  - cronライクなスケジュール評価（daily/weekly/monthly + 曜日/日付指定）
  - テンプレート変数: `{{date}}`, `{{week}}`, `{{month}}` を展開
- [ ] Routines設定画面（フロントエンド）: GUI上でルーチンを追加・編集・削除
  - 裏で `routines.yaml` をGitHub Contents APIで読み書き
- [ ] `auto_close` 機能: 指定時刻に未完了のルーチンIssueを自動クローズ

routines.yaml のスキーマ例:
```yaml
routines:
  - name: "朝の筋トレ"
    schedule:
      frequency: daily       # daily | weekly | monthly
      days: [mon, wed, fri]  # daily時: 実行する曜日（省略で毎日）
      time: "07:00"          # 実行時刻 (Asia/Tokyo)
    issue:
      title: "筋トレ: {{date}}"
      labels: ["種別:ルーチン", "分野:健康"]
      body: |
        - [ ] ストレッチ 5分
        - [ ] スクワット 3セット
    auto_close: "23:59"      # 省略可。指定時刻に自動クローズ

  - name: "週次レビュー"
    schedule:
      frequency: weekly
      day: sun               # weekly時: 実行曜日
      time: "20:00"
    issue:
      title: "週次レビュー: {{week}}"
      labels: ["種別:ルーチン", "分野:私用"]
      body: |
        - [ ] 今週のIssue棚卸し
        - [ ] 来週の優先順位設定

  - name: "家賃振込"
    schedule:
      frequency: monthly
      day: 25                # monthly時: 実行日
      time: "09:00"
    issue:
      title: "家賃振込: {{month}}"
      labels: ["種別:ルーチン", "分野:私用", "優先:高"]
```

#### 6.1.2 日次ログシステム
- [ ] 毎日23:59（設定可能）にRustバッチが自動実行
- [ ] その日のCloseされたIssue + 作成されたメモを収集
- [ ] `journal/YYYY-MM-DD.md` としてMarkdownを生成
- [ ] GitHub Contents APIでリポジトリにコミット
- [ ] フロントにタイムライン画面を追加（日付ナビゲーション付き）

日次ログのフォーマット:
```markdown
# 2026-03-12 (水)

## 完了
- [#42] LP作成 (分野:仕事)
- [#45] 筋トレ: 2026-03-12 (分野:健康)

## メモ
- [#48] あのRustクレート試したい
- [#49] 歯医者の予約する

## 統計
- 完了: 3
- 作成: 5
- 進行中: 12
```

#### 6.1.3 通知システム
- [ ] OS通知（Tauri Notification API）
  - 毎朝: 今日の締切タスク一覧
  - ルーチン時刻: リマインド
  - Issue期限当日: アラート
- [ ] Slack Webhook通知
  - Incoming Webhook URLを設定画面で登録（Keychainに保存）
  - 通知内容をSlackチャンネルに送信
  - 期限超過の未完了タスク警告

#### 6.1.4 UIの完成度向上
- [ ] Issue詳細表示・編集モーダル（タイトル・本文・ラベルを直接編集）
- [ ] Issue本文内のTask List (`- [ ]`) をフロントからトグル操作で切り替え
  - update_issue で body を更新（`- [ ]` ↔ `- [x]` の文字列置換）
- [ ] カンバンのドラッグ&ドロップ（状態ラベルの変更）
- [ ] フロントエンドのコンポーネント分割（App.tsxが肥大化しているため）
  - `src/components/views/DashboardView.tsx`
  - `src/components/views/KanbanView.tsx`
  - `src/components/views/MilestoneView.tsx`
  - `src/components/views/SettingsView.tsx`
  - `src/components/views/TimelineView.tsx`（日次ログ閲覧）
  - `src/components/views/RoutinesView.tsx`（ルーチン設定）
  - `src/components/common/IssueCard.tsx`
  - `src/components/common/LabelBadge.tsx`
  - `src/components/common/CommandPalette.tsx`
  - `src/hooks/useGitHub.ts`（API呼び出しの共通化）
  - `src/lib/types.ts`（型定義の集約）
- [ ] OWNER / REPO を設定画面から変更可能にする（ハードコードの解消）
- [ ] GitHub APIレートリミット対策: ローカルキャッシュ（メモリ内、TTL付き）
- [ ] ページネーション対応（100件超のIssueがある場合）

#### 6.1.5 デスクトップ版ビルド
- [ ] `cargo tauri build` でWindowsインストーラ(.msi)を生成
- [ ] tauri.conf.json の productName, identifier, icon を最終調整
- [ ] Windows起動時の自動起動設定（任意）

#### 6.1.6 MS1 試用・改善
- [ ] 1週間の実運用テスト
- [ ] 発見された問題点・改善要望をリストアップ
- [ ] 軽微なバグ修正・UI改善を実施

---

### MS2: モバイル版（Tauri 2.0 iOS/Android）

**前提:**
- Tauri 2.0 はiOS/Androidをサポートしているが、まだ成熟途上
- デスクトップ版のRustバックエンドとフロントエンドを最大限共有する

**実装タスク:**

#### 6.2.1 モバイルビルド環境構築
- [ ] Android: Android Studio + Android SDK + NDK のセットアップ
- [ ] iOS: Xcode のセットアップ（macOSが必要）
- [ ] `cargo tauri android init` / `cargo tauri ios init` で初期化
- [ ] keyring クレートのモバイル対応確認
  - モバイルでは keyring の代わりに Tauri Secure Storage プラグインを使用する可能性あり
  - `tauri-plugin-store` 等の代替を検討

#### 6.2.2 モバイル向けUI最適化
- [ ] レスポンシブ対応: 画面幅に応じたレイアウト切り替え
- [ ] カンバンは横スクロールのまま（モバイルではスワイプ操作）
- [ ] メモ投入バーを画面下部に固定（モバイルのキーボードとの兼ね合い）
- [ ] タッチ操作の最適化（タップ領域の拡大、スワイプでIssueクローズ等）
- [ ] 画面遷移をタブバー（下部ナビゲーション）に変更

#### 6.2.3 モバイル固有の課題
- [ ] バックグラウンドスケジューラの実現方法
  - モバイルではアプリがバックグラウンドに回るとプロセスが停止する
  - 選択肢A: GitHub Actionsでcron駆動（サーバーレス、モバイル非依存）
  - 選択肢B: OS固有のバックグラウンドタスクAPI
  - 選択肢C: フォアグラウンド時のみスケジューラ実行
- [ ] プッシュ通知
  - Tauriのモバイル通知サポート状況を調査
  - 代替: Firebase Cloud Messaging (FCM) + GitHub Webhooks
- [ ] オフライン対応
  - ローカルキュー: オフライン時の操作をキューに溜め、オンライン復帰時に同期
  - 最低限: 読み取りはキャッシュから、書き込みはオンライン時のみ

#### 6.2.4 モバイルビルド・テスト
- [ ] Android APK/AAB の生成・実機テスト
- [ ] iOS IPA の生成・実機テスト

#### 6.2.5 MS2 試用・改善
- [ ] 1週間のモバイル実運用テスト（デスクトップと併用）
- [ ] 発見された問題点・改善要望をリストアップ
- [ ] 軽微なバグ修正・UI改善を実施

---

## 7. Rustコードの規約

本プロジェクトのコードは以下の規約に従う:

- `return` を明示的に書く（Rustの慣習とは異なるが、開発者の好み）
- 中括弧は次の行に置くスタイル（Allmanスタイル寄り — ただし現状はrustfmt適用済みで混在あり）
- コメントは日本語で記述
- エラーは `Result<String, String>` で返す（フロント側がエラーメッセージを直接表示するため）
- Tauriコマンドの引数名はcamelCase（フロントのJSから呼ばれるため。例: `issueState`, `issueNumber`）
- GitHub APIのレスポンスはJSON文字列のまま返す（Rust側でデシリアライズしない）

---

## 8. フロントエンドの規約

- CSSはApp.cssに集約（CSSモジュールやCSS-in-JSは使わない）
- GitHubダークテーマのカラーパレットに準拠
- `invoke()` の戻り値は `as string` でキャストし、`JSON.parse()` でパース
- エラーは `try-catch` で捕捉し、`setStatus()` でユーザーに表示
- `OWNER` と `REPO` は定数としてハードコード（MS1完了時に設定画面から変更可能にする）

---

## 9. 開発コマンド

```powershell
# 開発サーバー起動（ホットリロード付き）
cd D:\creative\LifeManager\life-manager
cargo tauri dev

# コンパイルチェック（Rustのみ、ビルドより高速）
cd src-tauri
cargo check

# デスクトップ版ビルド（インストーラ生成）
cargo tauri build

# Androidビルド（MS2）
cargo tauri android dev
cargo tauri android build

# iOSビルド（MS2、macOS必須）
cargo tauri ios dev
cargo tauri ios build
```

---

## 10. GitHub リポジトリの状態

リポジトリ `y0zrin/life` には以下が存在する:
- Issue #1: 「最初のメモ」（テスト用。grain:memo ラベル付き — 旧英語ラベル）
- ラベル: 日本語ラベル15個 + GitHubデフォルトラベル9個 + 旧英語ラベル（grain:memo）
  - 旧英語ラベルは手動削除するか放置してよい
- マイルストーン: なし
- ファイル: なし（READMEも未作成）

---

## 11. 注意事項・既知の課題

1. **GitHub APIレートリミット**: 認証済みで5000回/時。現在キャッシュなしなので、操作のたびにAPIを叩いている。Issue数が増えると問題になる
2. **ページネーション未対応**: `per_page=100` で取得しているが、100件超のIssueがある場合は取り切れない
3. **App.tsxの肥大化**: 全画面が1ファイルに入っている。MS1完了時にコンポーネント分割が必要
4. **keyringのモバイル非対応**: Windows Credential Managerに依存。モバイル版では代替が必要
5. **OWNER/REPOのハードコード**: 設定画面から変更可能にする必要がある
6. **GETリクエストのHTTPステータスチェック不足**: `get()` メソッドはステータスチェックせずに返している
7. **日本語ラベルのURLエンコード**: GitHub APIは日本語ラベルを扱えるが、URLに含める場合はエンコードが必要な場面がありうる
