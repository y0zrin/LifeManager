//! LifeManager を使う準備: Git が入っているか、コミットに使う名前とメールアドレスが決まっているか。
//! Git が無ければインストールする（Windows は winget、使えなければ公式のインストーラーを取ってくる。macOS はコマンドライン ツール）
use super::runner::{forget_git_program, hide_console_window, run, GitRun};
use serde::Serialize;
use std::process::Command;

#[derive(Debug, Serialize)]
pub struct SetupStatus {
    /// Git のバージョン（入っていなければ None）
    pub git: Option<String>,
    /// コミットに使う名前・メールアドレス（git config user.name / user.email。決まっていなければ None）
    pub user_name: Option<String>,
    pub user_email: Option<String>,
    /// この PC で使えるインストールの方法（"winget" / "download" / "xcode"）。自動では入れられないときは None
    pub installer: Option<String>,
}

pub fn setup_status() -> SetupStatus {
    // リポジトリの外（一時フォルダ）で調べる。--global に限らず、git がふだん使う設定を読む
    let temp = std::env::temp_dir();
    let git = run(&temp, &["--version"])
        .ok()
        .map(|r| r.output.trim().trim_start_matches("git version ").to_string());
    let config = |key: &str| {
        run(&temp, &["config", "--get", key])
            .ok()
            .map(|r| r.output.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let (user_name, user_email) = if git.is_some() { (config("user.name"), config("user.email")) } else { (None, None) };
    SetupStatus { git, user_name, user_email, installer: install_method() }
}

fn install_method() -> Option<String> {
    if cfg!(windows) {
        let mut probe = Command::new("winget");
        probe.arg("--version");
        hide_console_window(&mut probe);
        let winget = probe.output().map(|o| o.status.success()).unwrap_or(false);
        Some(if winget { "winget" } else { "download" }.to_string())
    } else if cfg!(target_os = "macos") {
        Some("xcode".to_string())
    } else {
        None
    }
}

/// コミットに使う名前とメールアドレスを決める（この PC のすべてのリポジトリで使う）
pub fn set_identity(name: &str, email: &str) -> Result<GitRun, String> {
    let name = name.trim();
    let email = email.trim();
    if name.is_empty() {
        return Err("名前を入力してください".into());
    }
    if !email.contains('@') || email.starts_with('-') {
        return Err("メールアドレスを入力してください".into());
    }
    let temp = std::env::temp_dir();
    let a = run(&temp, &["config", "--global", "user.name", name])?;
    let b = run(&temp, &["config", "--global", "user.email", email])?;
    Ok(GitRun { command: format!("{} && {}", a.command, b.command), output: String::new() })
}

// --- Git のインストール ---

#[cfg(windows)]
const WINGET_ARGS: [&str; 9] = [
    "install",
    "--id",
    "Git.Git",
    "-e",
    "--source",
    "winget",
    "--accept-package-agreements",
    "--accept-source-agreements",
    "--silent",
];

#[cfg(windows)]
enum WingetError {
    /// winget が無い（公式のインストーラーで入れる）
    Missing,
    Failed(String),
}

/// winget で Git を入れる（途中で管理者の確認が出る）
#[cfg(windows)]
fn install_with_winget() -> Result<GitRun, WingetError> {
    let command = format!("winget {}", WINGET_ARGS.join(" "));
    let mut cmd = Command::new("winget");
    cmd.args(WINGET_ARGS);
    hide_console_window(&mut cmd);
    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            WingetError::Missing
        } else {
            WingetError::Failed(format!("{}\n{}", command, e))
        }
    })?;
    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        return Ok(GitRun { command, output: stdout });
    }
    // winget の出力は進み具合の表示が多いので、最後の数行だけ見せる
    let text = format!("{}\n{}", stdout, String::from_utf8_lossy(&out.stderr));
    let tail: Vec<&str> = text.lines().map(|l| l.trim()).filter(|l| !l.is_empty()).collect();
    let tail = tail[tail.len().saturating_sub(4)..].join("\n");
    Err(WingetError::Failed(format!("{}\n{}", command, tail)))
}

/// winget が無い PC では、Git for Windows の公式のインストーラーを GitHub から取ってきて動かす
#[cfg(windows)]
async fn install_with_download() -> Result<GitRun, String> {
    let client = reqwest::Client::builder().user_agent("LifeManager").build().map_err(|e| e.to_string())?;
    let release: serde_json::Value = client
        .get("https://api.github.com/repos/git-for-windows/git/releases/latest")
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Git のインストーラーの場所を調べられませんでした: {}", e))?
        .json()
        .await
        .map_err(|e| e.to_string())?;
    let suffix = if cfg!(target_arch = "aarch64") { "-arm64.exe" } else { "-64-bit.exe" };
    let asset = release["assets"]
        .as_array()
        .and_then(|assets| {
            assets.iter().find(|a| {
                let name = a["name"].as_str().unwrap_or("");
                name.starts_with("Git-") && name.ends_with(suffix)
            })
        })
        .ok_or("Git のインストーラーが見つかりませんでした")?;
    let name = asset["name"].as_str().unwrap_or("Git-setup.exe").to_string();
    let url = asset["browser_download_url"].as_str().ok_or("Git のインストーラーが見つかりませんでした")?;
    let bytes = client
        .get(url)
        .send()
        .await
        .and_then(|r| r.error_for_status())
        .map_err(|e| format!("Git のインストーラーを取ってこられませんでした: {}", e))?
        .bytes()
        .await
        .map_err(|e| e.to_string())?;
    let path = std::env::temp_dir().join(&name);
    std::fs::write(&path, &bytes).map_err(|e| e.to_string())?;

    // /SILENT: 質問はせずに進み具合だけ出す（管理者の確認は出る）
    let args = ["/SILENT", "/NORESTART", "/SP-", "/SUPPRESSMSGBOXES"];
    let command = format!("{} {}", name, args.join(" "));
    let status = tauri::async_runtime::spawn_blocking(move || Command::new(&path).args(args).status())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| format!("{}\n{}", command, e))?;
    if !status.success() {
        return Err(format!("{}\nインストールが終わりませんでした（取り消したか、失敗しました）", command));
    }
    Ok(GitRun { command, output: String::new() })
}

/// Git をインストールする。終わったら、次の git の呼び出しで入れた Git を探し直す
pub async fn install_git() -> Result<GitRun, String> {
    let result = install_for_this_os().await;
    forget_git_program();
    result
}

#[cfg(windows)]
async fn install_for_this_os() -> Result<GitRun, String> {
    match tauri::async_runtime::spawn_blocking(install_with_winget).await.map_err(|e| e.to_string())? {
        Ok(run) => Ok(run),
        Err(WingetError::Missing) => install_with_download().await,
        Err(WingetError::Failed(message)) => Err(message),
    }
}

#[cfg(target_os = "macos")]
async fn install_for_this_os() -> Result<GitRun, String> {
    // Git が入ったコマンドライン ツールのインストール画面を出す（進めるのは画面の方で行う）
    Command::new("xcode-select")
        .arg("--install")
        .spawn()
        .map_err(|e| format!("xcode-select --install\n{}", e))?;
    Ok(GitRun {
        command: "xcode-select --install".into(),
        output: "表示された画面で「インストール」を押してください。終わったら、もう一度確認します".into(),
    })
}

#[cfg(not(any(windows, target_os = "macos")))]
async fn install_for_this_os() -> Result<GitRun, String> {
    Err("この OS では自動でインストールできません。パッケージマネージャーで git を入れてください（例: sudo apt install git）".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_empty_identity() {
        assert!(set_identity("  ", "a@example.com").is_err());
        assert!(set_identity("学生", "not-an-address").is_err());
    }
}
