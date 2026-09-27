//! 書いた直後の読み直しを正しくする。
//! GitHub の Contents API は、ファイルを書き換えた直後のしばらく、書き換える前の内容（と sha）を返すことがある。
//! そのまま使うと、消したルーチンが画面に戻ってきたり、古い sha で書こうとして 409・422 で断られたりする（#64）。
//! そこで、自分が書いた内容を少しのあいだ覚えておき、書く前の版が返ってきたら、覚えている新しい版に置き換える。
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

/// 覚えておく長さ（GitHub が追いつくのは、ふつう数秒から 1 分ほど）
const WINDOW: Duration = Duration::from_secs(180);

#[derive(Debug, Clone)]
struct RecentWrite {
    /// いま GitHub にあるはずの版
    sha: String,
    content: String,
    /// これまでに置き換えた古い版（これが返ってきたら、まだ追いついていない）
    superseded: Vec<String>,
    /// 自分がファイルを作った（「ない」と返ってきたら、まだ追いついていない）
    created: bool,
    at: Instant,
}

type Map = HashMap<String, RecentWrite>;

fn map() -> &'static Mutex<Map> {
    static MAP: OnceLock<Mutex<Map>> = OnceLock::new();
    MAP.get_or_init(|| Mutex::new(HashMap::new()))
}

fn key(owner: &str, repo: &str, path: &str) -> String {
    format!("{}/{}/{}", owner.to_lowercase(), repo.to_lowercase(), path)
}

/// ファイルを書いたことを覚える。replaced は書く前の版（新しく作ったときは None）
pub fn remember(owner: &str, repo: &str, path: &str, replaced: Option<&str>, sha: &str, content: &str) {
    let mut m = map().lock().unwrap_or_else(|e| e.into_inner());
    record(&mut m, key(owner, repo, path), replaced, sha, content, Instant::now());
}

/// 読んだ結果を、覚えている書き込みと比べて直す
pub fn correct(owner: &str, repo: &str, path: &str, fetched: Result<(String, String), String>) -> Result<(String, String), String> {
    let mut m = map().lock().unwrap_or_else(|e| e.into_inner());
    apply(&mut m, &key(owner, repo, path), fetched, Instant::now())
}

fn record(m: &mut Map, key: String, replaced: Option<&str>, sha: &str, content: &str, now: Instant) {
    let previous = m.remove(&key).filter(|w| now.duration_since(w.at) < WINDOW);
    let mut superseded = Vec::new();
    let mut created = replaced.is_none();
    if let Some(p) = previous {
        superseded = p.superseded;
        superseded.push(p.sha);
        created |= p.created;
    }
    if let Some(r) = replaced {
        if !superseded.iter().any(|s| s == r) {
            superseded.push(r.to_string());
        }
    }
    m.insert(key, RecentWrite { sha: sha.to_string(), content: content.to_string(), superseded, created, at: now });
}

fn apply(m: &mut Map, key: &str, fetched: Result<(String, String), String>, now: Instant) -> Result<(String, String), String> {
    m.retain(|_, w| now.duration_since(w.at) < WINDOW);
    let Some(w) = m.get(key) else { return fetched };
    match &fetched {
        // GitHub が追いついた
        Ok((_, sha)) if *sha == w.sha => {
            m.remove(key);
            fetched
        }
        // 書く前の版が返ってきた：自分が書いた版を使う
        Ok((_, sha)) if w.superseded.iter().any(|s| s == sha) => Ok((w.content.clone(), w.sha.clone())),
        // 作った直後に「ない」と返ってきた
        Err(e) if w.created && e.starts_with("HTTP 404") => Ok((w.content.clone(), w.sha.clone())),
        // 通信できないなどは、そのまま返す（覚えたものは残す）
        Err(_) => fetched,
        // 自分のあとに、ほかの人（ほかの端末）が書いた
        Ok(_) => {
            m.remove(key);
            fetched
        }
    }
}

/// 読んでから書くまでのあいだに GitHub の版がずれて断られた（読み直せば書ける）
pub fn is_stale_write(error: &str) -> bool {
    error.starts_with("HTTP 409") || (error.starts_with("HTTP 422") && error.contains("sha"))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ok(content: &str, sha: &str) -> Result<(String, String), String> {
        Ok((content.to_string(), sha.to_string()))
    }

    #[test]
    fn stale_read_after_write_returns_what_we_wrote() {
        let mut m = Map::new();
        let t = Instant::now();
        record(&mut m, "k".into(), Some("s1"), "s2", "新しい", t);
        // GitHub がまだ古い版（s1）を返す
        assert_eq!(apply(&mut m, "k", ok("古い", "s1"), t), ok("新しい", "s2"));
        // 追いついたら、それを使い、覚えたものは消す
        assert_eq!(apply(&mut m, "k", ok("新しい", "s2"), t), ok("新しい", "s2"));
        assert!(m.is_empty());
    }

    #[test]
    fn consecutive_writes_treat_every_older_version_as_stale() {
        let mut m = Map::new();
        let t = Instant::now();
        record(&mut m, "k".into(), Some("s1"), "s2", "二回目", t);
        record(&mut m, "k".into(), Some("s2"), "s3", "三回目", t);
        assert_eq!(apply(&mut m, "k", ok("最初", "s1"), t), ok("三回目", "s3"));
        assert_eq!(apply(&mut m, "k", ok("二回目", "s2"), t), ok("三回目", "s3"));
    }

    #[test]
    fn a_newly_created_file_is_not_reported_missing() {
        let mut m = Map::new();
        let t = Instant::now();
        record(&mut m, "k".into(), None, "s1", "作った", t);
        assert_eq!(apply(&mut m, "k", Err("HTTP 404 Not Found: {}".into()), t), ok("作った", "s1"));
        // 通信できないときはそのまま
        assert!(apply(&mut m, "k", Err("通信できませんでした: x".into()), t).is_err());
        assert!(m.contains_key("k"));
    }

    #[test]
    fn someone_elses_newer_version_wins_and_old_entries_expire() {
        let mut m = Map::new();
        let t = Instant::now();
        record(&mut m, "k".into(), Some("s1"), "s2", "自分", t);
        assert_eq!(apply(&mut m, "k", ok("ほかの端末", "s9"), t), ok("ほかの端末", "s9"));
        assert!(m.is_empty());

        record(&mut m, "k".into(), Some("s1"), "s2", "自分", t);
        let later = t + WINDOW + Duration::from_secs(1);
        assert_eq!(apply(&mut m, "k", ok("古い", "s1"), later), ok("古い", "s1"));
    }

    #[test]
    fn recognizes_writes_rejected_for_a_stale_sha() {
        assert!(is_stale_write("HTTP 409 Conflict: {\"message\":\"config/routines.yaml does not match abc\"}"));
        assert!(is_stale_write("HTTP 422 Unprocessable Entity: {\"message\":\"Invalid request.\\n\\n\\\"sha\\\" wasn't supplied.\"}"));
        assert!(!is_stale_write("HTTP 422 Unprocessable Entity: {\"message\":\"Validation Failed\"}"));
        assert!(!is_stale_write("HTTP 404 Not Found"));
    }
}
