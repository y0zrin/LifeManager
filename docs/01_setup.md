# Life Manager — 環境構築手順

## 前提条件

以下がインストール済みであることを確認してください。

### 必須
- **Rust** (rustup): https://rustup.rs/
- **Node.js** (v18以上): https://nodejs.org/
- **Git**: https://git-scm.com/

### Tauri 2.0 の追加要件 (Windows)
- **Microsoft Visual Studio C++ Build Tools**
- **WebView2** (Windows 10/11 にはプリインストール済み)

確認コマンド:
```powershell
rustc --version     # 1.77.0 以上
cargo --version
node --version      # v18 以上
npm --version
git --version
```

---

## Step 1: Tauri CLI のインストール

```powershell
cargo install create-tauri-app
cargo install tauri-cli --version "^2"
```

## Step 2: プロジェクト初期化

```powershell
cd D:\creative\LifeManager

# Tauri 2.0 プロジェクトを作成
# 対話式プロンプトで以下を選択:
#   Project name: life-manager
#   Frontend language: TypeScript
#   Package manager: npm
#   UI template: React
#   UI flavor: TypeScript

cargo create-tauri-app life-manager
```

## Step 3: 依存関係のインストール

```powershell
cd life-manager
npm install
```

## Step 4: 動作確認

```powershell
# 開発サーバー起動（デスクトップ）
cargo tauri dev
```

ウィンドウが表示されれば成功。

## Step 5: Rust側の追加クレート

`src-tauri/Cargo.toml` の `[dependencies]` に以下を追加:

```toml
[dependencies]
# 既存のtauri依存に加えて:
reqwest = { version = "0.12", features = ["json"] }  # HTTP client (GitHub API)
serde = { version = "1", features = ["derive"] }      # シリアライズ
serde_json = "1"                                       # JSON
serde_yaml = "0.9"                                     # YAML (routines.yaml)
tokio = { version = "1", features = ["full"] }         # 非同期ランタイム
chrono = { version = "0.4", features = ["serde"] }     # 日時処理
keyring = "3"                                          # OS Keychain (トークン保存)
```

追加後:
```powershell
cd src-tauri
cargo check  # コンパイル確認
```

---

## Step 6: 完了後の連絡

ここまで完了したら、以下を教えてください:
1. `cargo tauri dev` でウィンドウが表示されたか
2. `cargo check` がエラーなく通ったか
3. 生成されたディレクトリ構造（`dir /s /b` の出力）

その後、Rustバックエンドとフロントエンドの実装に入ります。
