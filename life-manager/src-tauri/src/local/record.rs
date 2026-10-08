//! データのフォルダ（.lifemanager）の git の記録（1.1 の詳細設計 2.7。N-03・N-04）。
//! 書くたびに note で「何をしたか」を知らせ、3 秒何も来なければ、それまでの分をまとめて 1 つのコミットにする。
//! git が入っていない・失敗したときは、記録しないで続ける（タスクは使える）。git を入れたら、その時から記録する
use super::LocalProject;
use crate::git::runner::{self, GitRun};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};

/// 最後に書いてから、まとめてコミットするまで
const QUIET: Duration = Duration::from_secs(3);
/// 作品の git に入れないための行（作品の .git/info/exclude に足す）
const EXCLUDE_LINE: &str = "/.lifemanager/";
/// コミットの題（データのフォルダの記録に書く文なので、訳さない。題の文はこのファイルに集める）
pub const CREATED_PROJECT: &str = "プロジェクトを作った";

/// 自動のコミットに使う名前とメールアドレス（この PC の git に決まっていないとき）
const FALLBACK_NAME: &str = "Life Manager";
const FALLBACK_EMAIL: &str = "lifemanager@localhost";

struct Pending {
    messages: Vec<String>,
    due: Instant,
}

/// まだコミットしていない「何をしたか」（キーはデータのフォルダ）。ある間は、待つスレッドが 1 つ動いている
static PENDING: Mutex<BTreeMap<PathBuf, Pending>> = Mutex::new(BTreeMap::new());

/// 作るとき・開くとき: データのフォルダを git にし、作品の git から外す
pub fn ensure(project: &LocalProject) {
    ensure_exclude(&project.root);
    if !project.data.join(".git").exists() {
        if let Err(e) = init(&project.data) {
            eprintln!("データのフォルダを git にできませんでした（記録しないで続けます）: {}", e);
            return;
        }
    }
    clear_stale_lock(&project.data);
}

fn init(data: &Path) -> Result<(), String> {
    std::fs::create_dir_all(data).map_err(|e| e.to_string())?;
    runner::run(data, &["init", "--quiet"])?;
    // アプリが自動でコミットするので、この PC の全体の設定にあるフック・署名・改行の変換は使わない
    for (key, value) in [("core.autocrlf", "false"), ("commit.gpgsign", "false"), ("core.hooksPath", ".git/hooks")] {
        git(data, &["config", key, value])?;
    }
    return Ok(());
}

/// データのフォルダの git を呼ぶ。.git を直に指して、データのフォルダに git がないときに作品の git を触らないようにする
fn git(data: &Path, args: &[&str]) -> Result<GitRun, String> {
    let mut all = vec!["--git-dir=.git", "--work-tree=."];
    all.extend_from_slice(args);
    return runner::run(data, &all);
}

/// 作品の .git/info/exclude に /.lifemanager/ を足す（何度呼んでも 1 行）。作品が git でなければ何もしない。
/// 作品のフォルダがあとから git になったときのために、開くたびに呼ぶ
pub fn ensure_exclude(root: &Path) {
    let Some(path) = exclude_path(root) else { return };
    let current = std::fs::read_to_string(&path).unwrap_or_default();
    let listed = current.lines().any(|l| matches!(l.trim(), "/.lifemanager/" | "/.lifemanager" | ".lifemanager/" | ".lifemanager"));
    if listed {
        return;
    }
    let add = format!("{}{}\n", if current.is_empty() || current.ends_with('\n') { "" } else { "\n" }, EXCLUDE_LINE);
    let written = path
        .parent()
        .map_or(Ok(()), std::fs::create_dir_all)
        .and_then(|_| std::fs::OpenOptions::new().create(true).append(true).open(&path)?.write_all(add.as_bytes()));
    if let Err(e) = written {
        eprintln!("{} に {} を足せませんでした: {}", path.display(), EXCLUDE_LINE, e);
    }
}

fn exclude_path(root: &Path) -> Option<PathBuf> {
    let dot_git = root.join(".git");
    if dot_git.is_dir() {
        return Some(dot_git.join("info").join("exclude"));
    }
    if dot_git.is_file() {
        // worktree・submodule（.git が「gitdir: …」のファイル）。info/exclude の場所は git に聞く
        let run = runner::run(root, &["rev-parse", "--git-path", "info/exclude"]).ok()?;
        let path = PathBuf::from(run.output.trim());
        return Some(if path.is_absolute() { path } else { root.join(path) });
    }
    return None;
}

/// 前にアプリが止まって残った git の鍵（index.lock）を消す。開くときに呼ぶ（このときはコミットしていない）。
/// ほかで git を使っているかもしれないので、1 分より古いものだけ
fn clear_stale_lock(data: &Path) {
    let lock = data.join(".git").join("index.lock");
    let stale = std::fs::metadata(&lock)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.elapsed().ok())
        .is_some_and(|age| age > Duration::from_secs(60));
    if stale {
        let _ = std::fs::remove_file(&lock);
    }
}

/// 書いたことを知らせる（書いたあとに、鍵を取った中で呼んでよい）。3 秒何も来なければ、それまでの分をまとめてコミットする
pub fn note(project: &LocalProject, what: &str) {
    let mut pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
    let due = Instant::now() + QUIET;
    if let Some(p) = pending.get_mut(&project.data) {
        p.messages.push(what.to_string());
        p.due = due;
        return;
    }
    pending.insert(project.data.clone(), Pending { messages: vec![what.to_string()], due });
    let project = project.clone();
    std::thread::spawn(move || wait_and_commit(project));
}

/// 3 秒何も来なくなるまで待って、まとめてコミットする
fn wait_and_commit(project: LocalProject) {
    loop {
        let left = {
            let pending = PENDING.lock().unwrap_or_else(|e| e.into_inner());
            let Some(p) = pending.get(&project.data) else { return };
            p.due.saturating_duration_since(Instant::now())
        };
        if left.is_zero() {
            break;
        }
        std::thread::sleep(left);
    }
    // 鍵を取ってから「何をしたか」を受け取る（書いている途中のものは、書き終わってからいっしょにコミットする）
    project.locked(|| {
        let messages = PENDING.lock().unwrap_or_else(|e| e.into_inner()).remove(&project.data).map(|p| p.messages).unwrap_or_default();
        if messages.is_empty() {
            return;
        }
        if let Err(e) = commit(&project, &message(&messages)) {
            eprintln!("データのフォルダをコミットできませんでした（記録しないで続けます）: {}", e);
        }
    });
}

/// すぐにコミットする（プロジェクトを作ったとき）
pub fn commit_now(project: &LocalProject, what: &str) {
    project.locked(|| {
        if let Err(e) = commit(project, what) {
            eprintln!("データのフォルダをコミットできませんでした（記録しないで続けます）: {}", e);
        }
    });
}

fn commit(project: &LocalProject, title: &str) -> Result<(), String> {
    let data = &project.data;
    if !data.join(".git").exists() {
        // あとから git を入れたとき
        init(data)?;
        ensure_exclude(&project.root);
    }
    git(data, &["add", "-A"])?;
    if git(data, &["diff", "--cached", "--quiet"]).is_ok() {
        return Ok(()); // 変わったものがない
    }
    let has = |key: &str| git(data, &["config", "--get", key]).is_ok_and(|r| !r.output.trim().is_empty());
    let identity = identity_args(has("user.name"), has("user.email"));
    let mut args: Vec<&str> = identity.iter().map(|s| s.as_str()).collect();
    args.extend(["commit", "--quiet", "-m", title]);
    git(data, &args)?;
    return Ok(());
}

/// この PC の git に名前・メールアドレスがないときに足す（-c user.name=Life Manager など）
fn identity_args(has_name: bool, has_email: bool) -> Vec<String> {
    let mut args = Vec::new();
    if !has_name {
        args.extend(["-c".to_string(), format!("user.name={}", FALLBACK_NAME)]);
    }
    if !has_email {
        args.extend(["-c".to_string(), format!("user.email={}", FALLBACK_EMAIL)]);
    }
    return args;
}

/// コミットの題。同じ文は 1 つにまとめ、「、」でつなぐ。4 つ以上なら最初の 3 つと「ほか N 件」
pub fn message(items: &[String]) -> String {
    let mut unique: Vec<&str> = Vec::new();
    for item in items {
        if !unique.contains(&item.as_str()) {
            unique.push(item);
        }
    }
    if unique.len() <= 3 {
        return unique.join("、");
    }
    return format!("{}、ほか {} 件", unique[..3].join("、"), unique.len() - 3);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::tests::Scratch;
    use crate::local::DATA_DIR;
    use std::fs;

    fn strings(items: &[&str]) -> Vec<String> {
        return items.iter().map(|s| s.to_string()).collect();
    }

    fn log(dir: &Path) -> Vec<String> {
        return match runner::run(dir, &["log", "--format=%s"]) {
            Ok(run) => run.output.lines().map(|l| l.to_string()).collect(),
            Err(_) => Vec::new(),
        };
    }

    // UT-21: 1〜3 件は「、」でつなぐ。4 件以上は最初の 3 つと「ほか N 件」。同じ文は 1 つにまとめる
    #[test]
    fn message_joins_up_to_three() {
        assert_eq!(message(&strings(&["#13 を作った"])), "#13 を作った");
        assert_eq!(message(&strings(&["#12 の状態を 進行中 に", "#13 を作った", "設定: ボードの区画"])), "#12 の状態を 進行中 に、#13 を作った、設定: ボードの区画");
        assert_eq!(message(&strings(&["a", "b", "c", "d", "e"])), "a、b、c、ほか 2 件");
        assert_eq!(message(&strings(&["#12 を直した", "#12 を直した", "#13 を作った"])), "#12 を直した、#13 を作った");
    }

    #[test]
    fn identity_fills_only_what_is_missing() {
        assert!(identity_args(true, true).is_empty());
        assert_eq!(identity_args(false, true), strings(&["-c", "user.name=Life Manager"]));
        assert_eq!(identity_args(false, false), strings(&["-c", "user.name=Life Manager", "-c", "user.email=lifemanager@localhost"]));
    }

    // UT-22: 作品の .git/info/exclude に /.lifemanager/ を 1 回だけ足す（何度呼んでも 1 行）。作品が git でなければ何もしない
    #[test]
    fn exclude_line_is_added_once() {
        let s = Scratch::new("exclude");
        let plain = s.root.join("plain");
        fs::create_dir_all(&plain).unwrap();
        ensure_exclude(&plain);
        assert!(!plain.join(".git").exists());

        let work = s.root.join("work");
        fs::create_dir_all(&work).unwrap();
        runner::run(&work, &["init", "--quiet"]).unwrap();
        let exclude = work.join(".git").join("info").join("exclude");
        fs::write(&exclude, "# 前からある行\n*.log").unwrap();
        ensure_exclude(&work);
        ensure_exclude(&work);
        assert_eq!(fs::read_to_string(&exclude).unwrap(), "# 前からある行\n*.log\n/.lifemanager/\n");
    }

    // UT-23: 続けて 3 回書くと、3 秒のあとにデータのフォルダにコミットが 1 つ。作品の git log には出ない
    #[test]
    fn writes_in_a_row_become_one_commit() {
        let s = Scratch::new("record");
        let work = s.root.join("work");
        fs::create_dir_all(&work).unwrap();
        runner::run(&work, &["init", "--quiet"]).unwrap();
        fs::write(work.join("README.md"), "作品\n").unwrap();
        runner::run(&work, &["add", "-A"]).unwrap();
        runner::run(&work, &["commit", "--quiet", "-m", "作品の最初"]).unwrap();

        let project = LocalProject::create(&work, "game", "y0zrin").unwrap();
        let data = work.join(DATA_DIR);
        assert_eq!(log(&data), strings(&["プロジェクトを作った"]));

        for (i, what) in ["#1 を作った", "#1 の状態を 進行中 に", "#2 を作った"].iter().enumerate() {
            project.locked(|| {
                project.write_text(&format!("tasks/{}/task.md", i + 1), "---\n---\n").unwrap();
                note(&project, what);
            });
        }
        // まだコミットしていない（最後に書いてから 3 秒待つ）
        assert_eq!(log(&data).len(), 1);
        let started = Instant::now();
        while log(&data).len() < 2 && started.elapsed() < Duration::from_secs(10) {
            std::thread::sleep(Duration::from_millis(100));
        }
        assert!(started.elapsed() >= Duration::from_millis(2500), "{:?}", started.elapsed());
        std::thread::sleep(Duration::from_millis(300));
        assert_eq!(log(&data), strings(&["#1 を作った、#1 の状態を 進行中 に、#2 を作った", "プロジェクトを作った"]));

        // 作品の git からは見えない
        assert_eq!(log(&work), strings(&["作品の最初"]));
        assert_eq!(runner::run(&work, &["status", "--porcelain"]).unwrap().output.trim(), "");
    }
}
