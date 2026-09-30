//! git の状態の読み取り（変更ファイル・ブランチ・退避中の変更・差分）と、フォルダの確認・クローン
use super::runner::{display_command, run, GitRun};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// 追加・削除した行数
#[derive(Debug, Clone, Copy, Serialize, PartialEq)]
pub struct LineStat {
    pub added: u32,
    pub deleted: u32,
}

/// 変更のあるファイル。staged / unstaged は git status の 1 文字（A/M/D/R/C/U/?）、変化がなければ空
#[derive(Debug, Serialize, PartialEq)]
pub struct FileChange {
    pub path: String,
    /// 名前を変えたときの元のパス
    pub orig_path: Option<String>,
    pub staged: String,
    pub unstaged: String,
    /// 行数（バイナリファイルなど数えられないときは None）
    pub staged_lines: Option<LineStat>,
    pub unstaged_lines: Option<LineStat>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct RepoStatus {
    /// 今のブランチ。ブランチから切り離されているときは空
    pub branch: String,
    /// 先頭のコミット（短縮）。まだコミットがなければ空
    pub head: String,
    /// 先頭のコミットの要約
    pub last_subject: String,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// まだどのリモートにもないコミットの数（上流のないブランチでも、公開が必要かが分かる）
    pub unpushed: u32,
    /// GitHub の既定のブランチ（origin/HEAD が分かるときだけ）
    pub default_branch: Option<String>,
    pub files: Vec<FileChange>,
    /// 競合（コンフリクト）しているファイルがある
    pub conflicted: bool,
    /// 途中で止まっている操作（"merge" / "rebase" / "cherry-pick" / "revert"）。競合を直して続けるか、中止するのを待っている
    pub operation: Option<String>,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct BranchInfo {
    pub name: String,
    pub current: bool,
    pub upstream: Option<String>,
    pub ahead: u32,
    pub behind: u32,
    /// 上流のブランチが GitHub 側で消されている
    pub gone: bool,
    pub head: String,
    /// 最後のコミットの日時（ISO 8601）
    pub date: String,
    pub subject: String,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct StashEntry {
    pub index: u32,
    pub message: String,
    /// 退避した日時（ISO 8601）
    pub date: String,
    /// 退避したファイルの数（0 なら中身は空）。調べられなかったときは None
    pub files: Option<u32>,
}

#[derive(Debug, Serialize)]
pub struct FolderCheck {
    pub is_repo: bool,
    /// リポジトリのいちばん上のフォルダ（選んだのが中のフォルダでも、ここを保存する）
    pub top_level: String,
    pub remote_url: Option<String>,
    /// origin が、このプロジェクトの GitHub リポジトリ（owner/repo）を指している
    pub matches_project: bool,
}

pub fn read_status(repo: &Path) -> Result<RepoStatus, String> {
    // 新しいフォルダの中身も 1 ファイルずつ出す（ファイルごとに中身を見たり、ステージしたりできるように）
    let out = run(repo, &["status", "--porcelain=v2", "--branch", "--untracked-files=all", "-z"])?.output;
    let mut st = parse_status(&out);

    // 行数（+/−）。ステージ済みと未ステージは別に数える
    let staged = run(repo, &["diff", "--cached", "--numstat", "-z"]).map(|r| parse_numstat(&r.output)).unwrap_or_default();
    let unstaged = run(repo, &["diff", "--numstat", "-z"]).map(|r| parse_numstat(&r.output)).unwrap_or_default();
    let mut new_files_counted = 0;
    for f in &mut st.files {
        if !f.staged.is_empty() {
            f.staged_lines = staged.get(&f.path).copied().flatten();
        }
        if f.unstaged == "?" {
            // 新しいファイルは git が数えないので、中身の行数を数える（大量にあるときは数えない）
            if new_files_counted < MAX_COUNTED_NEW_FILES {
                f.unstaged_lines = count_new_file_lines(repo, &f.path);
                new_files_counted += 1;
            }
        } else if !f.unstaged.is_empty() {
            f.unstaged_lines = unstaged.get(&f.path).copied().flatten();
        }
    }

    if !st.head.is_empty() {
        st.last_subject = run(repo, &["log", "-1", "--format=%s"]).map(|r| r.output.trim().to_string()).unwrap_or_default();
        st.unpushed = run(repo, &["rev-list", "--count", "HEAD", "--not", "--remotes"])
            .ok()
            .and_then(|r| r.output.trim().parse().ok())
            .unwrap_or(0);
    }
    st.default_branch = run(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .map(|r| r.output.trim().trim_start_matches("origin/").to_string())
        .filter(|b| !b.is_empty());
    st.operation = operation_in_progress(repo);
    Ok(st)
}

/// 途中で止まっている操作を、.git の中の印（MERGE_HEAD など）から調べる
fn operation_in_progress(repo: &Path) -> Option<String> {
    let dir = run(repo, &["rev-parse", "--absolute-git-dir"]).ok()?.output.trim().to_string();
    let git_dir = Path::new(&dir);
    let op = if git_dir.join("rebase-merge").exists() || git_dir.join("rebase-apply").exists() {
        "rebase"
    } else if git_dir.join("MERGE_HEAD").exists() {
        "merge"
    } else if git_dir.join("CHERRY_PICK_HEAD").exists() {
        "cherry-pick"
    } else if git_dir.join("REVERT_HEAD").exists() {
        "revert"
    } else {
        return None;
    };
    Some(op.to_string())
}

const MAX_COUNTED_NEW_FILES: usize = 200;

/// `git diff --numstat -z` の結果を、パスごとの行数にする（バイナリファイルは None）
fn parse_numstat(out: &str) -> HashMap<String, Option<LineStat>> {
    let mut map = HashMap::new();
    let mut parts = out.split('\0');
    while let Some(entry) = parts.next() {
        if entry.is_empty() {
            continue;
        }
        let f: Vec<&str> = entry.splitn(3, '\t').collect();
        if f.len() != 3 {
            continue;
        }
        let path = if f[2].is_empty() {
            // 名前の変更は「元のパス」「新しいパス」が続く
            parts.next();
            match parts.next() {
                Some(to) => to.to_string(),
                None => continue,
            }
        } else {
            f[2].to_string()
        };
        let stat = match (f[0].parse(), f[1].parse()) {
            (Ok(added), Ok(deleted)) => Some(LineStat { added, deleted }),
            _ => None,
        };
        map.insert(path, stat);
    }
    map
}

fn count_new_file_lines(repo: &Path, file: &str) -> Option<LineStat> {
    let bytes = std::fs::read(repo.join(file)).ok()?;
    if bytes.contains(&0) || bytes.len() > MAX_PREVIEW_BYTES {
        return None;
    }
    let added = String::from_utf8_lossy(&bytes).lines().count() as u32;
    Some(LineStat { added, deleted: 0 })
}

fn parse_status(out: &str) -> RepoStatus {
    let mut st = RepoStatus {
        branch: String::new(),
        head: String::new(),
        last_subject: String::new(),
        upstream: None,
        ahead: 0,
        behind: 0,
        unpushed: 0,
        default_branch: None,
        files: Vec::new(),
        conflicted: false,
        operation: None,
    };
    let mut entries = out.split('\0');
    while let Some(entry) = entries.next() {
        if entry.is_empty() {
            continue;
        }
        if let Some(header) = entry.strip_prefix("# ") {
            if let Some(v) = header.strip_prefix("branch.oid ") {
                st.head = if v == "(initial)" { String::new() } else { v.chars().take(7).collect() };
            } else if let Some(v) = header.strip_prefix("branch.head ") {
                st.branch = if v == "(detached)" { String::new() } else { v.to_string() };
            } else if let Some(v) = header.strip_prefix("branch.upstream ") {
                st.upstream = Some(v.to_string());
            } else if let Some(v) = header.strip_prefix("branch.ab ") {
                for token in v.split(' ') {
                    if let Some(n) = token.strip_prefix('+') {
                        st.ahead = n.parse().unwrap_or(0);
                    } else if let Some(n) = token.strip_prefix('-') {
                        st.behind = n.parse().unwrap_or(0);
                    }
                }
            }
            continue;
        }
        match entry.as_bytes()[0] {
            // 1 XY sub mH mI mW hH hI path
            b'1' => {
                let f: Vec<&str> = entry.splitn(9, ' ').collect();
                if f.len() == 9 {
                    st.files.push(change(f[1], f[8], None));
                }
            }
            // 2 XY sub mH mI mW hH hI Xscore path \0 origPath
            b'2' => {
                let f: Vec<&str> = entry.splitn(10, ' ').collect();
                let orig = entries.next().map(|s| s.to_string());
                if f.len() == 10 {
                    st.files.push(change(f[1], f[9], orig));
                }
            }
            // u XY sub m1 m2 m3 mW h1 h2 h3 path
            b'u' => {
                let f: Vec<&str> = entry.splitn(11, ' ').collect();
                if f.len() == 11 {
                    st.conflicted = true;
                    st.files.push(FileChange {
                        path: f[10].to_string(),
                        orig_path: None,
                        staged: "U".into(),
                        unstaged: "U".into(),
                        staged_lines: None,
                        unstaged_lines: None,
                    });
                }
            }
            b'?' => st.files.push(FileChange {
                path: entry[2..].to_string(),
                orig_path: None,
                staged: String::new(),
                unstaged: "?".into(),
                staged_lines: None,
                unstaged_lines: None,
            }),
            _ => {}
        }
    }
    st
}

fn change(xy: &str, path: &str, orig_path: Option<String>) -> FileChange {
    let mut chars = xy.chars();
    let pick = |c: Option<char>| match c {
        Some('.') | None => String::new(),
        Some(c) => c.to_string(),
    };
    let staged = pick(chars.next());
    let unstaged = pick(chars.next());
    FileChange { path: path.to_string(), orig_path, staged, unstaged, staged_lines: None, unstaged_lines: None }
}

pub fn list_branches(repo: &Path) -> Result<Vec<BranchInfo>, String> {
    // 名前は lstrip=2 で取る（refname:short は同じ名前のタグがあると "heads/0.2.1" のようになり、切り替えに使えない）
    let format = "--format=%(HEAD)%1f%(refname:lstrip=2)%1f%(upstream:lstrip=2)%1f%(upstream:track)%1f%(objectname:short)%1f%(committerdate:iso-strict)%1f%(subject)";
    let out = run(repo, &["for-each-ref", "refs/heads", format])?.output;
    Ok(parse_branches(&out))
}

fn parse_branches(out: &str) -> Vec<BranchInfo> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(7, '\u{1f}').collect();
            if f.len() != 7 {
                return None;
            }
            // track は "[ahead 1]" "[behind 2]" "[ahead 1, behind 2]" "[gone]" のいずれか（差がなければ空）
            let track = f[3].trim_matches(|c| c == '[' || c == ']');
            let mut ahead = 0;
            let mut behind = 0;
            for part in track.split(", ") {
                if let Some(n) = part.strip_prefix("ahead ") {
                    ahead = n.parse().unwrap_or(0);
                } else if let Some(n) = part.strip_prefix("behind ") {
                    behind = n.parse().unwrap_or(0);
                }
            }
            Some(BranchInfo {
                name: f[1].to_string(),
                current: f[0] == "*",
                upstream: if f[2].is_empty() { None } else { Some(f[2].to_string()) },
                ahead,
                behind,
                gone: track == "gone",
                head: f[4].to_string(),
                date: f[5].to_string(),
                subject: f[6].to_string(),
            })
        })
        .collect()
}

pub fn list_stashes(repo: &Path) -> Result<Vec<StashEntry>, String> {
    let out = run(repo, &["stash", "list", "--format=%gd%x1f%gs%x1f%cI"])?.output;
    let mut stashes = parse_stashes(&out);
    for s in &mut stashes {
        let stash_ref = format!("stash@{{{}}}", s.index);
        // 新しいファイルも数える（--include-untracked は git 2.32 から。古い git では付けずに数える）
        let names = run(repo, &["stash", "show", "--name-only", "--include-untracked", &stash_ref])
            .or_else(|_| run(repo, &["stash", "show", "--name-only", &stash_ref]));
        s.files = names.ok().map(|r| r.output.lines().filter(|l| !l.is_empty()).count() as u32);
    }
    Ok(stashes)
}

fn parse_stashes(out: &str) -> Vec<StashEntry> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(3, '\u{1f}').collect();
            if f.len() != 3 {
                return None;
            }
            let index = f[0].strip_prefix("stash@{")?.strip_suffix('}')?.parse().ok()?;
            Some(StashEntry { index, message: f[1].to_string(), date: f[2].to_string(), files: None })
        })
        .collect()
}

/// 1 つのコミットの内容（変更したファイルの一覧と差分）。大きすぎるときは途中まで
pub fn commit_detail(repo: &Path, hash: &str) -> Result<GitRun, String> {
    let mut r = run(repo, &["show", "--stat", "--patch", "--format=%H%n%an <%ae>%n%aI%n%n%B", hash])?;
    // --format は画面で読み分けるための指定なので、見せるコマンドは自分で打つときと同じ形にする
    r.command = display_command(&["show", "--stat", "--patch", &hash[..hash.len().min(7)]]);
    if r.output.len() > MAX_SHOW_BYTES {
        let mut cut = MAX_SHOW_BYTES;
        while !r.output.is_char_boundary(cut) {
            cut -= 1;
        }
        r.output.truncate(cut);
        r.output.push_str("\n（長いので、ここまでにしています）\n");
    }
    Ok(r)
}

const MAX_SHOW_BYTES: usize = 512 * 1024;

/// ファイルの差分。まだ git に追加していない新しいファイルは、中身をすべて「追加」として見せる
pub fn file_diff(repo: &Path, file: &str, staged: bool, untracked: bool) -> Result<GitRun, String> {
    if untracked {
        return Ok(new_file_diff(repo, file));
    }
    if staged {
        run(repo, &["diff", "--cached", "--", file])
    } else {
        run(repo, &["diff", "--", file])
    }
}

const MAX_PREVIEW_BYTES: usize = 256 * 1024;

fn new_file_diff(repo: &Path, file: &str) -> GitRun {
    let command = display_command(&["diff", "--no-index", "--", "/dev/null", file]);
    let output = match std::fs::read(repo.join(file)) {
        Err(e) => format!("（ファイルを読めませんでした: {}）", e),
        Ok(bytes) if bytes.contains(&0) => "（バイナリファイルのため、中身は表示しません）".to_string(),
        Ok(bytes) if bytes.len() > MAX_PREVIEW_BYTES => "（大きいファイルのため、中身は表示しません）".to_string(),
        Ok(bytes) => {
            let text = String::from_utf8_lossy(&bytes);
            let lines: Vec<&str> = text.lines().collect();
            let mut diff = format!("@@ -0,0 +1,{} @@\n", lines.len());
            for line in lines {
                diff.push('+');
                diff.push_str(line);
                diff.push('\n');
            }
            diff
        }
    };
    GitRun { command, output }
}

/// 選んだフォルダが git のリポジトリか、どの GitHub リポジトリにつながっているかを調べる
pub fn check_folder(path: &Path, owner: &str, repo: &str) -> FolderCheck {
    let top_level = match run(path, &["rev-parse", "--show-toplevel"]) {
        // git は Windows でも / 区切りで返すので、画面に出すときの見慣れた形（\ 区切り）にそろえる
        Ok(r) if cfg!(windows) => r.output.trim().replace('/', "\\"),
        Ok(r) => r.output.trim().to_string(),
        Err(_) => {
            return FolderCheck { is_repo: false, top_level: String::new(), remote_url: None, matches_project: false };
        }
    };
    let remote_url = run(path, &["remote", "get-url", "origin"]).ok().map(|r| r.output.trim().to_string());
    let matches_project = remote_url
        .as_deref()
        .and_then(github_repo_of)
        .map(|(o, r)| o == owner.to_lowercase() && r == repo.to_lowercase())
        .unwrap_or(false);
    FolderCheck { is_repo: true, top_level, remote_url, matches_project }
}

/// GitHub の URL から (owner, repo) を取り出す（https / ssh のどちらの書き方にも対応）
fn github_repo_of(url: &str) -> Option<(String, String)> {
    let lower = url.trim().to_lowercase();
    let rest = &lower[lower.find("github.com")? + "github.com".len()..];
    let rest = rest.trim_start_matches(|c| c == ':' || c == '/').trim_end_matches('/');
    let rest = rest.strip_suffix(".git").unwrap_or(rest);
    let mut parts = rest.split('/');
    let owner = parts.next().filter(|s| !s.is_empty())?;
    let repo = parts.next().filter(|s| !s.is_empty())?;
    Some((owner.to_string(), repo.to_string()))
}

/// GitHub からクローンする。parent の下に repo と同じ名前のフォルダを作る
pub fn clone_repo(parent: &Path, owner: &str, repo: &str) -> Result<(GitRun, String), String> {
    let dest = parent.join(repo);
    if dest.exists() {
        return Err(format!("{} はすでにあります。別のフォルダを選んでください", dest.display()));
    }
    let url = format!("https://github.com/{}/{}.git", owner, repo);
    let dest_str = dest.to_string_lossy().to_string();
    let result = run(parent, &["clone", &url, &dest_str])?;
    Ok((result, dest_str))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_status_with_branch_and_changes() {
        let out = "# branch.oid 799773a1234567890\0# branch.head feature\0# branch.upstream origin/feature\0# branch.ab +1 -0\0\
1 M. N... 100644 100644 100644 aaa bbb src/lib.rs\0\
1 .M N... 100644 100644 100644 aaa bbb src/App.tsx\0\
2 R. N... 100644 100644 100644 aaa bbb R100 docs/新しい名前.md\0docs/古い名前.md\0\
? メモ.txt\0";
        let st = parse_status(out);
        assert_eq!(st.branch, "feature");
        assert_eq!(st.head, "799773a");
        assert_eq!(st.upstream.as_deref(), Some("origin/feature"));
        assert_eq!((st.ahead, st.behind), (1, 0));
        assert_eq!(st.files.len(), 4);
        assert_eq!((st.files[0].staged.as_str(), st.files[0].unstaged.as_str()), ("M", ""));
        assert_eq!((st.files[1].staged.as_str(), st.files[1].unstaged.as_str()), ("", "M"));
        assert_eq!(st.files[2].path, "docs/新しい名前.md");
        assert_eq!(st.files[2].orig_path.as_deref(), Some("docs/古い名前.md"));
        assert_eq!((st.files[3].path.as_str(), st.files[3].unstaged.as_str()), ("メモ.txt", "?"));
        assert!(!st.conflicted);
    }

    #[test]
    fn parses_detached_and_initial_heads() {
        let st = parse_status("# branch.oid (initial)\0# branch.head (detached)\0");
        assert_eq!(st.head, "");
        assert_eq!(st.branch, "");
        assert_eq!(st.upstream, None);
    }

    #[test]
    fn parses_branch_tracking() {
        let out = "*\u{1f}feature\u{1f}origin/feature\u{1f}[ahead 1]\u{1f}799773a\u{1f}2026-09-27T15:48:00+09:00\u{1f}0.3.3 修正\n \
\u{1f}main\u{1f}origin/main\u{1f}[ahead 2, behind 3]\u{1f}9ba192d\u{1f}2026-03-19T17:01:57+09:00\u{1f}Merge branch 'feature'\n \
\u{1f}old\u{1f}origin/old\u{1f}[gone]\u{1f}6dda73a\u{1f}2026-03-18T17:42:00+09:00\u{1f}Bot機能廃止\n \
\u{1f}0.3.2\u{1f}\u{1f}\u{1f}9ac53fd\u{1f}2026-03-19T17:01:00+09:00\u{1f}0.3.2\n";
        let b = parse_branches(out);
        assert_eq!(b.len(), 4);
        assert!(b[0].current && b[0].ahead == 1 && b[0].behind == 0);
        assert_eq!((b[1].ahead, b[1].behind), (2, 3));
        assert!(b[2].gone);
        assert_eq!(b[3].upstream, None);
    }

    #[test]
    fn parses_stash_list() {
        let s = parse_stashes("stash@{0}\u{1f}On main: !!GitHub_Desktop<main>\u{1f}2026-03-18T12:15:00+09:00\n");
        assert_eq!(s, vec![StashEntry { index: 0, message: "On main: !!GitHub_Desktop<main>".into(), date: "2026-03-18T12:15:00+09:00".into(), files: None }]);
    }

    #[test]
    fn parses_numstat_with_renames_and_binaries() {
        let out = "3\t1\tsrc/App.tsx\0-\t-\ticon.png\02\t0\t\0docs/古い名前.md\0docs/新しい名前.md\0";
        let m = parse_numstat(out);
        assert_eq!(m.get("src/App.tsx"), Some(&Some(LineStat { added: 3, deleted: 1 })));
        assert_eq!(m.get("icon.png"), Some(&None));
        assert_eq!(m.get("docs/新しい名前.md"), Some(&Some(LineStat { added: 2, deleted: 0 })));
        assert_eq!(m.len(), 3);
    }

    #[test]
    fn reads_github_owner_and_repo_from_urls() {
        let expected = Some(("y0zrin".to_string(), "lifemanager".to_string()));
        assert_eq!(github_repo_of("https://github.com/y0zrin/LifeManager.git"), expected);
        assert_eq!(github_repo_of("https://github.com/y0zrin/LifeManager"), expected);
        assert_eq!(github_repo_of("git@github.com:y0zrin/LifeManager.git"), expected);
        assert_eq!(github_repo_of("ssh://git@github.com/y0zrin/LifeManager.git"), expected);
        assert_eq!(github_repo_of("https://gitlab.com/y0zrin/LifeManager.git"), None);
    }
}
