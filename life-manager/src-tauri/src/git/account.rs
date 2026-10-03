//! git が GitHub に使うアカウント（#245）。
//! この PC の git（Git Credential Manager）は、URL に名前がなければ、覚えているアカウントで GitHub に行く。
//! アプリを別のアカウントで使っていると、そのアカウントの非公開のリポジトリが「見つからない」になるので、
//! URL にアプリのアカウントの名前を入れる（https://名前@github.com/持ち主/名前.git）。
//! そのアカウントの覚えがなければ、Git Credential Manager がログインの画面を出す
use super::runner::{run, GitRun};
use std::path::Path;

/// GitHub のアカウントの名前として正しいか（英数字と -。URL に入れても崩れない）
fn valid_login(login: &str) -> bool {
    !login.is_empty() && login.len() <= 39 && !login.starts_with('-') && login.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/// GitHub の https の URL に、アカウントの名前を入れる（前に入っていた名前は入れ替える）。
/// GitHub の https の URL でないもの（ssh・ほかのサイト）と、名前が正しくないときは、そのまま
pub fn with_account(url: &str, login: &str) -> String {
    let login = login.trim();
    let Some(rest) = url.strip_prefix("https://") else {
        return url.to_string();
    };
    if !valid_login(login) {
        return url.to_string();
    }
    // 「名前@」（または「名前:パスワード@」）は、最初の / より前にあるときだけ
    let host_and_path = match (rest.find('@'), rest.find('/')) {
        (Some(at), Some(slash)) if at < slash => &rest[at + 1..],
        (Some(at), None) => &rest[at + 1..],
        _ => rest,
    };
    if !host_and_path.to_ascii_lowercase().starts_with("github.com/") {
        return url.to_string();
    }
    format!("https://{}@{}", login, host_and_path)
}

/// このフォルダの origin（GitHub）を、アカウントの名前を入れた URL にする。
/// もう入っていれば何もしない
pub fn use_account(repo: &Path, login: &str) -> Result<GitRun, String> {
    let login = login.trim();
    if !valid_login(login) {
        return Err(format!("アカウントの名前が正しくありません: {}", login));
    }
    let current = run(repo, &["remote", "get-url", "origin"])?.output.trim().to_string();
    let next = with_account(&current, login);
    if next == current {
        let summary = if current.starts_with("https://") && current.contains(&format!("{}@", login)) {
            format!("もう {} で使っています", login)
        } else {
            "origin が GitHub の https の URL ではないので、変えていません".to_string()
        };
        return Ok(GitRun { command: String::new(), output: summary });
    }
    let r = run(repo, &["remote", "set-url", "origin", &next])?;
    Ok(GitRun { command: r.command, output: format!("これから GitHub には {} で行きます", login) })
}

#[cfg(test)]
mod tests {
    use super::with_account;

    #[test]
    fn puts_the_account_into_github_https_urls() {
        assert_eq!(with_account("https://github.com/y0zrin3/LMTest.git", "y0zrin3"), "https://y0zrin3@github.com/y0zrin3/LMTest.git");
        // 前の名前は入れ替える（パスワードの付いたものも、名前だけにする）
        assert_eq!(with_account("https://y0zrin@github.com/a/b.git", "y0zrin3"), "https://y0zrin3@github.com/a/b.git");
        assert_eq!(with_account("https://x:secret@github.com/a/b.git", "y0zrin3"), "https://y0zrin3@github.com/a/b.git");
        assert_eq!(with_account("https://GitHub.com/a/b", "y0zrin3"), "https://y0zrin3@GitHub.com/a/b");
    }

    #[test]
    fn leaves_other_urls_and_bad_names_alone() {
        assert_eq!(with_account("git@github.com:a/b.git", "y0zrin3"), "git@github.com:a/b.git");
        assert_eq!(with_account("https://gitlab.com/a/b.git", "y0zrin3"), "https://gitlab.com/a/b.git");
        assert_eq!(with_account("https://github.com/a/b.git", ""), "https://github.com/a/b.git");
        assert_eq!(with_account("https://github.com/a/b.git", "bad name"), "https://github.com/a/b.git");
        assert_eq!(with_account("https://github.com/a/b.git", "-x"), "https://github.com/a/b.git");
        // パスの中の @ は名前ではない
        assert_eq!(with_account("https://github.com/a/b@c.git", "y0zrin3"), "https://y0zrin3@github.com/a/b@c.git");
    }
}
