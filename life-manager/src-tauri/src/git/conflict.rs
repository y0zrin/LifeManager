//! 競合（コンフリクト）したファイルを、アプリの中で直す（マージツール）。
//! ファイルの中身を読む（印 <<<<<<< ======= >>>>>>> の読み分けは画面の側）、直した中身を書いてステージする、
//! ファイルを片方の内容にする、いつものアプリ（エディタ）で開く
use super::runner::{run, GitRun};
use serde::Serialize;
use std::path::{Component, Path, PathBuf};

/// 競合したファイルの中身
#[derive(Debug, Serialize)]
pub struct ConflictText {
    pub text: String,
    /// 文字でないファイル（画像など）。印で直せないので、片方を選ぶ
    pub binary: bool,
    /// 作業フォルダにファイルがない（片方で消されていた）
    pub missing: bool,
}

/// リポジトリの中のファイルの場所（.. で外に出るもの・絶対パスは受け付けない）
fn inside(repo: &Path, file: &str) -> Result<PathBuf, String> {
    let rel = Path::new(file);
    let outside = rel.is_absolute()
        || rel.components().any(|c| matches!(c, Component::ParentDir | Component::Prefix(_) | Component::RootDir));
    if file.trim().is_empty() || outside {
        return Err(format!("「{}」は、このリポジトリのファイルではありません", file));
    }
    Ok(repo.join(rel))
}

/// 新しいファイルを置く（Actions のワークフローのひな形など）。もうあれば書き換えない。足りないフォルダは作る
pub fn write_new(repo: &Path, file: &str, text: &str) -> Result<(), String> {
    let path = inside(repo, file)?;
    if path.exists() {
        return Err(format!("{} はもうあります（書き換えません）。別の名前にするか、そのファイルを直してください", file));
    }
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("フォルダを作れませんでした: {}", e))?;
    }
    std::fs::write(&path, text).map_err(|e| format!("{} に書き込めませんでした: {}", file, e))
}

pub fn read(repo: &Path, file: &str) -> Result<ConflictText, String> {
    let path = inside(repo, file)?;
    match std::fs::read(&path) {
        Ok(bytes) => match String::from_utf8(bytes) {
            Ok(text) if !text.contains('\0') => Ok(ConflictText { text, binary: false, missing: false }),
            _ => Ok(ConflictText { text: String::new(), binary: true, missing: false }),
        },
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(ConflictText { text: String::new(), binary: false, missing: true }),
        Err(e) => Err(format!("{} を読めませんでした: {}", file, e)),
    }
}

/// 直した中身を書いて、ステージする（git add。「直した」という合図）
pub fn resolve(repo: &Path, file: &str, text: &str) -> Result<GitRun, String> {
    let path = inside(repo, file)?;
    std::fs::write(&path, text).map_err(|e| format!("{} に書き込めませんでした: {}", file, e))?;
    run(repo, &["add", "--", file])
}

/// ファイルを片方の内容にして、ステージする。ours = 今のブランチ（HEAD）、theirs = 取り込む側、delete = 消したままにする
pub fn take_side(repo: &Path, file: &str, side: &str) -> Result<GitRun, String> {
    inside(repo, file)?;
    if side == "delete" {
        return run(repo, &["rm", "--", file]);
    }
    let flag = match side {
        "ours" => "--ours",
        "theirs" => "--theirs",
        _ => return Err(format!("「{}」は選べません", side)),
    };
    let first = run(repo, &["checkout", flag, "--", file])?;
    let second = run(repo, &["add", "--", file])?;
    Ok(GitRun {
        command: format!("{} && {}", first.command, second.command),
        output: [first.output.trim_end(), second.output.trim_end()].iter().filter(|o| !o.is_empty()).cloned().collect::<Vec<_>>().join("\n"),
    })
}

/// ファイルを、この PC でいつも使うアプリ（エディタなど）で開く
pub fn open(repo: &Path, file: &str) -> Result<(), String> {
    let path = inside(repo, file)?;
    if !path.exists() {
        return Err(format!("{} は、作業フォルダにありません", file));
    }
    open_with_default_app(&path).map_err(|e| format!("{} を開けませんでした: {}", file, e))
}

#[cfg(windows)]
fn open_with_default_app(path: &Path) -> std::io::Result<()> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    // start の最初の引数は窓の題（空にしておかないと、空白を含むパスが題として扱われる）
    std::process::Command::new("cmd")
        .args(["/C", "start", ""])
        .arg(path)
        .creation_flags(CREATE_NO_WINDOW)
        .spawn()
        .map(|_| ())
}

#[cfg(target_os = "macos")]
fn open_with_default_app(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("open").arg(path).spawn().map(|_| ())
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_with_default_app(path: &Path) -> std::io::Result<()> {
    std::process::Command::new("xdg-open").arg(path).spawn().map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn refuses_paths_outside_the_repository() {
        let repo = Path::new("C:/work/repo");
        assert!(inside(repo, "menu.txt").is_ok());
        assert!(inside(repo, "src/app.ts").is_ok());
        assert!(inside(repo, "../secret.txt").is_err());
        assert!(inside(repo, "src/../../x").is_err());
        assert!(inside(repo, "").is_err());
        #[cfg(windows)]
        assert!(inside(repo, "C:/Windows/win.ini").is_err());
        #[cfg(not(windows))]
        assert!(inside(repo, "/etc/passwd").is_err());
    }

    #[test]
    fn writes_a_new_file_only_once_and_only_inside() {
        let repo = std::env::temp_dir().join(format!("lm-write-new-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&repo);
        std::fs::create_dir_all(&repo).unwrap();
        write_new(&repo, ".github/workflows/test.yml", "name: テスト\n").unwrap();
        assert_eq!(std::fs::read_to_string(repo.join(".github/workflows/test.yml")).unwrap(), "name: テスト\n");
        // もうあるファイルは書き換えない
        assert!(write_new(&repo, ".github/workflows/test.yml", "別の中身").is_err());
        assert_eq!(std::fs::read_to_string(repo.join(".github/workflows/test.yml")).unwrap(), "name: テスト\n");
        assert!(write_new(&repo, "../outside.yml", "x").is_err());
        let _ = std::fs::remove_dir_all(&repo);
    }
}
