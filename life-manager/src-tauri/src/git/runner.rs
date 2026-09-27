use serde::Serialize;
use std::path::Path;
use std::process::Command;

/// git の実行結果。画面に「実行したコマンド」を見せられるよう、表示用のコマンドも返す
#[derive(Debug, Clone, Serialize)]
pub struct GitRun {
    pub command: String,
    pub output: String,
}

/// 表示用のコマンド文字列（空白や引用符を含む引数だけ引用符で囲む）。
/// コミットのハッシュ（40 桁）は、画面のほかの場所と同じ 7 桁で見せる（実行するときは 40 桁のまま）
pub fn display_command(args: &[&str]) -> String {
    let mut parts = vec!["git".to_string()];
    for arg in args {
        if arg.len() == 40 && arg.bytes().all(|b| b.is_ascii_hexdigit()) {
            parts.push(arg[..7].to_string());
        } else if arg.is_empty() || arg.contains(char::is_whitespace) || arg.contains('"') {
            parts.push(format!("\"{}\"", arg.replace('"', "\\\"")));
        } else {
            parts.push(arg.to_string());
        }
    }
    parts.join(" ")
}

/// repo で git を実行する。失敗したときは、実行したコマンドと git のメッセージをまとめて返す
pub fn run(repo: &Path, args: &[&str]) -> Result<GitRun, String> {
    let command = display_command(args);
    let mut cmd = Command::new("git");
    // 日本語のファイル名をそのまま出す・色を付けない・端末での入力待ちをしない（認証は資格情報マネージャーに任せる）。
    // GIT_OPTIONAL_LOCKS=0: 状態の読み取り（定期的に行う）が、ほかの git の操作とロックでぶつからないようにする。
    // GIT_EDITOR=true: エディタを開く場面（rebase --continue など）では、用意されたメッセージのまま進める
    // （画面から動かしているので、エディタが開くと止まったままになってしまう）
    cmd.args(["-c", "core.quotepath=false", "-c", "color.ui=false"])
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_EDITOR", "true")
        .env("GIT_MERGE_AUTOEDIT", "no");
    hide_console_window(&mut cmd);

    let out = cmd.output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            "git が見つかりません。Git をインストールしてください（https://git-scm.com/）".to_string()
        } else {
            format!("{}\n{}", command, e)
        }
    })?;

    let stdout = String::from_utf8_lossy(&out.stdout).to_string();
    if out.status.success() {
        return Ok(GitRun { command, output: stdout });
    }
    let stderr = String::from_utf8_lossy(&out.stderr).trim().to_string();
    let message = if stderr.is_empty() { stdout.trim().to_string() } else { stderr };
    Err(format!("{}\n{}{}", command, message, hint_for(&message)))
}

/// よくある失敗に、次に何をすればよいかの一言を添える
fn hint_for(message: &str) -> &'static str {
    if message.contains("terminal prompts disabled") || message.contains("Authentication failed") {
        "\n→ GitHub へのログインが必要です。一度ターミナルで同じ git の操作をして、ログインを済ませてください"
    } else if message.contains("Could not resolve host") {
        "\n→ インターネットにつながっているか確認してください"
    } else if message.contains("[rejected]") || message.contains("non-fast-forward") {
        "\n→ GitHub 側に新しいコミットがあります。先にプルして取り込んでから、プッシュしてください"
    } else {
        ""
    }
}

/// Windows では、git を呼ぶたびにコンソールの窓が一瞬開かないようにする
#[cfg(windows)]
fn hide_console_window(cmd: &mut Command) {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NO_WINDOW);
}

#[cfg(not(windows))]
fn hide_console_window(_cmd: &mut Command) {}

#[cfg(test)]
mod tests {
    use super::{display_command, hint_for};

    #[test]
    fn quotes_only_arguments_that_need_it() {
        assert_eq!(display_command(&["commit", "-m", "READMEを更新"]), "git commit -m READMEを更新");
        assert_eq!(display_command(&["commit", "-m", "fix bug (#64)"]), "git commit -m \"fix bug (#64)\"");
        assert_eq!(display_command(&["commit", "-m", "say \"hi\""]), "git commit -m \"say \\\"hi\\\"\"");
        assert_eq!(
            display_command(&["cherry-pick", "9ba192d376af99e09155aa9feea1347f2de68848"]),
            "git cherry-pick 9ba192d"
        );
    }

    #[test]
    fn adds_hint_only_for_known_failures() {
        let auth = "fatal: could not read Username for 'https://github.com': terminal prompts disabled";
        assert!(hint_for(auth).contains("ログイン"));
        assert!(hint_for("fatal: unable to access '…': Could not resolve host: github.com").contains("インターネット"));
        assert!(hint_for(" ! [rejected]        feature -> feature (fetch first)").contains("プル"));
        assert_eq!(hint_for("error: pathspec 'x' did not match any file(s) known to git"), "");
    }
}
