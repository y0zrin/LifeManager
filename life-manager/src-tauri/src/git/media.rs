//! メディアビューワー（この PC の git）: 作業フォルダのファイルと、コミットの中のファイルの中身（バイト列）を読む。
//! Git LFS のファイルは、この PC に取ってきてある実体（.git/lfs/objects）から読む（ネットにはつながない）。
//! Issue の成果物のため、コミットで変わったファイルと、Issue の番号に触れたコミットも読む
use super::runner::{git_program, hide_console_window};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::ipc::Response;

/// 読むファイルの大きさの上限（ビューワーで見るもの。大きすぎるとアプリが重くなる）
pub const MAX_BYTES: u64 = 200 * 1024 * 1024;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// git を動かして、出力をバイト列のまま受け取る（画像・音などの中身のため）
fn run_bytes(repo: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let mut cmd = Command::new(git_program());
    cmd.args(["-c", "core.quotepath=false"])
        .args(args)
        .current_dir(repo)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0");
    hide_console_window(&mut cmd);
    let out = cmd.output().map_err(|e| format!("git {}\n{}", args.join(" "), e))?;
    if out.status.success() {
        return Ok(out.stdout);
    }
    let message = String::from_utf8_lossy(&out.stderr).trim().to_string();
    Err(format!("git {}\n{}", args.join(" "), message))
}

fn run_text(repo: &Path, args: &[&str]) -> Result<String, String> {
    run_bytes(repo, args).map(|b| String::from_utf8_lossy(&b).to_string())
}

/// コミットのハッシュらしいか（7〜40 桁の 16 進）
pub fn is_sha(s: &str) -> bool {
    (7..=40).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_hexdigit())
}

/// リポジトリの中のファイルの名前か（「-」で始まる・「..」を含む・絶対パスは受け付けない）
fn check_file(file: &str) -> Result<(), String> {
    let f = file.trim();
    if f.is_empty() || f.starts_with('-') || f.starts_with('/') || f.starts_with('\\') || f.contains(':') {
        return Err(format!("ファイルの名前が正しくありません: {}", file));
    }
    if f.split(['/', '\\']).any(|part| part == "..") {
        return Err(format!("ファイルの名前が正しくありません: {}", file));
    }
    Ok(())
}

/// Git LFS の目印（本物の中身の代わりに入っている、短い文字）なら、その中身の番号（sha256。16 進の 64 文字だけ）。
/// 番号はそのままフォルダの名前に使うので、形のちがうもの（「../」など）は目印として扱わない
pub fn lfs_oid(bytes: &[u8]) -> Option<String> {
    if bytes.len() > 1024 || !bytes.starts_with(b"version https://git-lfs.github.com/spec/v1") {
        return None;
    }
    let text = String::from_utf8_lossy(bytes);
    let oid = text.lines().find_map(|l| l.strip_prefix("oid sha256:")).map(|s| s.trim().to_string())?;
    if oid.len() == 64 && oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Some(oid.to_ascii_lowercase());
    }
    return None;
}

/// この PC に取ってきてある LFS の中身（なければ、見られない理由）
fn read_lfs_object(repo: &Path, oid: &str) -> Result<Vec<u8>, String> {
    let common = run_text(repo, &["rev-parse", "--git-common-dir"])?;
    let mut dir = PathBuf::from(common.trim());
    if dir.is_relative() {
        dir = repo.join(dir);
    }
    if oid.len() != 64 || !oid.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Git LFS の目印が正しくありません".into());
    }
    let object = dir.join("lfs").join("objects").join(&oid[0..2]).join(&oid[2..4]).join(oid);
    match std::fs::metadata(&object) {
        Ok(m) if m.len() > MAX_BYTES => Err(format!("大きすぎるので開けません（{} MB）", m.len() / 1024 / 1024)),
        Ok(_) => std::fs::read(&object).map_err(|e| e.to_string()),
        Err(_) => Err("Git LFS のファイルです。この PC に中身がまだありません（作業フォルダで git lfs pull をすると見られます）".into()),
    }
}

/// 作業フォルダのファイル（今の中身）。フォルダの外は読まない
#[tauri::command]
pub async fn media_read_local(path: String, file: String) -> Result<Response, String> {
    check_file(&file)?;
    blocking(move || {
        let root = Path::new(&path).canonicalize().map_err(|e| format!("作業フォルダが見つかりません: {}", e))?;
        let target = root.join(file.trim()).canonicalize().map_err(|_| format!("ファイルが見つかりません: {}", file))?;
        if !target.starts_with(&root) {
            return Err("作業フォルダの外のファイルは開けません".into());
        }
        let meta = std::fs::metadata(&target).map_err(|e| e.to_string())?;
        if meta.len() > MAX_BYTES {
            return Err(format!("大きすぎるので開けません（{} MB）", meta.len() / 1024 / 1024));
        }
        let bytes = std::fs::read(&target).map_err(|e| e.to_string())?;
        // 作業フォルダの LFS の目印（まだ中身を取ってきていない）なら、取ってきてある中身を探す
        let bytes = match lfs_oid(&bytes) {
            Some(oid) => read_lfs_object(&root, &oid)?,
            None => bytes,
        };
        Ok(Response::new(bytes))
    })
    .await
}

/// 外のアプリ（PC で決めてあるアプリ・ブラウザ）で開いてよいファイルの種類。
/// 仲間のファイルを開くことがあるので、動かすもの（.exe・.bat・.js・.py など）は入れない
const OPEN_OUTSIDE: &[&str] = &[
    // 画像
    "png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "tga", "tif", "tiff", "psd", "kra", "xcf", "ase", "aseprite", "clip",
    // 音
    "wav", "mp3", "ogg", "flac", "m4a", "aac", "aif", "aiff", "mid", "midi",
    // 動画
    "mp4", "webm", "mov", "avi", "mkv",
    // 3D
    "glb", "gltf", "obj", "fbx", "stl", "blend", "3ds", "dae", "ply", "usd", "usdz",
    // 文書・データ
    "pdf", "txt", "md", "csv", "tsv", "json", "xml", "yaml", "yml", "log", "docx", "xlsx", "pptx", "odt", "ods", "odp",
    // ページ（ブラウザで開く）・フォント・まとめたもの
    "html", "htm", "ttf", "otf", "woff", "woff2", "zip",
];

/// 作業フォルダのファイルを、外のアプリで開く（メディアビューワーの「外部のアプリで開く」「ブラウザで開く」）。
/// フォルダの外と、開いてよい種類でないものは開かない
#[tauri::command]
pub async fn media_open_local(app: tauri::AppHandle, path: String, file: String) -> Result<(), String> {
    use tauri_plugin_opener::OpenerExt;
    check_file(&file)?;
    let root = Path::new(&path).canonicalize().map_err(|e| format!("作業フォルダが見つかりません: {}", e))?;
    let target = root.join(file.trim()).canonicalize().map_err(|_| format!("ファイルが見つかりません: {}", file))?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err("作業フォルダの外のファイルは開けません".into());
    }
    let ext = target.extension().and_then(|e| e.to_str()).unwrap_or("").to_ascii_lowercase();
    if !OPEN_OUTSIDE.contains(&ext.as_str()) {
        return Err(format!("この形式（.{}）は、アプリからは開きません（エクスプローラーで表示して、確かめてから開いてください）", ext));
    }
    // canonicalize は \\?\ で始まるので、ふつうのパスに戻してから渡す
    let shown = target.to_string_lossy().trim_start_matches(r"\\?\").to_string();
    return app.opener().open_path(shown, None::<&str>).map_err(|e| e.to_string());
}

/// コミットの中のファイル（git show コミット:ファイル）
#[tauri::command]
pub async fn media_read_commit(path: String, sha: String, file: String) -> Result<Response, String> {
    if !is_sha(&sha) {
        return Err(format!("コミットの番号が正しくありません: {}", sha));
    }
    check_file(&file)?;
    blocking(move || {
        let repo = PathBuf::from(&path);
        let spec = format!("{}:{}", sha, file.trim().replace('\\', "/"));
        let size = run_text(&repo, &["cat-file", "-s", &spec])?;
        if size.trim().parse::<u64>().unwrap_or(0) > MAX_BYTES {
            return Err("大きすぎるので開けません".into());
        }
        let bytes = run_bytes(&repo, &["cat-file", "blob", &spec])?;
        let bytes = match lfs_oid(&bytes) {
            Some(oid) => read_lfs_object(&repo, &oid)?,
            None => bytes,
        };
        Ok(Response::new(bytes))
    })
    .await
}

/// コミットで変わったファイル
#[derive(Debug, Clone, Serialize)]
pub struct ChangedFile {
    pub path: String,
    /// added / modified / removed / renamed
    pub status: String,
    pub previous: Option<String>,
    pub additions: Option<u64>,
    pub deletions: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct LocalCommit {
    pub sha: String,
    pub message: String,
    pub author: String,
    pub date: String,
    pub files: Vec<ChangedFile>,
}

/// name-status の 1 行（A・M・D・R100 など）を読む
pub fn parse_name_status(text: &str) -> Vec<ChangedFile> {
    text.lines()
        .filter_map(|line| {
            let mut cols = line.split('\t');
            let code = cols.next()?.trim();
            let first = cols.next()?.to_string();
            let second = cols.next().map(|s| s.to_string());
            let (status, path, previous) = match code.chars().next()? {
                'A' => ("added", first, None),
                'D' => ("removed", first, None),
                'R' => ("renamed", second.clone().unwrap_or_else(|| first.clone()), Some(first)),
                'C' => ("added", second.clone().unwrap_or_else(|| first.clone()), None),
                _ => ("modified", first, None),
            };
            Some(ChangedFile { path, status: status.into(), previous, additions: None, deletions: None })
        })
        .collect()
}

/// この PC にあるコミットの中身（メッセージ・作者・日時・変わったファイル）。なければ None
pub fn local_commit(repo: &Path, sha: &str) -> Option<LocalCommit> {
    if !is_sha(sha) {
        return None;
    }
    let head = run_text(repo, &["log", "-1", "--format=%H%x09%an%x09%aI%x09%s", sha]).ok()?;
    let mut cols = head.trim().splitn(4, '\t');
    let full = cols.next()?.to_string();
    let author = cols.next().unwrap_or("").to_string();
    let date = cols.next().unwrap_or("").to_string();
    let message = cols.next().unwrap_or("").to_string();
    // 最初の親との違い（マージのコミットでも、入ってきたファイルが分かるように）。最初のコミットは空の木と比べる
    let names = run_text(repo, &["diff-tree", "--no-commit-id", "-r", "-M", "--name-status", "--root", "-m", "--first-parent", &full]).ok()?;
    let mut files = parse_name_status(&names);
    if let Ok(numstat) = run_text(repo, &["diff-tree", "--no-commit-id", "-r", "-M", "--numstat", "--root", "-m", "--first-parent", &full]) {
        for line in numstat.lines() {
            let mut cols = line.split('\t');
            let (Some(a), Some(d), Some(p)) = (cols.next(), cols.next(), cols.next()) else { continue };
            let path = cols.next().unwrap_or(p).to_string();
            if let Some(f) = files.iter_mut().find(|f| f.path == path || f.previous.as_deref() == Some(p)) {
                f.additions = a.parse().ok();
                f.deletions = d.parse().ok();
            }
        }
    }
    Some(LocalCommit { sha: full, message, author, date, files })
}

/// メッセージで Issue の番号（#11）に触れているコミット（どのブランチでも。新しい順に 40 件まで）
pub fn commits_mentioning(repo: &Path, number: u32) -> Vec<String> {
    let pattern = format!("#{}([^0-9]|$)", number);
    run_text(repo, &["log", "--all", "-E", "--format=%H", "-n", "40", &format!("--grep={}", pattern)])
        .map(|t| t.lines().map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_name_status_lines() {
        let files = parse_name_status("A\tAssets/a.png\nM\tsrc/Player.cpp\nD\told.txt\nR087\tsrc/a.cpp\tsrc/b.cpp\n");
        assert_eq!(files.len(), 4);
        assert_eq!(files[0].status, "added");
        assert_eq!(files[1].status, "modified");
        assert_eq!(files[2].status, "removed");
        assert_eq!(files[3].status, "renamed");
        assert_eq!(files[3].path, "src/b.cpp");
        assert_eq!(files[3].previous.as_deref(), Some("src/a.cpp"));
    }

    #[test]
    fn finds_lfs_pointers() {
        let pointer = b"version https://git-lfs.github.com/spec/v1\noid sha256:4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393\nsize 12345\n";
        assert_eq!(lfs_oid(pointer).as_deref(), Some("4d7a214614ab2935c943f9e0ff69d22eadbb8f32b1258daaa5e2ca24d17e2393"));
        assert_eq!(lfs_oid(b"\x89PNG\r\n"), None);
        // 番号はフォルダの名前に使うので、16 進の 64 文字でないもの（フォルダをさかのぼるなど）は目印にしない
        assert_eq!(lfs_oid(b"version https://git-lfs.github.com/spec/v1\noid sha256:../../Windows/win.ini\nsize 1\n"), None);
        assert_eq!(lfs_oid("version https://git-lfs.github.com/spec/v1\noid sha256:ああああ\nsize 1\n".as_bytes()), None);
    }

    #[test]
    fn refuses_paths_outside_the_repo() {
        assert!(check_file("../secret.txt").is_err());
        assert!(check_file("a/../../b").is_err());
        assert!(check_file("-rf").is_err());
        assert!(check_file("C:/Windows/win.ini").is_err());
        assert!(check_file("Assets/Sprites/player.png").is_ok());
    }

    #[test]
    fn reads_files_and_commits_from_a_real_repo() {
        let dir = std::env::temp_dir().join(format!("lm-media-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let git = |args: &[&str]| run_text(&dir, args).unwrap();
        git(&["init", "-q", "-b", "main"]);
        git(&["config", "user.name", "Test"]);
        git(&["config", "user.email", "test@example.com"]);
        std::fs::write(dir.join("a.bin"), [0u8, 1, 2, 255]).unwrap();
        git(&["add", "a.bin"]);
        git(&["commit", "-q", "-m", "絵を足す #11"]);
        let sha = git(&["rev-parse", "HEAD"]).trim().to_string();
        let bytes = run_bytes(&dir, &["cat-file", "blob", &format!("{}:a.bin", sha)]).unwrap();
        assert_eq!(bytes, vec![0u8, 1, 2, 255]);
        let commit = local_commit(&dir, &sha).unwrap();
        assert_eq!(commit.files.len(), 1);
        assert_eq!(commit.files[0].path, "a.bin");
        assert_eq!(commit.files[0].status, "added");
        assert_eq!(commits_mentioning(&dir, 11), vec![sha.clone()]);
        assert!(commits_mentioning(&dir, 1).is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
