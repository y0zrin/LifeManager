//! 「プロジェクトを追加」から使う：URL を貼ってクローンする・手元のフォルダを GitHub に上げる。
//! どれも実行した git のコマンドを返し、画面でそのまま見せる（学生が同じことを自分で打てるように）
use super::runner::{run, GitRun};
use serde::Serialize;
use std::path::{Path, PathBuf};

/// GitHub が受け付けないファイルの大きさ（これより大きいと push が断られる）
pub const GITHUB_FILE_LIMIT: u64 = 100 * 1024 * 1024;

/// GitHub の URL（https・ssh）や「持ち主/名前」から、(持ち主, 名前) を取り出す。大文字・小文字はそのまま
pub fn parse_github(input: &str) -> Option<(String, String)> {
    let s = input.trim();
    let rest = match s.to_lowercase().find("github.com") {
        Some(i) => &s[i + "github.com".len()..],
        // 「持ち主/名前」だけの書き方
        None if !s.contains(':') && !s.contains('\\') && s.matches('/').count() == 1 => s,
        None => return None,
    };
    let rest = rest.trim_start_matches(|c| c == ':' || c == '/');
    let mut parts = rest.split(|c| c == '/' || c == '?' || c == '#');
    let owner = parts.next().filter(|p| valid_name(p))?;
    let repo = parts.next()?;
    let repo = repo.strip_suffix(".git").unwrap_or(repo);
    if !valid_name(repo) {
        return None;
    }
    Some((owner.to_string(), repo.to_string()))
}

fn valid_name(s: &str) -> bool {
    !s.is_empty() && !s.starts_with('-') && s.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_' || c == '.')
}

#[derive(Debug, Serialize)]
pub struct CloneUrlResult {
    pub run: GitRun,
    pub path: String,
    /// GitHub のリポジトリなら、その持ち主と名前（プロジェクトの登録に使う）
    pub owner: Option<String>,
    pub repo: Option<String>,
}

/// URL からクローンする。parent の下に、リポジトリと同じ名前のフォルダを作る。
/// GitHub のリポジトリは、どの書き方で貼られても https の形でクローンする（ログインを資格情報マネージャーに任せるため）
pub fn clone_url(parent: &Path, url: &str, login: Option<&str>) -> Result<CloneUrlResult, String> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err("クローンするリポジトリの URL を入れてください".into());
    }
    let github = parse_github(url);
    let (source, name) = match &github {
        Some((owner, repo)) => {
            // アプリのアカウントで取りに行く（#245）
            let base = format!("https://github.com/{}/{}.git", owner, repo);
            (login.map(|l| super::account::with_account(&base, l)).unwrap_or(base), repo.clone())
        }
        None => {
            let last = url.trim_end_matches(|c| c == '/' || c == '\\').rsplit(|c| c == '/' || c == '\\' || c == ':').next().unwrap_or("");
            let name = last.strip_suffix(".git").unwrap_or(last).to_string();
            if name.is_empty() {
                return Err(format!("「{}」からはフォルダの名前を決められません", url));
            }
            (url.to_string(), name)
        }
    };
    let dest = parent.join(&name);
    if dest.exists() {
        return Err(format!("{} はすでにあります。別の置き場所を選んでください", dest.display()));
    }
    let dest_str = dest.to_string_lossy().to_string();
    let run = run(parent, &["clone", &source, &dest_str])?;
    let (owner, repo) = github.map(|(o, r)| (Some(o), Some(r))).unwrap_or((None, None));
    Ok(CloneUrlResult { run, path: dest_str, owner, repo })
}

// --- 手元のフォルダを GitHub に上げる ---

#[derive(Debug, Serialize)]
pub struct FolderState {
    /// このフォルダ自身がリポジトリ（いちばん上のフォルダ）
    pub is_repo: bool,
    /// ほかのリポジトリの中にある（そのリポジトリのいちばん上のフォルダ）
    pub inside: Option<String>,
    /// コミットの数（まだリポジトリでなければ 0）
    pub commits: u32,
    /// ファイルの数（.git の中は数えない。多すぎるときは途中まで）
    pub files: u32,
    pub has_gitignore: bool,
    pub branch: String,
    pub origin: Option<String>,
}

const MAX_COUNTED_FILES: u32 = 100_000;

fn count_files(dir: &Path, count: &mut u32) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        if *count >= MAX_COUNTED_FILES {
            return;
        }
        let path = entry.path();
        if entry.file_name() == ".git" {
            continue;
        }
        match entry.file_type() {
            Ok(t) if t.is_dir() => count_files(&path, count),
            Ok(_) => *count += 1,
            Err(_) => {}
        }
    }
}

fn same_folder(a: &Path, b: &Path) -> bool {
    match (a.canonicalize(), b.canonicalize()) {
        (Ok(a), Ok(b)) => a == b,
        _ => false,
    }
}

/// 上げる前のフォルダの様子（画面の 1 つ目の手順で見せる）
pub fn folder_state(path: &Path) -> Result<FolderState, String> {
    if !path.is_dir() {
        return Err(format!("{} というフォルダがありません", path.display()));
    }
    let top = run(path, &["rev-parse", "--show-toplevel"]).ok().map(|r| PathBuf::from(r.output.trim()));
    let is_repo = top.as_deref().map_or(false, |t| same_folder(t, path));
    let inside = top.filter(|_| !is_repo).map(|t| t.to_string_lossy().replace('/', if cfg!(windows) { "\\" } else { "/" }));
    let mut files = 0;
    count_files(path, &mut files);
    let (commits, branch, origin) = if is_repo {
        let commits = run(path, &["rev-list", "--count", "HEAD"]).ok().and_then(|r| r.output.trim().parse().ok()).unwrap_or(0);
        let branch = run(path, &["branch", "--show-current"]).map(|r| r.output.trim().to_string()).unwrap_or_default();
        let origin = run(path, &["remote", "get-url", "origin"]).ok().map(|r| r.output.trim().to_string());
        (commits, branch, origin)
    } else {
        (0, String::new(), None)
    };
    Ok(FolderState { is_repo, inside, commits, files, has_gitignore: path.join(".gitignore").exists(), branch, origin })
}

/// .gitignore のひな形（GitHub の gitignore から、よく使う分）
pub fn gitignore_template(name: &str) -> Option<&'static str> {
    match name {
        "visualstudio" => Some(VISUAL_STUDIO),
        "unity" => Some(UNITY),
        "unreal" => Some(UNREAL),
        _ => None,
    }
}

const VISUAL_STUDIO: &str = "# Visual Studio が作るもの（GitHub の VisualStudio.gitignore から、よく使う分）
.vs/
[Dd]ebug/
[Dd]ebugPublic/
[Rr]elease/
[Rr]eleases/
x64/
x86/
[Ww][Ii][Nn]32/
[Aa][Rr][Mm]64/
bld/
[Bb]in/
[Oo]bj/
[Ll]og/
[Ll]ogs/
ipch/
*.user
*.suo
*.sln.docstates
*.VC.db
*.VC.opendb
*.opensdf
*.sdf
*.ipch
*.aps
*.pch
*.pdb
*.ilk
*.obj
*.iobj
*.ipdb
*.idb
*.tlog
*.lastbuildstate
*.log
";

const UNITY: &str = "# Unity が作るもの（GitHub の Unity.gitignore から、よく使う分）
/[Ll]ibrary/
/[Tt]emp/
/[Oo]bj/
/[Bb]uild/
/[Bb]uilds/
/[Ll]ogs/
/[Uu]ser[Ss]ettings/
/[Mm]emoryCaptures/
/[Rr]ecordings/
.vs/
.vscode/
.idea/
*.csproj
*.unityproj
*.sln
*.suo
*.tmp
*.user
*.userprefs
*.pidb
*.booproj
*.svd
*.pdb
*.mdb
*.opendb
*.VC.db
*.apk
*.aab
*.unitypackage
sysinfo.txt
crashlytics-build.properties
";

const UNREAL: &str = "# Unreal Engine が作るもの（GitHub の UnrealEngine.gitignore から、よく使う分）
Binaries/
DerivedDataCache/
Intermediate/
Saved/
Build/
Plugins/**/Binaries/
Plugins/**/Intermediate/
.vs/
.vscode/
*.sln
*.suo
*.opensdf
*.sdf
*.VC.db
*.VC.opendb
*.pdb
*.obj
*.exe
*.dll
*.lib
";

/// 続けて実行したコマンドを 1 つの結果にまとめる（画面には && でつないで見せる）
fn combine(runs: Vec<GitRun>) -> GitRun {
    GitRun {
        command: runs.iter().map(|r| r.command.as_str()).filter(|c| !c.is_empty()).collect::<Vec<_>>().join(" && "),
        output: runs.iter().map(|r| r.output.trim_end()).filter(|o| !o.is_empty()).collect::<Vec<_>>().join("\n"),
    }
}

/// 1 つ目の手順：記録を始める。まだリポジトリでなければ git init し、まだコミットがなければ、
/// .gitignore のひな形を置いて、今の中身を最初のコミットにする（GitHub が受け付けない大きなファイルがあれば、コミットせずに知らせる）
pub fn prepare(path: &Path, template: &str, message: &str) -> Result<GitRun, String> {
    prepare_with_limit(path, template, message, GITHUB_FILE_LIMIT)
}

fn prepare_with_limit(path: &Path, template: &str, message: &str, limit: u64) -> Result<GitRun, String> {
    let state = folder_state(path)?;
    if let Some(top) = &state.inside {
        return Err(format!(
            "このフォルダは、ほかのリポジトリ（{}）の中にあります。リポジトリの中に別のリポジトリは作れません",
            top
        ));
    }
    let message = message.trim();
    let message = if message.is_empty() { "最初のコミット" } else { message };
    let mut runs = Vec::new();
    if !state.is_repo {
        match run(path, &["init", "-b", "main"]) {
            Ok(r) => runs.push(r),
            // 古い git（2.28 より前）は -b を知らないので、作ってから名前を main にする
            Err(_) => {
                runs.push(run(path, &["init"])?);
                run(path, &["symbolic-ref", "HEAD", "refs/heads/main"])?;
            }
        }
    }
    if state.commits == 0 {
        // .gitignore は最初のコミットに入れる（もう記録があるリポジトリには足さない。足しても、記録済みのファイルは外れないため）
        if !state.has_gitignore {
            if let Some(text) = gitignore_template(template) {
                std::fs::write(path.join(".gitignore"), text).map_err(|e| format!(".gitignore を作れませんでした: {}", e))?;
                runs.push(GitRun { command: String::new(), output: ".gitignore を作りました".into() });
            }
        }
        // これから記録に入るファイルのうち、GitHub が受け付けない大きさのもの
        let listed = run(path, &["ls-files", "--others", "--exclude-standard", "-z"])?.output;
        let mut large: Vec<String> = Vec::new();
        for file in listed.split('\0').filter(|f| !f.is_empty()) {
            if let Ok(meta) = std::fs::metadata(path.join(file)) {
                if meta.len() > limit {
                    large.push(format!("{}（{} MB）", file, meta.len() / 1024 / 1024));
                }
            }
        }
        if !large.is_empty() {
            return Err(format!(
                "GitHub は 100MB を超えるファイルを受け付けないので、まだコミットしていません。\n{}\n→ 記録しないなら .gitignore に書き、記録するなら Git LFS を使ってください",
                large.join("\n")
            ));
        }
        runs.push(run(path, &["add", "."])?);
        let empty = listed.is_empty() && !path.join(".gitignore").exists();
        let mut args = vec!["commit", "-m", message];
        if empty {
            args.push("--allow-empty");
        }
        runs.push(run(path, &args)?);
    }
    Ok(combine(runs))
}

/// GitHub（やほかの置き場所）に、そのリポジトリがあるか。ないときは false、ログインなどで確かめられないときはエラー
pub fn remote_exists(url: &str) -> Result<bool, String> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Ok(false);
    }
    match run(&std::env::temp_dir(), &["ls-remote", "--heads", url]) {
        Ok(_) => Ok(true),
        Err(e) if e.contains("not found") || e.contains("does not appear to be a git repository") || e.contains("does not exist") => {
            Ok(false)
        }
        Err(e) => Err(e),
    }
}

/// つないで送る：origin を url にして（なければ足す）、今のブランチを送り、上流にする。
/// login（アプリのアカウント）があれば、URL に入れる（#245）
pub fn push_to(path: &Path, url: &str, login: Option<&str>) -> Result<GitRun, String> {
    let url = url.trim();
    if url.is_empty() || url.starts_with('-') {
        return Err("送り先の URL を入れてください".into());
    }
    let with_login = login.map(|l| super::account::with_account(url, l));
    let url = with_login.as_deref().unwrap_or(url);
    let mut runs = Vec::new();
    match run(path, &["remote", "get-url", "origin"]) {
        Ok(r) if r.output.trim() == url => {}
        Ok(_) => runs.push(run(path, &["remote", "set-url", "origin", url])?),
        Err(_) => runs.push(run(path, &["remote", "add", "origin", url])?),
    }
    let branch = run(path, &["branch", "--show-current"])?.output.trim().to_string();
    if branch.is_empty() {
        return Err("ブランチから切り離された状態なので、送れません。先にブランチに切り替えてください".into());
    }
    runs.push(run(path, &["push", "-u", "origin", &branch])?);
    Ok(combine(runs))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_urls_keeping_case() {
        let expected = Some(("hal2026-team4".to_string(), "ActionGame".to_string()));
        assert_eq!(parse_github("https://github.com/hal2026-team4/ActionGame"), expected);
        assert_eq!(parse_github("https://github.com/hal2026-team4/ActionGame.git"), expected);
        assert_eq!(parse_github("https://github.com/hal2026-team4/ActionGame/tree/main/src"), expected);
        assert_eq!(parse_github("git@github.com:hal2026-team4/ActionGame.git"), expected);
        assert_eq!(parse_github("  hal2026-team4/ActionGame  "), expected);
        assert_eq!(parse_github("https://GitHub.com/hal2026-team4/ActionGame?tab=readme"), expected);
        assert_eq!(parse_github("https://gitlab.com/hal2026-team4/ActionGame"), None);
        assert_eq!(parse_github("C:\\Works\\ActionGame"), None);
        assert_eq!(parse_github("https://github.com/hal2026-team4"), None);
        assert_eq!(parse_github("-x/y"), None);
    }

    #[test]
    fn templates_exist_for_each_choice() {
        assert!(gitignore_template("visualstudio").unwrap().contains("x64/"));
        assert!(gitignore_template("unity").unwrap().contains("/[Ll]ibrary/"));
        assert!(gitignore_template("unreal").unwrap().contains("DerivedDataCache/"));
        assert_eq!(gitignore_template("none"), None);
    }

    #[test]
    fn prepare_refuses_files_too_large_for_github() {
        super::super::scenario_tests::isolate_git_config();
        let dir = std::env::temp_dir().join(format!("lm-publish-large-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(dir.join("movie.mp4"), vec![0u8; 64]).unwrap();
        std::fs::write(dir.join("main.cpp"), "int main() {}\n").unwrap();
        let err = prepare_with_limit(&dir, "none", "最初のコミット", 32).unwrap_err();
        assert!(err.contains("movie.mp4") && err.contains("Git LFS"), "{}", err);
        // コミットはされていない
        assert!(run(&dir, &["rev-parse", "--verify", "HEAD"]).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
