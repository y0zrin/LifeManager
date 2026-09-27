//! コミットの履歴（ブランチ画面・全体図で使う）。PC ではこの PC の git から、スマホ版などでは GitHub API から作る
use super::runner::run;
use serde::Serialize;
use std::collections::{BinaryHeap, HashMap};
use std::path::Path;

/// コミット 1 件
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct CommitInfo {
    pub hash: String,
    pub parents: Vec<String>,
    pub author: String,
    /// 作った日時（ISO 8601）
    pub date: String,
    pub subject: String,
}

/// ブランチやタグが指しているコミット
#[derive(Debug, Serialize, Clone, PartialEq)]
pub struct RefTip {
    /// "branch"（ブランチ）/ "remote"（origin/… など、GitHub にあるブランチの控え）/ "tag"
    pub kind: String,
    pub name: String,
    pub hash: String,
}

#[derive(Debug, Serialize)]
pub struct History {
    /// 新しい順。子のコミットは必ず親より前に来る
    pub commits: Vec<CommitInfo>,
    pub refs: Vec<RefTip>,
    /// チェックアウト中のブランチ（この PC の git のときだけ。切り離し中は None）
    pub head_branch: Option<String>,
    /// HEAD のコミット（この PC の git のときだけ）
    pub head: Option<String>,
    pub default_branch: Option<String>,
    /// 件数の上限で打ち切った
    pub truncated: bool,
    /// "local"（この PC の git）/ "github"（GitHub API）
    pub source: String,
}

pub const MAX_COMMITS: usize = 1000;

/// この PC の git から履歴を読む（ブランチ・GitHub の控え・タグから辿れるコミット）
pub fn read_history(repo: &Path) -> Result<History, String> {
    let head = run(repo, &["rev-parse", "--verify", "-q", "HEAD"]).ok().map(|r| r.output.trim().to_string());
    let head_branch = run(repo, &["symbolic-ref", "--short", "-q", "HEAD"]).ok().map(|r| r.output.trim().to_string());

    let mut commits = Vec::new();
    let mut truncated = false;
    // まだ 1 つもコミットがないときは、履歴は空
    if head.is_some() {
        let limit = format!("--max-count={}", MAX_COMMITS + 1);
        let out = run(
            repo,
            &["log", "--date-order", &limit, "--format=%H%x1f%P%x1f%an%x1f%aI%x1f%s", "--branches", "--remotes", "--tags", "HEAD"],
        )?
        .output;
        commits = parse_log(&out);
        truncated = commits.len() > MAX_COMMITS;
        commits.truncate(MAX_COMMITS);
    }

    let out = run(
        repo,
        &["for-each-ref", "--format=%(refname)%1f%(objectname)%1f%(*objectname)", "refs/heads", "refs/remotes", "refs/tags"],
    )?
    .output;
    let refs = parse_refs(&out);

    let default_branch = run(repo, &["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])
        .ok()
        .map(|r| r.output.trim().trim_start_matches("origin/").to_string())
        .filter(|b| !b.is_empty())
        .or_else(|| guess_default_branch(&refs));

    Ok(History { commits, refs, head_branch, head, default_branch, truncated, source: "local".into() })
}

fn parse_log(out: &str) -> Vec<CommitInfo> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(5, '\u{1f}').collect();
            if f.len() != 5 {
                return None;
            }
            Some(CommitInfo {
                hash: f[0].to_string(),
                parents: f[1].split_whitespace().map(|p| p.to_string()).collect(),
                author: f[2].to_string(),
                date: f[3].to_string(),
                subject: f[4].to_string(),
            })
        })
        .collect()
}

fn parse_refs(out: &str) -> Vec<RefTip> {
    out.lines()
        .filter_map(|line| {
            let f: Vec<&str> = line.splitn(3, '\u{1f}').collect();
            if f.len() != 3 {
                return None;
            }
            let (kind, name, hash) = if let Some(n) = f[0].strip_prefix("refs/heads/") {
                ("branch", n, f[1])
            } else if let Some(n) = f[0].strip_prefix("refs/remotes/") {
                // origin/HEAD は「既定のブランチ」を指す印なので、ブランチとしては出さない
                if n.ends_with("/HEAD") {
                    return None;
                }
                ("remote", n, f[1])
            } else if let Some(n) = f[0].strip_prefix("refs/tags/") {
                // 注釈付きのタグは、タグそのものではなく、指しているコミットを使う
                ("tag", n, if f[2].is_empty() { f[1] } else { f[2] })
            } else {
                return None;
            };
            Some(RefTip { kind: kind.into(), name: name.into(), hash: hash.into() })
        })
        .collect()
}

/// origin/HEAD が分からないときは、main か master があればそれを既定とみなす
pub fn guess_default_branch(refs: &[RefTip]) -> Option<String> {
    ["main", "master"]
        .iter()
        .find(|name| refs.iter().any(|r| r.kind != "tag" && (r.name == **name || r.name == format!("origin/{}", name))))
        .map(|name| name.to_string())
}

/// git log --date-order と同じ並べ方: 新しい順だが、子のコミットは必ず親より前に置く。
/// sort_key は並べるときの日時（ISO 8601 の文字列。コミットした日時を渡す）
pub fn date_order(commits: Vec<CommitInfo>, sort_key: &HashMap<String, String>) -> Vec<CommitInfo> {
    let index: HashMap<&str, usize> = commits.iter().enumerate().map(|(i, c)| (c.hash.as_str(), i)).collect();
    // 読み込んだ中にいる子の数
    let mut children = vec![0usize; commits.len()];
    for c in &commits {
        for p in &c.parents {
            if let Some(&i) = index.get(p.as_str()) {
                children[i] += 1;
            }
        }
    }
    let key = |i: usize| sort_key.get(&commits[i].hash).cloned().unwrap_or_else(|| commits[i].date.clone());
    let mut ready: BinaryHeap<(String, usize)> =
        (0..commits.len()).filter(|&i| children[i] == 0).map(|i| (key(i), i)).collect();
    let mut order = Vec::with_capacity(commits.len());
    while let Some((_, i)) = ready.pop() {
        order.push(i);
        for p in &commits[i].parents {
            if let Some(&j) = index.get(p.as_str()) {
                children[j] -= 1;
                if children[j] == 0 {
                    ready.push((key(j), j));
                }
            }
        }
    }
    let mut slots: Vec<Option<CommitInfo>> = commits.into_iter().map(Some).collect();
    order.into_iter().filter_map(|i| slots[i].take()).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn commit(hash: &str, parents: &[&str], date: &str) -> CommitInfo {
        CommitInfo {
            hash: hash.into(),
            parents: parents.iter().map(|p| p.to_string()).collect(),
            author: "y0zrin".into(),
            date: date.into(),
            subject: hash.into(),
        }
    }

    #[test]
    fn parses_log_and_refs() {
        let log = "aaa\u{1f}bbb ccc\u{1f}y0zrin\u{1f}2026-09-27T15:48:34+09:00\u{1f}Merge branch 'feature'\n\
bbb\u{1f}\u{1f}y0zrin\u{1f}2026-03-16T12:02:55+09:00\u{1f}Initial commit\n";
        let c = parse_log(log);
        assert_eq!(c.len(), 2);
        assert_eq!(c[0].parents, vec!["bbb", "ccc"]);
        assert!(c[1].parents.is_empty());

        let refs = parse_refs(
            "refs/heads/feature\u{1f}aaa\u{1f}\n\
refs/remotes/origin/HEAD\u{1f}bbb\u{1f}\n\
refs/remotes/origin/main\u{1f}bbb\u{1f}\n\
refs/tags/0.3.3\u{1f}ttt\u{1f}aaa\n\
refs/tags/0.2.0\u{1f}bbb\u{1f}\n",
        );
        let got: Vec<(&str, &str, &str)> = refs.iter().map(|r| (r.kind.as_str(), r.name.as_str(), r.hash.as_str())).collect();
        assert_eq!(
            got,
            vec![("branch", "feature", "aaa"), ("remote", "origin/main", "bbb"), ("tag", "0.3.3", "aaa"), ("tag", "0.2.0", "bbb")]
        );
        assert_eq!(guess_default_branch(&refs).as_deref(), Some("main"));
    }

    #[test]
    fn keeps_children_before_parents_even_if_dates_are_skewed() {
        // c2 の日時が親の c1 より古い（時計のずれ）。それでも c2 は c1 より前に来る
        let commits = vec![
            commit("c1", &["c0"], "2026-01-02T00:00:00Z"),
            commit("c0", &[], "2026-01-01T00:00:00Z"),
            commit("c2", &["c1"], "2025-12-31T00:00:00Z"),
            commit("x", &["c0"], "2026-01-03T00:00:00Z"),
        ];
        let order: Vec<String> = date_order(commits, &HashMap::new()).into_iter().map(|c| c.hash).collect();
        assert_eq!(order, vec!["x", "c2", "c1", "c0"]);
    }
}
