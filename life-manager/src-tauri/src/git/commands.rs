//! 画面から呼ぶ git のコマンド。git の実行には時間がかかることがあるので、どれも別スレッドで動かす
use super::conflict::{self, ConflictText};
use super::history::{self, History};
use super::ignore::{self, GitignoreText};
use super::publish;
use super::runner::{run, GitRun};
use super::setup;
use super::status::{self, BranchInfo, FolderCheck, RepoStatus, StashEntry};
use serde::Serialize;
use std::path::{Path, PathBuf};

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// ブランチ名などが「-」で始まると git のオプションとして解釈されてしまうので受け付けない
fn check_name(name: &str) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("名前を入力してください".into());
    }
    if name.starts_with('-') {
        return Err(format!("「{}」は使えない名前です（- で始まる名前は使えません）", name));
    }
    Ok(())
}

// --- 準備（git の有無、フォルダの確認、クローン） ---

#[tauri::command]
pub async fn git_version() -> Result<String, String> {
    blocking(|| Ok(run(&std::env::temp_dir(), &["--version"])?.output.trim().to_string())).await
}

/// 使う準備ができているか（Git が入っているか、コミットに使う名前とメールアドレスが決まっているか）
#[tauri::command]
pub async fn git_setup_status() -> Result<setup::SetupStatus, String> {
    blocking(|| Ok(setup::setup_status())).await
}

/// Git をインストールする（数分かかる。途中で管理者の確認が出る）
#[tauri::command]
pub async fn git_install() -> Result<GitRun, String> {
    setup::install_git().await
}

/// コミットに使う名前とメールアドレスを決める（git config --global）
#[tauri::command]
pub async fn git_set_identity(name: String, email: String) -> Result<GitRun, String> {
    blocking(move || setup::set_identity(&name, &email)).await
}

#[tauri::command]
pub async fn git_check_folder(path: String, owner: String, repo: String) -> Result<FolderCheck, String> {
    blocking(move || Ok(status::check_folder(Path::new(&path), &owner, &repo))).await
}

#[derive(Serialize)]
pub struct CloneResult {
    pub run: GitRun,
    pub path: String,
}

#[tauri::command]
pub async fn git_clone(parent: String, owner: String, repo: String) -> Result<CloneResult, String> {
    blocking(move || {
        let (run, path) = status::clone_repo(Path::new(&parent), &owner, &repo)?;
        Ok(CloneResult { run, path })
    })
    .await
}

// --- プロジェクトを追加（URL からクローン・手元のフォルダを GitHub に上げる） ---

/// URL（GitHub の URL・「持ち主/名前」など）からクローンする。parent の下に、リポジトリと同じ名前のフォルダを作る
#[tauri::command]
pub async fn git_clone_url(parent: String, url: String) -> Result<publish::CloneUrlResult, String> {
    blocking(move || publish::clone_url(Path::new(&parent), &url)).await
}

/// 上げる前のフォルダの様子（リポジトリか・ファイルの数・コミットの数など）
#[tauri::command]
pub async fn git_folder_state(path: String) -> Result<publish::FolderState, String> {
    blocking(move || publish::folder_state(Path::new(&path))).await
}

/// 記録を始める（まだなら git init・.gitignore のひな形・最初のコミット）
#[tauri::command]
pub async fn git_publish_prepare(path: String, template: String, message: String) -> Result<GitRun, String> {
    blocking(move || publish::prepare(Path::new(&path), &template, &message)).await
}

/// その URL にリポジトリがあるか（GitHub で作ったあとに確かめる）
#[tauri::command]
pub async fn git_remote_exists(url: String) -> Result<bool, String> {
    blocking(move || publish::remote_exists(&url)).await
}

/// origin を url にして、今のブランチを送る（上流にする）
#[tauri::command]
pub async fn git_publish_push(path: String, url: String) -> Result<GitRun, String> {
    blocking(move || publish::push_to(Path::new(&path), &url)).await
}

// --- 閲覧 ---

#[tauri::command]
pub async fn git_status(path: String) -> Result<RepoStatus, String> {
    blocking(move || status::read_status(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_branches(path: String) -> Result<Vec<BranchInfo>, String> {
    blocking(move || status::list_branches(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_stashes(path: String) -> Result<Vec<StashEntry>, String> {
    blocking(move || status::list_stashes(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_history(path: String) -> Result<History, String> {
    blocking(move || history::read_history(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_diff(path: String, file: String, staged: bool, untracked: bool) -> Result<GitRun, String> {
    blocking(move || status::file_diff(Path::new(&path), &file, staged, untracked)).await
}

// --- 作業（ステージ・コミット・同期・切り替え・退避） ---

fn with_files<'a>(head: &[&'a str], files: &'a [String]) -> Vec<&'a str> {
    let mut args = head.to_vec();
    args.push("--");
    args.extend(files.iter().map(|f| f.as_str()));
    args
}

#[tauri::command]
pub async fn git_stage(path: String, files: Vec<String>) -> Result<GitRun, String> {
    blocking(move || run(Path::new(&path), &with_files(&["add"], &files))).await
}

#[tauri::command]
pub async fn git_unstage(path: String, files: Vec<String>) -> Result<GitRun, String> {
    blocking(move || {
        let repo = PathBuf::from(&path);
        match run(&repo, &with_files(&["restore", "--staged"], &files)) {
            Ok(r) => Ok(r),
            // まだ 1 つもコミットがないリポジトリでは restore --staged が使えないので、索引から外す
            Err(_) => run(&repo, &with_files(&["rm", "--cached", "-q"], &files)),
        }
    })
    .await
}

/// messages の 1 つ目が要約、2 つ目からは説明の段落（それぞれ -m で渡す）。
/// 画面の「実行するコマンド」（src/lib/git.ts の commitArgs）と同じ順に引数を並べる
#[tauri::command]
pub async fn git_commit(path: String, messages: Vec<String>, amend: bool, allow_empty: bool) -> Result<GitRun, String> {
    let messages: Vec<String> = messages.into_iter().map(|m| m.trim().to_string()).collect();
    if messages.first().map_or(true, |s| s.is_empty()) {
        return Err("要約を入力してください".into());
    }
    blocking(move || {
        let mut args = vec!["commit"];
        if amend {
            args.push("--amend");
        }
        if allow_empty {
            args.push("--allow-empty");
        }
        for m in messages.iter().filter(|m| !m.is_empty()) {
            args.extend(["-m", m.as_str()]);
        }
        run(Path::new(&path), &args)
    })
    .await
}

#[tauri::command]
pub async fn git_push(path: String) -> Result<GitRun, String> {
    blocking(move || {
        let repo = PathBuf::from(&path);
        let st = status::read_status(&repo)?;
        if st.branch.is_empty() {
            return Err("ブランチから切り離された状態なので、プッシュできません。先にブランチに切り替えてください".into());
        }
        if st.upstream.is_some() {
            run(&repo, &["push"])
        } else {
            // まだ GitHub にないブランチは、公開して上流に設定する
            run(&repo, &["push", "-u", "origin", st.branch.as_str()])
        }
    })
    .await
}

#[tauri::command]
pub async fn git_pull(path: String) -> Result<GitRun, String> {
    // 取り込み方はマージ（設定によって rebase に変わったり、確認で止まったりしないように明示する）
    blocking(move || run(Path::new(&path), &["pull", "--no-rebase"])).await
}

#[tauri::command]
pub async fn git_fetch(path: String) -> Result<GitRun, String> {
    blocking(move || run(Path::new(&path), &["fetch", "--all", "--prune"])).await
}

/// 見ているブランチだけを、GitHub から読む（切り替えない）。git fetch origin <ブランチ>
#[tauri::command]
pub async fn git_fetch_branch(path: String, branch: String) -> Result<GitRun, String> {
    check_name(&branch)?;
    blocking(move || run(Path::new(&path), &["fetch", "origin", branch.trim()])).await
}

/// 見ているブランチを、切り替えずに GitHub の最新にする（ブランチ画面の「プル」）。
/// - 今のブランチなら、ふつうのプル
/// - この PC にまだないブランチは、GitHub のブランチを追いかけるブランチとして作る（git branch --track）
/// - 早送りできるとき（GitHub の方が進んでいる・同じ）は、git fetch origin X:X で進める
/// - この PC の方が進んでいるときは、何もしない（まだプッシュしていないコミットがある）
/// - 分かれているとき（両方に相手にないコミットがある）は、切り替えてからプルするよう伝える
#[tauri::command]
pub async fn git_pull_branch(path: String, branch: String) -> Result<GitRun, String> {
    check_name(&branch)?;
    blocking(move || pull_branch(&PathBuf::from(&path), branch.trim())).await
}

fn pull_branch(repo: &Path, b: &str) -> Result<GitRun, String> {
    let st = status::read_status(repo)?;
    if st.branch == b {
        return run(repo, &["pull", "--no-rebase"]);
    }
    let remote = format!("origin/{}", b);
    let fetched = run(repo, &["fetch", "origin", b])?;
    let local_exists = run(repo, &["rev-parse", "--verify", "--quiet", &format!("refs/heads/{}", b)]).is_ok();
    if !local_exists {
        let made = run(repo, &["branch", "--track", b, &remote])?;
        return Ok(GitRun { command: format!("{} && {}", fetched.command, made.command), output: PULL_CREATED.to_string() });
    }
    if run(repo, &["merge-base", "--is-ancestor", b, &remote]).is_ok() {
        // 早送りできる（GitHub の方が進んでいるか、同じ）
        let refspec = format!("{0}:{0}", b);
        return run(repo, &["fetch", "origin", &refspec]).map_err(|e| {
            if e.contains("checked out at") {
                format!("{}
→ {} は、別の作業フォルダで使っています。そちらでプルしてください", e, b)
            } else {
                e
            }
        });
    }
    if run(repo, &["merge-base", "--is-ancestor", &remote, b]).is_ok() {
        return Ok(GitRun { command: fetched.command, output: PULL_LOCAL_AHEAD.to_string() });
    }
    Err(format!(
        "git fetch origin {0}:{0}
{0} と GitHub の {0} が分かれています（それぞれに、相手にないコミットがあります）。
→ 「このブランチに切り替える」→ プルで取り込みます（git switch {0} → git pull）",
        b
    ))
}

/// git_pull_branch の結果の印（画面の言葉を変えるため）
pub const PULL_CREATED: &str = "created";
pub const PULL_LOCAL_AHEAD: &str = "local-ahead";

/// ブランチを切り替える。create なら作ってから切り替える（start があれば、そのコミットから作る）
#[tauri::command]
pub async fn git_switch(path: String, branch: String, create: bool, start: Option<String>) -> Result<GitRun, String> {
    check_name(&branch)?;
    if let Some(s) = start.as_deref() {
        check_name(s)?;
    }
    blocking(move || {
        let branch = branch.trim();
        let mut args = vec!["switch"];
        if create {
            args.push("-c");
        }
        args.push(branch);
        if let (true, Some(s)) = (create, start.as_deref()) {
            args.push(s.trim());
        }
        run(Path::new(&path), &args)
    })
    .await
}

/// ブランチではなく、そのコミットそのものを取り出す（切り離された HEAD）
#[tauri::command]
pub async fn git_detach(path: String, hash: String) -> Result<GitRun, String> {
    check_name(&hash)?;
    blocking(move || run(Path::new(&path), &["switch", "--detach", hash.trim()])).await
}

#[tauri::command]
pub async fn git_stash_push(path: String, message: String) -> Result<GitRun, String> {
    blocking(move || {
        // まだ git に追加していない新しいファイルも一緒に退避する
        let mut args = vec!["stash", "push", "-u"];
        let message = message.trim();
        if !message.is_empty() {
            args.extend(["-m", message]);
        }
        run(Path::new(&path), &args)
    })
    .await
}

#[tauri::command]
pub async fn git_stash_pop(path: String, index: u32) -> Result<GitRun, String> {
    blocking(move || run(Path::new(&path), &["stash", "pop", &format!("stash@{{{}}}", index)])).await
}

#[tauri::command]
pub async fn git_stash_drop(path: String, index: u32) -> Result<GitRun, String> {
    blocking(move || run(Path::new(&path), &["stash", "drop", &format!("stash@{{{}}}", index)])).await
}

/// タグを付ける。target がなければ今のコミットに付ける
#[tauri::command]
pub async fn git_tag(path: String, name: String, target: Option<String>) -> Result<GitRun, String> {
    check_name(&name)?;
    if let Some(t) = target.as_deref() {
        check_name(t)?;
    }
    blocking(move || {
        let mut args = vec!["tag", name.trim()];
        if let Some(t) = target.as_deref() {
            args.push(t.trim());
        }
        run(Path::new(&path), &args)
    })
    .await
}

/// 作業中の変更をすべて捨てる（元に戻せないので、画面で確認してから呼ぶ）。
/// include_untracked なら、まだ git に追加していない新しいファイルも消す
#[tauri::command]
pub async fn git_discard_all(path: String, include_untracked: bool) -> Result<GitRun, String> {
    blocking(move || {
        let repo = PathBuf::from(&path);
        let mut runs = vec![run(&repo, &["restore", "--staged", "--worktree", "--", "."])?];
        if include_untracked {
            runs.push(run(&repo, &["clean", "-fd", "--", "."])?);
        }
        Ok(combine(runs))
    })
    .await
}

// --- 無視するファイル（.gitignore） ---

/// パターンに当てはまる、git で管理しているファイル（.gitignore に書いても無視されないもの）
#[tauri::command]
pub async fn git_ignore_tracked(path: String, pattern: String) -> Result<Vec<String>, String> {
    blocking(move || ignore::tracked_matching(Path::new(&path), &pattern)).await
}

/// .gitignore にパターンを書き足す。untrack があれば、そのパスに当てはまるファイルを管理から外す（git rm --cached）
#[tauri::command]
pub async fn git_ignore_add(path: String, pattern: String, untrack: Option<String>, recursive: bool) -> Result<GitRun, String> {
    blocking(move || ignore::add_ignore(Path::new(&path), &pattern, untrack.as_deref(), recursive)).await
}

#[tauri::command]
pub async fn git_gitignore_read(path: String) -> Result<GitignoreText, String> {
    blocking(move || ignore::read_gitignore(Path::new(&path))).await
}

#[tauri::command]
pub async fn git_gitignore_write(path: String, text: String) -> Result<GitRun, String> {
    blocking(move || ignore::write_gitignore(Path::new(&path), &text)).await
}

// --- コミットの操作（ブランチ画面・全体図のメニュー） ---

#[tauri::command]
pub async fn git_show(path: String, hash: String) -> Result<GitRun, String> {
    check_name(&hash)?;
    blocking(move || status::commit_detail(Path::new(&path), hash.trim())).await
}

/// そのコミットの変更を、今のブランチにもう一度取り込む
#[tauri::command]
pub async fn git_cherry_pick(path: String, hash: String) -> Result<GitRun, String> {
    check_name(&hash)?;
    blocking(move || run(Path::new(&path), &["cherry-pick", hash.trim()])).await
}

/// そのコミットの変更を打ち消すコミットを作る（履歴は消さない）
#[tauri::command]
pub async fn git_revert(path: String, hash: String) -> Result<GitRun, String> {
    check_name(&hash)?;
    blocking(move || run(Path::new(&path), &["revert", "--no-edit", hash.trim()])).await
}

/// 今のブランチをそのコミットまで戻す。mode は soft（変更はステージに残す）/ mixed（作業中に残す）/ hard（捨てる）
#[tauri::command]
pub async fn git_reset(path: String, hash: String, mode: String) -> Result<GitRun, String> {
    check_name(&hash)?;
    let flag = match mode.as_str() {
        "soft" => "--soft",
        "mixed" => "--mixed",
        "hard" => "--hard",
        _ => return Err(format!("戻し方「{}」は使えません", mode)),
    };
    blocking(move || run(Path::new(&path), &["reset", flag, hash.trim()])).await
}

// --- ブランチの操作 ---

/// 同じ名前のタグがあるときは、ブランチだと分かるように refs/heads/ を付ける（付けないとタグの方が使われる）
fn branch_ref(repo: &Path, name: &str) -> String {
    let tag = format!("refs/tags/{}", name);
    let head = format!("refs/heads/{}", name);
    let has = |r: &str| run(repo, &["show-ref", "--verify", "--quiet", r]).is_ok();
    if has(&head) && has(&tag) {
        head
    } else {
        name.to_string()
    }
}

/// branch を今のブランチに取り込む
#[tauri::command]
pub async fn git_merge(path: String, branch: String) -> Result<GitRun, String> {
    check_name(&branch)?;
    blocking(move || {
        let repo = PathBuf::from(&path);
        let target = branch_ref(&repo, branch.trim());
        run(&repo, &["merge", "--no-edit", target.as_str()])
    })
    .await
}

/// 今のブランチのコミットを、branch の先に付け替える
#[tauri::command]
pub async fn git_rebase(path: String, branch: String) -> Result<GitRun, String> {
    check_name(&branch)?;
    blocking(move || {
        let repo = PathBuf::from(&path);
        let target = branch_ref(&repo, branch.trim());
        run(&repo, &["rebase", target.as_str()])
    })
    .await
}

/// 今のブランチ以外もプッシュできるように、ブランチを指定して送る（まだ GitHub になければ公開して上流に設定する）
#[tauri::command]
pub async fn git_push_branch(path: String, branch: String) -> Result<GitRun, String> {
    check_name(&branch)?;
    blocking(move || {
        let repo = PathBuf::from(&path);
        let branch = branch.trim();
        let upstream = run(&repo, &["rev-parse", "--abbrev-ref", &format!("{}@{{upstream}}", branch)]).is_ok();
        if upstream {
            run(&repo, &["push", "origin", branch])
        } else {
            run(&repo, &["push", "-u", "origin", branch])
        }
    })
    .await
}

/// GitHub の同じ名前のブランチを上流（プッシュ・プルの相手）にする
#[tauri::command]
pub async fn git_set_upstream(path: String, branch: String) -> Result<GitRun, String> {
    check_name(&branch)?;
    blocking(move || {
        let branch = branch.trim();
        run(Path::new(&path), &["branch", "-u", &format!("origin/{}", branch), branch])
    })
    .await
}

#[tauri::command]
pub async fn git_rename_branch(path: String, from: String, to: String) -> Result<GitRun, String> {
    check_name(&from)?;
    check_name(&to)?;
    blocking(move || run(Path::new(&path), &["branch", "-m", from.trim(), to.trim()])).await
}

/// ブランチを消す。force でなければ、どこにもマージしていないコミットがあるときは消さない（git が止める）
#[tauri::command]
pub async fn git_delete_branch(path: String, branch: String, force: bool) -> Result<GitRun, String> {
    check_name(&branch)?;
    blocking(move || run(Path::new(&path), &["branch", if force { "-D" } else { "-d" }, branch.trim()])).await
}

// --- 競合を直す（マージツール） ---

/// 競合したファイルの中身（印の読み分けは画面の側）
#[tauri::command]
pub async fn git_conflict_file(path: String, file: String) -> Result<ConflictText, String> {
    blocking(move || conflict::read(Path::new(&path), &file)).await
}

/// 直した中身を書いて、ステージする
#[tauri::command]
pub async fn git_resolve_conflict(path: String, file: String, text: String) -> Result<GitRun, String> {
    blocking(move || conflict::resolve(Path::new(&path), &file, &text)).await
}

/// 作業フォルダに新しいファイルを置く（ステージはしない。作業タブでチェックを入れてコミットする）
#[tauri::command]
pub async fn git_add_new_file(path: String, file: String, text: String) -> Result<(), String> {
    blocking(move || conflict::write_new(Path::new(&path), &file, &text)).await
}

/// ファイルを片方の内容（ours・theirs）にするか、消したままにして（delete）、ステージする
#[tauri::command]
pub async fn git_take_side(path: String, file: String, side: String) -> Result<GitRun, String> {
    blocking(move || conflict::take_side(Path::new(&path), &file, &side)).await
}

/// ファイルを、いつものアプリ（エディタなど）で開く
#[tauri::command]
pub async fn git_open_file(path: String, file: String) -> Result<(), String> {
    blocking(move || conflict::open(Path::new(&path), &file)).await
}

// --- 途中で止まった操作（マージ・リベース・チェリーピック・リバート）---

fn operation_command(operation: &str) -> Result<&'static str, String> {
    match operation {
        "merge" => Ok("merge"),
        "rebase" => Ok("rebase"),
        "cherry-pick" => Ok("cherry-pick"),
        "revert" => Ok("revert"),
        _ => Err(format!("「{}」は中止・続行できる操作ではありません", operation)),
    }
}

/// 途中の操作をやめて、始める前の状態に戻す
#[tauri::command]
pub async fn git_abort(path: String, operation: String) -> Result<GitRun, String> {
    let op = operation_command(&operation)?;
    blocking(move || run(Path::new(&path), &[op, "--abort"])).await
}

/// 競合を直してステージしたあと、途中の操作を先へ進める（マージはコミットで完了するので使わない）
#[tauri::command]
pub async fn git_continue(path: String, operation: String) -> Result<GitRun, String> {
    let op = operation_command(&operation)?;
    if op == "merge" {
        return Err("マージは、コミットすると完了します".into());
    }
    blocking(move || run(Path::new(&path), &[op, "--continue"])).await
}

/// 続けて実行したコマンドを 1 つの結果にまとめる（画面には && でつないで見せる）
fn combine(runs: Vec<GitRun>) -> GitRun {
    GitRun {
        command: runs.iter().map(|r| r.command.as_str()).collect::<Vec<_>>().join(" && "),
        output: runs.iter().map(|r| r.output.trim_end()).filter(|o| !o.is_empty()).collect::<Vec<_>>().join("\n"),
    }
}

// --- そのほか ---

/// このフォルダでターミナルを開く（自分で git のコマンドを打って試せるように）
#[tauri::command]
pub async fn git_open_terminal(path: String) -> Result<(), String> {
    blocking(move || open_terminal(Path::new(&path))).await
}

#[cfg(windows)]
fn open_terminal(dir: &Path) -> Result<(), String> {
    use std::os::windows::process::CommandExt;
    const CREATE_NEW_CONSOLE: u32 = 0x0000_0010;
    std::process::Command::new("powershell.exe")
        .current_dir(dir)
        .creation_flags(CREATE_NEW_CONSOLE)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("ターミナルを開けませんでした: {}", e))
}

#[cfg(target_os = "macos")]
fn open_terminal(dir: &Path) -> Result<(), String> {
    std::process::Command::new("open")
        .args(["-a", "Terminal"])
        .arg(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("ターミナルを開けませんでした: {}", e))
}

#[cfg(all(unix, not(target_os = "macos")))]
fn open_terminal(dir: &Path) -> Result<(), String> {
    std::process::Command::new("x-terminal-emulator")
        .current_dir(dir)
        .spawn()
        .map(|_| ())
        .map_err(|e| format!("ターミナルを開けませんでした: {}", e))
}
