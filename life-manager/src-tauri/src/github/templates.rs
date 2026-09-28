//! Issue テンプレート。GitHub と同じく、リポジトリの .github/ISSUE_TEMPLATE/*.md を使う
//! （先頭の --- で囲んだところに名前・説明・題名の頭・ラベルを書き、そのあとが本文）
use super::client::GitHubClient;
use serde::{Deserialize, Serialize};

pub const DIR: &str = ".github/ISSUE_TEMPLATE";

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct IssueTemplate {
    /// ファイルの名前（bug.md など）
    pub file: String,
    pub name: String,
    #[serde(default)]
    pub about: String,
    /// 題名の頭（"[バグ] " など）
    #[serde(default)]
    pub title: String,
    #[serde(default)]
    pub labels: Vec<String>,
    #[serde(default)]
    pub body: String,
}

/// 値のまわりの引用符を外す
fn unquote(value: &str) -> String {
    let v = value.trim();
    for q in ['"', '\''] {
        if v.len() >= 2 && v.starts_with(q) && v.ends_with(q) {
            return v[1..v.len() - 1].to_string();
        }
    }
    v.to_string()
}

/// "a, b" や ["a", "b"] を並びにする
fn split_list(value: &str) -> Vec<String> {
    let v = value.trim().trim_start_matches('[').trim_end_matches(']');
    v.split(',').map(unquote).filter(|s| !s.is_empty()).collect()
}

/// テンプレートのファイルを読む。先頭の --- がなければテンプレートではない（None）
pub fn parse(file: &str, text: &str) -> Option<IssueTemplate> {
    let text = text.replace("\r\n", "\n");
    let rest = text.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    let head = &rest[..end];
    let body = rest[end + 4..].trim_start_matches('\n').to_string();
    let mut t = IssueTemplate {
        file: file.to_string(),
        name: file.trim_end_matches(".md").to_string(),
        about: String::new(),
        title: String::new(),
        labels: Vec::new(),
        body,
    };
    // labels は「- 種別:バグ」の並びで書くこともある
    let mut labels_list = false;
    for line in head.lines() {
        if labels_list {
            if let Some(item) = line.trim().strip_prefix("- ") {
                let item = unquote(item);
                if !item.is_empty() {
                    t.labels.push(item);
                }
                continue;
            }
            labels_list = false;
        }
        let Some((key, value)) = line.split_once(':') else { continue };
        match key.trim() {
            "name" => t.name = unquote(value),
            "about" => t.about = unquote(value),
            "title" => t.title = unquote(value),
            "labels" => {
                if value.trim().is_empty() {
                    labels_list = true;
                } else {
                    t.labels = split_list(value);
                }
            }
            _ => {}
        }
    }
    Some(t)
}

/// 文字列を YAML の "…" にする
fn quoted(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// テンプレートのファイルの中身（GitHub の「New issue」でも読める形）
pub fn to_markdown(t: &IssueTemplate) -> String {
    let labels = t.labels.iter().map(|l| quoted(l)).collect::<Vec<_>>().join(", ");
    format!(
        "---\nname: {}\nabout: {}\ntitle: {}\nlabels: [{}]\nassignees: ''\n---\n{}",
        quoted(&t.name),
        quoted(&t.about),
        quoted(&t.title),
        labels,
        t.body
    )
}

/// リポジトリのテンプレート（.md だけ。GitHub の入力フォーム形式 .yml と config.yml は使わない）
pub async fn list(client: &GitHubClient, owner: &str, repo: &str) -> Result<Vec<IssueTemplate>, String> {
    let names = client.list_directory(owner, repo, DIR).await?;
    let mut templates = Vec::new();
    for name in names.iter().filter(|n| n.ends_with(".md")) {
        let text = client.read_text(owner, repo, &format!("{}/{}", DIR, name)).await?;
        if let Some(t) = parse(name, &text) {
            templates.push(t);
        }
    }
    Ok(templates)
}

/// テンプレートを置く（すべてを 1 つのコミットにして、既定のブランチに足す）
pub async fn add(client: &GitHubClient, owner: &str, repo: &str, templates: &[IssueTemplate], message: &str) -> Result<String, String> {
    let files: Vec<(String, String)> = templates.iter().map(|t| (format!("{}/{}", DIR, t.file), to_markdown(t))).collect();
    client.commit_files(owner, repo, &files, message).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_what_it_writes() {
        let t = IssueTemplate {
            file: "bug.md".into(),
            name: "🐞 バグ報告".into(),
            about: "動かない・おかしいところを知らせる".into(),
            title: "[バグ] ".into(),
            labels: vec!["種別:バグ".into(), "状態:未整理".into()],
            body: "## 何が起きたか\n\n## 手順\n1. \n".into(),
        };
        assert_eq!(parse("bug.md", &to_markdown(&t)), Some(t));
    }

    #[test]
    fn reads_templates_written_on_github() {
        let text = "---\r\nname: Bug report\r\nabout: Create a report\r\ntitle: ''\r\nlabels: bug, 種別:バグ\r\nassignees: ''\r\n\r\n---\r\n\r\n**Describe the bug**\r\n";
        let t = parse("bug_report.md", text).unwrap();
        assert_eq!((t.name.as_str(), t.title.as_str()), ("Bug report", ""));
        assert_eq!(t.labels, vec!["bug".to_string(), "種別:バグ".to_string()]);
        assert_eq!(t.body, "**Describe the bug**\n");
        // ラベルを並びで書いたもの
        let list = parse("x.md", "---\nname: X\nlabels:\n  - \"種別:イシュー\"\n  - 状態:未整理\n---\n本文").unwrap();
        assert_eq!(list.labels, vec!["種別:イシュー".to_string(), "状態:未整理".to_string()]);
        // 先頭の --- がなければテンプレートではない
        assert_eq!(parse("README.md", "# テンプレートの説明"), None);
    }
}
