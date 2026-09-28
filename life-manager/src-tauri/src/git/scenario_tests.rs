//! 本物の git を使った通しのテスト。使い捨てのフォルダに GitHub の代わりの空リポジトリ（bare）と、
//! 二人分の作業フォルダを作り、画面から呼ぶコマンドをそのまま実行して結果を確かめる。
//! 利用者の git の設定（~/.gitconfig・Git for Windows の設定）には左右されないようにしてある。
use super::commands::*;
use super::history::read_history;
use super::runner::run;
use super::status::{check_folder, list_branches, list_stashes, read_status, RepoStatus};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Once;

static ISOLATE: Once = Once::new();
static COUNTER: AtomicUsize = AtomicUsize::new(0);

/// 利用者の git の設定を読まないようにする（空の設定ファイルを「全体の設定」にし、システムの設定は読まない）
pub(super) fn isolate_git_config() {
    ISOLATE.call_once(|| {
        let dir = std::env::temp_dir().join(format!("lm-git-config-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let global = dir.join("gitconfig");
        // 名前・メールは、リポジトリごとに決める前の操作（新しいフォルダの最初のコミットなど）でも使う
        fs::write(&global, "[user]\n\tname = Test\n\temail = test@example.com\n[commit]\n\tgpgsign = false\n[core]\n\tautocrlf = false\n").unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &global);
        std::env::set_var("GIT_CONFIG_NOSYSTEM", "1");
    });
}

/// テストごとの使い捨てフォルダ（終わったら消す）
struct Sandbox {
    root: PathBuf,
}

impl Sandbox {
    fn new(name: &str) -> Self {
        isolate_git_config();
        let n = COUNTER.fetch_add(1, Ordering::SeqCst);
        let root = std::env::temp_dir().join(format!("lm-git-{}-{}-{}", name, std::process::id(), n));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(&root).unwrap();
        Sandbox { root }
    }

    fn dir(&self, name: &str) -> PathBuf {
        self.root.join(name)
    }
}

impl Drop for Sandbox {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

fn block<T>(f: impl std::future::Future<Output = T>) -> T {
    tauri::async_runtime::block_on(f)
}

fn s(p: &Path) -> String {
    p.to_string_lossy().to_string()
}

/// 準備用に git を直接呼ぶ（失敗したらテストを止める）
fn git(dir: &Path, args: &[&str]) -> String {
    run(dir, args).unwrap_or_else(|e| panic!("{}", e)).output
}

fn write(dir: &Path, file: &str, content: &str) {
    let path = dir.join(file);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).unwrap();
    }
    fs::write(path, content).unwrap();
}

fn read(dir: &Path, file: &str) -> String {
    fs::read_to_string(dir.join(file)).unwrap()
}

fn configure(dir: &Path, name: &str) {
    git(dir, &["config", "user.name", name]);
    git(dir, &["config", "user.email", &format!("{}@example.com", name.to_lowercase())]);
    git(dir, &["config", "commit.gpgsign", "false"]);
    git(dir, &["config", "core.autocrlf", "false"]);
}

fn init_repo(dir: &Path) {
    fs::create_dir_all(dir).unwrap();
    git(dir, &["init", "-q", "-b", "main"]);
    configure(dir, "Aoki");
}

/// 画面から呼ぶのと同じコマンドで、ステージしてコミットする
fn commit_all(dir: &Path, message: &str) {
    block(git_stage(s(dir), vec![".".into()])).unwrap();
    block(git_commit(s(dir), vec![message.into()], false, false)).unwrap();
}

fn status(dir: &Path) -> RepoStatus {
    read_status(dir).unwrap()
}

fn head(dir: &Path) -> String {
    git(dir, &["rev-parse", "HEAD"]).trim().to_string()
}

/// GitHub の代わりの空リポジトリと、A さん・B さんの作業フォルダ（どちらも main に最初のコミットがある）
struct Team {
    _sb: Sandbox,
    a: PathBuf,
    b: PathBuf,
}

fn team(name: &str) -> Team {
    let sb = Sandbox::new(name);
    let remote = sb.dir("remote.git");
    fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);

    let a = sb.dir("a");
    init_repo(&a);
    write(&a, "shared.txt", "一行目\n二行目\n三行目\n");
    commit_all(&a, "最初のコミット");
    git(&a, &["remote", "add", "origin", &s(&remote)]);
    git(&a, &["push", "-q", "-u", "origin", "main"]);

    let b = sb.dir("b");
    git(&sb.root, &["clone", "-q", &s(&remote), &s(&b)]);
    configure(&b, "Baba");
    Team { _sb: sb, a, b }
}

// ---------------------------------------------------------------- コミット・プッシュ

#[test]
fn commit_amend_empty_and_push_new_branch() {
    let t = team("commit");
    block(git_switch(s(&t.a), "feature/enemy-ai".into(), true, None)).unwrap();
    write(&t.a, "src/Enemy.cpp", "void Enemy() {}\n");
    block(git_stage(s(&t.a), vec!["src/Enemy.cpp".into()])).unwrap();

    // 要約がないと断る
    assert!(block(git_commit(s(&t.a), vec!["  ".into()], false, false)).is_err());

    // 要約と説明の段落
    let r = block(git_commit(s(&t.a), vec!["敵の索敵を足す".into(), "壁越しに追ってくるため (#12)".into()], false, false)).unwrap();
    assert!(r.command.starts_with("git commit -m"), "{}", r.command);
    let body = git(&t.a, &["log", "-1", "--format=%B"]);
    assert!(body.starts_with("敵の索敵を足す\n\n壁越しに追ってくるため (#12)"), "{}", body);

    let st = status(&t.a);
    assert_eq!(st.branch, "feature/enemy-ai");
    assert_eq!(st.upstream, None);
    assert_eq!(st.unpushed, 1);
    assert_eq!(st.last_subject, "敵の索敵を足す");

    // 直前のコミットを直す（amend）・空のコミット
    block(git_commit(s(&t.a), vec!["敵の索敵に、壁の判定を足す".into()], true, false)).unwrap();
    assert_eq!(git(&t.a, &["rev-list", "--count", "HEAD"]).trim(), "2");
    assert_eq!(status(&t.a).last_subject, "敵の索敵に、壁の判定を足す");
    block(git_commit(s(&t.a), vec!["ビルドを動かすための空コミット".into()], false, true)).unwrap();
    assert_eq!(git(&t.a, &["rev-list", "--count", "HEAD"]).trim(), "3");

    // まだ GitHub にないブランチは、プッシュすると上流が決まる
    let r = block(git_push(s(&t.a))).unwrap();
    assert_eq!(r.command, "git push -u origin feature/enemy-ai");
    let st = status(&t.a);
    assert_eq!(st.upstream.as_deref(), Some("origin/feature/enemy-ai"));
    assert_eq!((st.ahead, st.unpushed), (0, 0));

    // 2 回目からはそのまま送る
    write(&t.a, "src/Enemy.cpp", "void Enemy() { Search(); }\n");
    commit_all(&t.a, "索敵を呼ぶ");
    assert_eq!(status(&t.a).ahead, 1);
    assert_eq!(block(git_push(s(&t.a))).unwrap().command, "git push");
    assert_eq!(status(&t.a).ahead, 0);
}

#[test]
fn pull_fast_forwards_merges_without_editor_and_push_is_rejected_when_behind() {
    let t = team("pull");
    // B が送った変更を、A が取り込む（早送り）
    write(&t.b, "stage.csv", "slime,120,400\n");
    commit_all(&t.b, "ステージ2を追加");
    git(&t.b, &["push", "-q"]);
    block(git_pull(s(&t.a))).unwrap();
    assert_eq!(read(&t.a, "stage.csv"), "slime,120,400\n");
    assert_eq!(git(&t.a, &["rev-list", "--count", "HEAD"]).trim(), "2");

    // 両方に新しいコミットがあると、A のプッシュは断られる（ヒント付き）
    write(&t.a, "a.txt", "A\n");
    commit_all(&t.a, "A の変更");
    write(&t.b, "b.txt", "B\n");
    commit_all(&t.b, "B の変更");
    git(&t.b, &["push", "-q"]);
    let err = block(git_push(s(&t.a))).unwrap_err();
    assert!(err.contains("先にプルして"), "{}", err);

    // プルすると、エディタで止まらずにマージのコミットができる
    block(git_pull(s(&t.a))).unwrap();
    let parents = git(&t.a, &["log", "-1", "--format=%P"]);
    assert_eq!(parents.split_whitespace().count(), 2, "マージのコミットになっていない");
    let st = status(&t.a);
    assert!(st.files.is_empty() && st.operation.is_none());
    assert_eq!(st.ahead, 2);
    block(git_push(s(&t.a))).unwrap();
    assert_eq!(status(&t.a).ahead, 0);
}

// ---------------------------------------------------------------- 競合

/// main と feature で、shared.txt の 2 行目を別々に変える
fn diverge_on_line_two(dir: &Path) {
    block(git_switch(s(dir), "feature".into(), true, None)).unwrap();
    write(dir, "shared.txt", "一行目\nfeature で変えた\n三行目\n");
    commit_all(dir, "feature で 2 行目を変える");
    block(git_switch(s(dir), "main".into(), false, None)).unwrap();
    write(dir, "shared.txt", "一行目\nmain で変えた\n三行目\n");
    commit_all(dir, "main で 2 行目を変える");
}

#[test]
fn merge_conflict_is_reported_and_can_be_aborted_or_resolved() {
    let t = team("merge");
    diverge_on_line_two(&t.a);

    let err = block(git_merge(s(&t.a), "feature".into())).unwrap_err();
    assert!(err.contains("CONFLICT"), "{}", err);
    let st = status(&t.a);
    assert!(st.conflicted);
    assert_eq!(st.operation.as_deref(), Some("merge"));
    let f = st.files.iter().find(|f| f.path == "shared.txt").unwrap();
    assert_eq!((f.staged.as_str(), f.unstaged.as_str()), ("U", "U"));
    assert!(read(&t.a, "shared.txt").contains("<<<<<<< HEAD"));

    // マージは続行ではなくコミットで終わる
    assert!(block(git_continue(s(&t.a), "merge".into())).unwrap_err().contains("コミット"));

    // 中止すると、始める前に戻る
    block(git_abort(s(&t.a), "merge".into())).unwrap();
    let st = status(&t.a);
    assert!(!st.conflicted && st.operation.is_none() && st.files.is_empty());
    assert_eq!(read(&t.a, "shared.txt"), "一行目\nmain で変えた\n三行目\n");

    // もう一度合わせて、直してからコミットする
    assert!(block(git_merge(s(&t.a), "feature".into())).is_err());
    write(&t.a, "shared.txt", "一行目\nmain と feature を合わせた\n三行目\n");
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    assert!(!status(&t.a).conflicted);
    block(git_commit(s(&t.a), vec!["feature を取り込む".into()], false, false)).unwrap();
    let st = status(&t.a);
    assert!(st.operation.is_none() && st.files.is_empty());
    assert_eq!(git(&t.a, &["log", "-1", "--format=%P"]).split_whitespace().count(), 2);
}

#[test]
fn modify_delete_conflict_is_reported() {
    let t = team("modify-delete");
    block(git_switch(s(&t.a), "feature".into(), true, None)).unwrap();
    write(&t.a, "shared.txt", "一行目\nfeature で直した\n三行目\n");
    commit_all(&t.a, "feature で直す");
    block(git_switch(s(&t.a), "main".into(), false, None)).unwrap();
    git(&t.a, &["rm", "-q", "shared.txt"]);
    block(git_commit(s(&t.a), vec!["main で消す".into()], false, false)).unwrap();

    assert!(block(git_merge(s(&t.a), "feature".into())).is_err());
    let st = status(&t.a);
    assert!(st.conflicted);
    assert_eq!(st.operation.as_deref(), Some("merge"));
    assert!(st.files.iter().any(|f| f.path == "shared.txt" && f.staged == "U"));
    // 残すことにして add → コミット
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    block(git_commit(s(&t.a), vec!["直した方を残す".into()], false, false)).unwrap();
    assert!(status(&t.a).operation.is_none());
    assert_eq!(read(&t.a, "shared.txt"), "一行目\nfeature で直した\n三行目\n");
}

#[test]
fn cherry_pick_and_revert_continue_after_conflicts_without_editor() {
    let t = team("pick");
    diverge_on_line_two(&t.a);
    let picked = git(&t.a, &["rev-parse", "feature"]).trim().to_string();

    // 競合したチェリーピックを、直して続行する
    assert!(block(git_cherry_pick(s(&t.a), picked.clone())).is_err());
    assert_eq!(status(&t.a).operation.as_deref(), Some("cherry-pick"));
    write(&t.a, "shared.txt", "一行目\n両方を合わせた\n三行目\n");
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    block(git_continue(s(&t.a), "cherry-pick".into())).unwrap();
    let st = status(&t.a);
    assert!(st.operation.is_none());
    assert_eq!(st.last_subject, "feature で 2 行目を変える");

    // 競合しない打ち消し（エディタを開かずに記録される）
    write(&t.a, "note.txt", "メモ\n");
    commit_all(&t.a, "メモを足す");
    let memo = head(&t.a);
    block(git_revert(s(&t.a), memo)).unwrap();
    assert!(!t.a.join("note.txt").exists());
    assert!(status(&t.a).last_subject.starts_with("Revert"));

    // 競合する打ち消し：古いコミットの行が、あとで変わっている
    let first_change = git(&t.a, &["log", "--format=%H", "-1", "--grep", "main で 2 行目"]).trim().to_string();
    assert!(block(git_revert(s(&t.a), first_change)).is_err());
    assert_eq!(status(&t.a).operation.as_deref(), Some("revert"));
    write(&t.a, "shared.txt", "一行目\n二行目\n三行目\n");
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    block(git_continue(s(&t.a), "revert".into())).unwrap();
    assert!(status(&t.a).operation.is_none());
}

#[test]
fn rebase_with_conflict_can_continue_or_abort() {
    let t = team("rebase");
    diverge_on_line_two(&t.a);
    block(git_switch(s(&t.a), "feature".into(), false, None)).unwrap();

    // 中止
    assert!(block(git_rebase(s(&t.a), "main".into())).is_err());
    assert_eq!(status(&t.a).operation.as_deref(), Some("rebase"));
    block(git_abort(s(&t.a), "rebase".into())).unwrap();
    assert!(status(&t.a).operation.is_none());
    assert_eq!(status(&t.a).branch, "feature");

    // 直して続行
    assert!(block(git_rebase(s(&t.a), "main".into())).is_err());
    write(&t.a, "shared.txt", "一行目\nmain の上で feature を直した\n三行目\n");
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    block(git_continue(s(&t.a), "rebase".into())).unwrap();
    let st = status(&t.a);
    assert!(st.operation.is_none());
    assert_eq!(st.branch, "feature");
    // main の先に付け替わっている（main は feature の祖先）
    assert!(run(&t.a, &["merge-base", "--is-ancestor", "main", "feature"]).is_ok());
}

// ---------------------------------------------------------------- 退避

#[test]
fn stash_push_pop_drop_and_conflict_keeps_the_entry() {
    let t = team("stash");
    write(&t.a, "shared.txt", "一行目\n作業中\n三行目\n");
    write(&t.a, "new.txt", "新しいファイル\n");

    block(git_stash_push(s(&t.a), "ボスの当たり判定、試し中".into())).unwrap();
    assert!(status(&t.a).files.is_empty(), "新しいファイルも退避されていない");
    let list = list_stashes(&t.a).unwrap();
    assert_eq!(list.len(), 1);
    assert!(list[0].message.contains("ボスの当たり判定、試し中"), "{}", list[0].message);
    assert_eq!(list[0].files, Some(2));

    block(git_stash_pop(s(&t.a), 0)).unwrap();
    assert_eq!(read(&t.a, "new.txt"), "新しいファイル\n");
    assert!(list_stashes(&t.a).unwrap().is_empty());

    // 退避している間に同じ行が変わると、取り出しで競合し、退避は残る
    block(git_stash_push(s(&t.a), String::new())).unwrap();
    write(&t.a, "shared.txt", "一行目\n先に記録した\n三行目\n");
    commit_all(&t.a, "2 行目を変える");
    assert!(block(git_stash_pop(s(&t.a), 0)).is_err());
    assert!(status(&t.a).conflicted);
    assert_eq!(list_stashes(&t.a).unwrap().len(), 1);
    write(&t.a, "shared.txt", "一行目\n両方を合わせた\n三行目\n");
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    block(git_stash_drop(s(&t.a), 0)).unwrap();
    assert!(list_stashes(&t.a).unwrap().is_empty());
    assert!(!status(&t.a).conflicted);
}

// ---------------------------------------------------------------- ブランチ・タグ・取り消し

#[test]
fn branch_tag_rename_delete_and_detach() {
    let t = team("branch");
    block(git_tag(s(&t.a), "v1.0".into(), None)).unwrap();
    write(&t.a, "shared.txt", "一行目\n提出のあと\n三行目\n");
    commit_all(&t.a, "提出のあとの変更");

    // タグの時点から枝を作る
    block(git_switch(s(&t.a), "fix/v1.0-crash".into(), true, Some("v1.0".into()))).unwrap();
    assert_eq!(read(&t.a, "shared.txt"), "一行目\n二行目\n三行目\n");
    write(&t.a, "fix.txt", "直した\n");
    commit_all(&t.a, "提出版の不具合を直す");

    // 名前を変える・マージしていない枝は -d では消えない
    block(git_switch(s(&t.a), "main".into(), false, None)).unwrap();
    block(git_rename_branch(s(&t.a), "fix/v1.0-crash".into(), "fix/crash".into())).unwrap();
    assert!(list_branches(&t.a).unwrap().iter().any(|b| b.name == "fix/crash"));
    let err = block(git_delete_branch(s(&t.a), "fix/crash".into(), false)).unwrap_err();
    assert!(err.contains("not fully merged"), "{}", err);
    block(git_delete_branch(s(&t.a), "fix/crash".into(), true)).unwrap();
    assert!(!list_branches(&t.a).unwrap().iter().any(|b| b.name == "fix/crash"));

    // - で始まる名前は、オプションと取り違えるので断る
    assert!(block(git_switch(s(&t.a), "-x".into(), true, None)).is_err());

    // 切り離された HEAD ではプッシュしない
    let first = git(&t.a, &["rev-list", "--max-parents=0", "HEAD"]).trim().to_string();
    block(git_detach(s(&t.a), first)).unwrap();
    assert_eq!(status(&t.a).branch, "");
    assert!(block(git_push(s(&t.a))).unwrap_err().contains("切り離された"));
}

#[test]
fn merge_prefers_the_branch_when_a_tag_has_the_same_name() {
    let t = team("same-name");
    // 同じ名前のタグ（古いコミット）とブランチ（新しいコミット）
    block(git_tag(s(&t.a), "0.2.1".into(), None)).unwrap();
    block(git_switch(s(&t.a), "0.2.1".into(), true, None)).unwrap();
    write(&t.a, "branch.txt", "ブランチの変更\n");
    commit_all(&t.a, "0.2.1 ブランチの変更");
    block(git_switch(s(&t.a), "main".into(), false, None)).unwrap();

    block(git_merge(s(&t.a), "0.2.1".into())).unwrap();
    assert!(t.a.join("branch.txt").exists(), "タグの方が取り込まれた");
}

#[test]
fn reset_modes_and_discard_everything() {
    let t = team("reset");
    let base = head(&t.a);
    write(&t.a, "shared.txt", "一行目\n変えた\n三行目\n");
    commit_all(&t.a, "2 行目を変える");

    block(git_reset(s(&t.a), base.clone(), "soft".into())).unwrap();
    assert_eq!(status(&t.a).files[0].staged, "M");
    commit_all(&t.a, "もう一度記録");
    block(git_reset(s(&t.a), base.clone(), "mixed".into())).unwrap();
    let f = &status(&t.a).files[0];
    assert_eq!((f.staged.as_str(), f.unstaged.as_str()), ("", "M"));
    assert!(block(git_reset(s(&t.a), base.clone(), "keep".into())).is_err());

    // 作業中の変更を、新しいファイルも含めて捨てる
    write(&t.a, "junk/tmp.txt", "消える\n");
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    block(git_discard_all(s(&t.a), true)).unwrap();
    assert!(status(&t.a).files.is_empty());
    assert!(!t.a.join("junk").exists());
    assert_eq!(read(&t.a, "shared.txt"), "一行目\n二行目\n三行目\n");

    // hard はコミットも作業中の変更も戻す
    write(&t.a, "shared.txt", "一行目\nまた変えた\n三行目\n");
    commit_all(&t.a, "また変える");
    write(&t.a, "shared.txt", "一行目\n作業中\n三行目\n");
    block(git_reset(s(&t.a), base.clone(), "hard".into())).unwrap();
    assert_eq!(head(&t.a), base);
    assert!(status(&t.a).files.is_empty());
}

#[test]
fn unstage_works_before_the_first_commit() {
    let sb = Sandbox::new("first");
    let dir = sb.dir("repo");
    init_repo(&dir);
    write(&dir, "README.md", "# ActionGame\n");
    block(git_stage(s(&dir), vec!["README.md".into()])).unwrap();
    assert_eq!(status(&dir).files[0].staged, "A");
    block(git_unstage(s(&dir), vec!["README.md".into()])).unwrap();
    assert_eq!(status(&dir).files[0].unstaged, "?");
    assert_eq!(status(&dir).head, "");
}

// ---------------------------------------------------------------- 共有（プッシュ・フェッチ・上流）

#[test]
fn push_other_branch_set_upstream_and_prune_gone_branches() {
    let t = team("share");
    block(git_switch(s(&t.a), "feature/player-dash".into(), true, None)).unwrap();
    write(&t.a, "dash.txt", "ダッシュ\n");
    commit_all(&t.a, "ダッシュを足す");
    block(git_switch(s(&t.a), "main".into(), false, None)).unwrap();

    // 今いないブランチも送れる（初回は上流が決まる）
    let r = block(git_push_branch(s(&t.a), "feature/player-dash".into())).unwrap();
    assert_eq!(r.command, "git push -u origin feature/player-dash");
    let b = list_branches(&t.a).unwrap();
    let dash = b.iter().find(|b| b.name == "feature/player-dash").unwrap();
    assert_eq!(dash.upstream.as_deref(), Some("origin/feature/player-dash"));

    // B が受け取って、同じ名前の上流を設定する
    block(git_fetch(s(&t.b))).unwrap();
    git(&t.b, &["branch", "-q", "feature/player-dash", "origin/feature/player-dash", "--no-track"]);
    block(git_set_upstream(s(&t.b), "feature/player-dash".into())).unwrap();
    let b = list_branches(&t.b).unwrap();
    assert_eq!(b.iter().find(|b| b.name == "feature/player-dash").unwrap().upstream.as_deref(), Some("origin/feature/player-dash"));

    // GitHub 側で消されたブランチは、フェッチすると「消えた」と分かる
    git(&t.b, &["push", "-q", "origin", "--delete", "feature/player-dash"]);
    block(git_fetch(s(&t.a))).unwrap();
    let b = list_branches(&t.a).unwrap();
    assert!(b.iter().find(|b| b.name == "feature/player-dash").unwrap().gone);
}

// ---------------------------------------------------------------- 閲覧（状態・差分・履歴・フォルダ）

#[test]
fn status_counts_lines_and_follows_renames() {
    let t = team("status");
    write(&t.a, "shared.txt", "一行目\n二行目を変えた\n三行目\n四行目\n");
    write(&t.a, "新しい.txt", "あ\nい\nう\n");
    git(&t.a, &["mv", "shared.txt", "共有.txt"]);
    let st = status(&t.a);
    let renamed = st.files.iter().find(|f| f.path == "共有.txt").unwrap();
    assert_eq!(renamed.orig_path.as_deref(), Some("shared.txt"));
    assert_eq!(renamed.staged, "R");
    let unstaged = renamed.unstaged_lines.unwrap();
    assert_eq!((unstaged.added, unstaged.deleted), (2, 1));
    let new = st.files.iter().find(|f| f.path == "新しい.txt").unwrap();
    assert_eq!(new.unstaged, "?");
    assert_eq!(new.unstaged_lines.unwrap().added, 3);

    // 差分：新しいファイルは中身すべてが「追加」、ステージ済みは --cached
    let d = block(git_diff(s(&t.a), "新しい.txt".into(), false, true)).unwrap();
    assert!(d.output.starts_with("@@ -0,0 +1,3 @@\n+あ"), "{}", d.output);
    let d = block(git_diff(s(&t.a), "共有.txt".into(), true, false)).unwrap();
    assert!(d.command.contains("--cached"));
}

#[test]
fn history_contains_merges_remote_branches_and_tags() {
    let t = team("history");
    diverge_on_line_two(&t.a);
    assert!(block(git_merge(s(&t.a), "feature".into())).is_err());
    write(&t.a, "shared.txt", "一行目\n合わせた\n三行目\n");
    block(git_stage(s(&t.a), vec!["shared.txt".into()])).unwrap();
    block(git_commit(s(&t.a), vec!["feature を取り込む".into()], false, false)).unwrap();
    block(git_tag(s(&t.a), "v1.0".into(), None)).unwrap();

    let h = read_history(&t.a).unwrap();
    assert_eq!(h.head_branch.as_deref(), Some("main"));
    let merge = h.commits.iter().find(|c| c.subject == "feature を取り込む").unwrap();
    assert_eq!(merge.parents.len(), 2);
    assert!(h.refs.iter().any(|r| r.name == "v1.0"), "タグがない");
    assert!(h.refs.iter().any(|r| r.name.ends_with("origin/main")), "リモートのブランチがない: {:?}",
        h.refs.iter().map(|r| &r.name).collect::<Vec<_>>());
    assert!(h.refs.iter().any(|r| r.name == "feature"));
    // 新しい順（マージが先頭）
    assert_eq!(h.commits[0].subject, "feature を取り込む");
}

#[test]
fn folder_check_matches_the_github_project() {
    let t = team("folder");
    git(&t.a, &["remote", "set-url", "origin", "https://github.com/y0zrin/LifeManager.git"]);
    let c = check_folder(&t.a.join("src").parent().unwrap().to_path_buf(), "y0zrin", "LifeManager");
    assert!(c.is_repo && c.matches_project);
    assert!(!check_folder(&t.a, "someone", "LifeManager").matches_project);
    let sb = Sandbox::new("not-repo");
    assert!(!check_folder(&sb.root, "y0zrin", "LifeManager").is_repo);
}

// ---------------------------------------------------------------- クローン（URL）・手元のフォルダを上げる

#[test]
fn publish_a_new_folder_to_an_empty_remote() {
    use super::publish::{folder_state, prepare, push_to, remote_exists};
    let sb = Sandbox::new("publish");
    let remote = sb.dir("remote.git");
    fs::create_dir_all(&remote).unwrap();
    git(&remote, &["init", "-q", "--bare", "-b", "main"]);
    let game = sb.dir("game");
    write(&game, "src/main.cpp", "int main() {}\n");
    write(&game, "ActionGame.sln", "sln\n");
    write(&game, "x64/Debug/ActionGame.exe", "exe\n");
    write(&game, ".vs/cache.bin", "cache\n");

    let st = folder_state(&game).unwrap();
    assert!(!st.is_repo && st.inside.is_none() && st.commits == 0 && !st.has_gitignore);
    assert_eq!(st.files, 4);

    let r = prepare(&game, "visualstudio", "最初のコミット").unwrap();
    assert!(r.command.starts_with("git init -b main"), "{}", r.command);
    assert!(r.command.contains("git commit -m 最初のコミット"), "{}", r.command);
    let st = folder_state(&game).unwrap();
    assert!(st.is_repo && st.has_gitignore);
    assert_eq!((st.commits, st.branch.as_str()), (1, "main"));
    let tracked = git(&game, &["ls-files"]);
    assert!(tracked.contains("src/main.cpp") && tracked.contains(".gitignore"));
    assert!(!tracked.contains("x64/") && !tracked.contains(".vs/"), "{}", tracked);

    // もう一度実行しても、何も増えない
    prepare(&game, "visualstudio", "最初のコミット").unwrap();
    assert_eq!(folder_state(&game).unwrap().commits, 1);

    assert!(remote_exists(&s(&remote)).unwrap());
    assert!(!remote_exists(&s(&sb.dir("nothing.git"))).unwrap());

    let r = push_to(&game, &s(&remote)).unwrap();
    assert!(r.command.contains("git remote add origin") && r.command.contains("git push -u origin main"), "{}", r.command);
    let st = status(&game);
    assert_eq!(st.upstream.as_deref(), Some("origin/main"));
    assert_eq!(git(&remote, &["rev-list", "--count", "main"]).trim(), "1");
}

#[test]
fn prepare_leaves_a_repository_that_already_has_commits() {
    use super::publish::{folder_state, prepare};
    let t = team("existing");
    let before = folder_state(&t.a).unwrap();
    assert!(before.is_repo && before.commits > 0 && !before.has_gitignore);
    // もう記録があるなら、.gitignore も足さず、何もしない
    let r = prepare(&t.a, "visualstudio", "x").unwrap();
    assert_eq!(r.command, "");
    assert!(!t.a.join(".gitignore").exists());
    assert_eq!(folder_state(&t.a).unwrap().commits, before.commits);
}

#[test]
fn prepare_refuses_a_folder_inside_another_repository() {
    let t = team("inside");
    write(&t.a, "sub/new.txt", "中\n");
    let err = super::publish::prepare(&t.a.join("sub"), "none", "x").unwrap_err();
    assert!(err.contains("ほかのリポジトリ"), "{}", err);
}

#[test]
fn clone_url_makes_a_folder_named_after_the_repository() {
    let t = team("clone-url");
    let remote = t.a.parent().unwrap().join("remote.git");
    let parent = t.a.parent().unwrap().join("clones");
    fs::create_dir_all(&parent).unwrap();
    let r = super::publish::clone_url(&parent, &s(&remote)).unwrap();
    assert!(r.path.ends_with("remote"), "{}", r.path);
    assert_eq!(read(Path::new(&r.path), "shared.txt"), "一行目\n二行目\n三行目\n");
    assert_eq!((r.owner, r.repo), (None, None));
    // 同じ場所には二度作らない
    assert!(super::publish::clone_url(&parent, &s(&remote)).unwrap_err().contains("すでにあります"));
}

// --- 無視するファイル（.gitignore） ---

/// 最初のコミットがあるリポジトリ（1 人分）
fn solo(name: &str) -> (Sandbox, PathBuf) {
    let sb = Sandbox::new(name);
    let dir = sb.dir("repo");
    init_repo(&dir);
    write(&dir, "README.md", "はじめに\n");
    commit_all(&dir, "最初のコミット");
    (sb, dir)
}

fn paths(dir: &Path) -> Vec<String> {
    status(dir).files.into_iter().map(|f| f.path).collect()
}

#[test]
fn ignore_adds_the_line_once_and_hides_new_files() {
    let (_sb, dir) = solo("ignore-add");
    write(&dir, "logs/debug.log", "ログ\n");
    write(&dir, "logs/keep.txt", "残す\n");
    assert!(paths(&dir).contains(&"logs/debug.log".to_string()));

    // まだ管理していないので、書き足すだけでよい（作業フォルダの中のフォルダから呼んでも、いちばん上の .gitignore に書く）
    assert!(block(git_ignore_tracked(s(&dir.join("logs")), "*.log".into())).unwrap().is_empty());
    let r = block(git_ignore_add(s(&dir.join("logs")), "*.log".into(), None, false)).unwrap();
    assert_eq!(r.command, "");
    assert!(r.output.contains("書き足しました"), "{}", r.output);
    assert_eq!(read(&dir, ".gitignore"), "*.log\n");
    let now = paths(&dir);
    assert!(!now.contains(&"logs/debug.log".to_string()), "{:?}", now);
    assert!(now.contains(&"logs/keep.txt".to_string()) && now.contains(&".gitignore".to_string()), "{:?}", now);

    // 同じ行は二度書かない
    let again = block(git_ignore_add(s(&dir), "*.log".into(), None, false)).unwrap();
    assert!(again.output.contains("もう"), "{}", again.output);
    assert_eq!(read(&dir, ".gitignore"), "*.log\n");
}

#[test]
fn ignore_keeps_the_newline_style_of_the_file() {
    let (_sb, dir) = solo("ignore-crlf");
    // 最後の行に改行がない、CRLF の .gitignore
    write(&dir, ".gitignore", "a\r\nb");
    block(git_ignore_add(s(&dir), "/c".into(), None, false)).unwrap();
    assert_eq!(read(&dir, ".gitignore"), "a\r\nb\r\n/c\r\n");
    // 改行を含むパターンは受け付けない
    assert!(block(git_ignore_add(s(&dir), "x\ny".into(), None, false)).is_err());
}

#[test]
fn ignoring_a_tracked_folder_untracks_only_that_folder() {
    let (_sb, dir) = solo("ignore-tracked");
    write(&dir, "build/a.txt", "a\n");
    write(&dir, "build/sub/b.txt", "b\n");
    write(&dir, "app/build/c.txt", "c\n");
    commit_all(&dir, "ビルドの結果までコミットしてしまった");

    // 頭に / を付けたパターンは、いちばん上の build だけに当てはまる（git rm -r --cached -- build/ と同じ範囲）
    let tracked = block(git_ignore_tracked(s(&dir), "/build/".into())).unwrap();
    assert_eq!(tracked, vec!["build/a.txt".to_string(), "build/sub/b.txt".to_string()]);

    let r = block(git_ignore_add(s(&dir), "/build/".into(), Some("build/".into()), true)).unwrap();
    assert_eq!(r.command, "git rm -r --cached -- build/");
    assert!(r.output.contains("管理から外した"), "{}", r.output);
    // ファイルは残り、記録からは「削除」としてステージされる。無視されるので、新しいファイルとしては出ない
    assert_eq!(read(&dir, "build/a.txt"), "a\n");
    let st = status(&dir);
    let removed: Vec<_> = st.files.iter().filter(|f| f.staged == "D").map(|f| f.path.as_str()).collect();
    assert_eq!(removed, vec!["build/a.txt", "build/sub/b.txt"]);
    assert!(st.files.iter().all(|f| f.unstaged != "?" || f.path == ".gitignore"), "{:?}", paths(&dir));
    assert!(block(git_ignore_tracked(s(&dir), "/build/".into())).unwrap().is_empty());
    // app/build はそのまま管理されている
    assert!(git(&dir, &["ls-files", "app/build"]).contains("app/build/c.txt"));
}

#[test]
fn untracking_a_single_file_does_not_need_recursive() {
    let (_sb, dir) = solo("ignore-file");
    write(&dir, ".env", "SECRET=1\n");
    commit_all(&dir, "うっかり .env をコミット");
    let r = block(git_ignore_add(s(&dir), "/.env".into(), Some(".env".into()), false)).unwrap();
    assert_eq!(r.command, "git rm --cached -- .env");
    assert_eq!(read(&dir, ".gitignore"), "/.env\n");
    let st = status(&dir);
    assert!(st.files.iter().any(|f| f.path == ".env" && f.staged == "D"));
    assert!(!st.files.iter().any(|f| f.path == ".env" && f.unstaged == "?"));
}

#[test]
fn gitignore_can_be_read_and_saved() {
    let (_sb, dir) = solo("gitignore-edit");
    let before = block(git_gitignore_read(s(&dir))).unwrap();
    assert!(!before.exists && before.text.is_empty());

    // 最後に改行がなくても足して保存する
    block(git_gitignore_write(s(&dir), "*.log\n/build/".into())).unwrap();
    assert_eq!(read(&dir, ".gitignore"), "*.log\n/build/\n");
    let after = block(git_gitignore_read(s(&dir))).unwrap();
    assert!(after.exists);
    assert_eq!(after.text, "*.log\n/build/\n");

    // もとが CRLF なら CRLF のまま保存する（画面には LF にそろえて渡す）
    write(&dir, ".gitignore", "a\r\n");
    assert_eq!(block(git_gitignore_read(s(&dir))).unwrap().text, "a\n");
    block(git_gitignore_write(s(&dir), "a\nb\n".into())).unwrap();
    assert_eq!(read(&dir, ".gitignore"), "a\r\nb\r\n");
}
