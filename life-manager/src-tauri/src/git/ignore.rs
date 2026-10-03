//! .gitignore（git で記録しない＝無視するファイルの一覧）の読み書き。
//! 作業タブのファイルの右クリック「無視する」と、「.gitignore を編集」から使う
use super::runner::{run, GitRun};
use serde::Serialize;
use std::io::Write;
use std::path::{Path, PathBuf};

/// リポジトリのいちばん上のフォルダ（.gitignore はここに置く。git status のパスもここから数える）
pub(super) fn top_level(repo: &Path) -> Result<PathBuf, String> {
    let out = run(repo, &["rev-parse", "--show-toplevel"])?.output;
    let top = out.trim();
    if top.is_empty() {
        return Err("リポジトリのいちばん上のフォルダが分かりませんでした".into());
    }
    Ok(PathBuf::from(top))
}

/// .gitignore の中身。まだ無ければ空
fn read_text(file: &Path) -> Result<String, String> {
    match std::fs::read(file) {
        Ok(bytes) => Ok(String::from_utf8_lossy(&bytes).into_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(e) => Err(format!(".gitignore を読めませんでした: {}", e)),
    }
}

/// 書き足す・保存するときは、今のファイルの改行の書き方（\r\n か \n か）に合わせる
fn newline_of(text: &str) -> &'static str {
    if text.contains("\r\n") {
        "\r\n"
    } else {
        "\n"
    }
}

/// 1 行のパターンか（改行を含むと、.gitignore に思わぬ行が入ってしまう）
fn check_pattern(pattern: &str) -> Result<(), String> {
    if pattern.trim().is_empty() || pattern.contains(['\n', '\r']) {
        return Err(format!("「{}」は .gitignore に書けないパターンです", pattern));
    }
    Ok(())
}

#[derive(Debug, Serialize)]
pub struct GitignoreText {
    /// 改行は \n にそろえてある
    pub text: String,
    pub exists: bool,
}

pub fn read_gitignore(repo: &Path) -> Result<GitignoreText, String> {
    let file = top_level(repo)?.join(".gitignore");
    let exists = file.exists();
    Ok(GitignoreText { text: read_text(&file)?.replace("\r\n", "\n"), exists })
}

/// 画面で編集した中身で .gitignore を書き換える（無ければ作る）
pub fn write_gitignore(repo: &Path, text: &str) -> Result<GitRun, String> {
    let file = top_level(repo)?.join(".gitignore");
    let nl = newline_of(&read_text(&file)?);
    let mut body = text.replace("\r\n", "\n");
    if !body.is_empty() && !body.ends_with('\n') {
        body.push('\n');
    }
    std::fs::write(&file, body.replace('\n', nl)).map_err(|e| format!(".gitignore を保存できませんでした: {}", e))?;
    Ok(GitRun { command: String::new(), output: ".gitignore を保存しました".into() })
}

/// パターンに当てはまる、git で管理している（索引にある）ファイル。
/// .gitignore に書いても、管理しているファイルは無視されない（管理から外す必要がある）
pub fn tracked_matching(repo: &Path, pattern: &str) -> Result<Vec<String>, String> {
    check_pattern(pattern)?;
    let top = top_level(repo)?;
    let exclude = format!("--exclude={}", pattern);
    let out = run(&top, &["ls-files", "-z", "--cached", "--ignored", &exclude])?.output;
    Ok(out.split('\0').filter(|p| !p.is_empty()).map(String::from).collect())
}

/// .gitignore にパターンを 1 行書き足す（もうあれば足さない）。
/// untrack があれば、先にそのパス（git rm のパスの指定）に当てはまる管理中のファイルを管理から外す。
/// ファイルそのものは PC に残り、次のコミットで記録から外れる
pub fn add_ignore(repo: &Path, pattern: &str, untrack: Option<&str>, recursive: bool) -> Result<GitRun, String> {
    check_pattern(pattern)?;
    let top = top_level(repo)?;

    // 外すのに失敗したら、.gitignore も書き換えない（git のほうが失敗しやすいので先に行う）
    let mut command = String::new();
    if let Some(spec) = untrack {
        let mut args = vec!["rm"];
        if recursive {
            args.push("-r");
        }
        args.extend(["--cached", "--", spec]);
        command = run(&top, &args)?.command;
    }

    let file = top.join(".gitignore");
    let old = read_text(&file)?;
    let mut summary = if old.lines().any(|line| line == pattern) {
        format!(".gitignore にはもう {} があります", pattern)
    } else {
        let nl = newline_of(&old);
        let mut add = String::new();
        if !old.is_empty() && !old.ends_with('\n') {
            add.push_str(nl);
        }
        add.push_str(pattern);
        add.push_str(nl);
        std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&file)
            .and_then(|mut f| f.write_all(add.as_bytes()))
            .map_err(|e| format!(".gitignore に書き足せませんでした: {}", e))?;
        format!(".gitignore に {} を書き足しました", pattern)
    };
    if untrack.is_some() {
        summary.push_str("。管理から外したので、次のコミットで記録から外れます");
    }
    Ok(GitRun { command, output: summary })
}
