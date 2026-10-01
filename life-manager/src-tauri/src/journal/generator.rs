use crate::github::client::{is_network_error, GitHubClient};

// 日次ジャーナルを生成してGitHubにアップロードする

/// 日本語の曜日文字列を返す
fn weekday_jp(date: &chrono::NaiveDate) -> &'static str {
    use chrono::Datelike;
    match date.weekday() {
        chrono::Weekday::Mon => "月",
        chrono::Weekday::Tue => "火",
        chrono::Weekday::Wed => "水",
        chrono::Weekday::Thu => "木",
        chrono::Weekday::Fri => "金",
        chrono::Weekday::Sat => "土",
        chrono::Weekday::Sun => "日",
    }
}

/// 指定日のジャーナルMarkdownを生成しGitHubにアップロードする
pub async fn generate_journal(
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    date: &str,
) -> Result<String, String> {
    let parsed_date = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d")
        .map_err(|e| format!("日付パースエラー: {}", e))?;

    // since: 対象日の開始時刻（UTC）。GitHub APIのsinceパラメータで取得範囲を限定
    let since = format!("{}T00:00:00Z", date);

    // その日にクローズされたIssueを取得（since以降に更新されたclosedのみ）
    let closed_json = client.list_issues_since(owner, repo, "closed", &since).await?;
    let closed_issues: Vec<serde_json::Value> =
        serde_json::from_str(&closed_json).map_err(|e| format!("JSONパースエラー: {}", e))?;

    // closed_atがその日のIssueをフィルタ
    let completed: Vec<&serde_json::Value> = closed_issues
        .iter()
        .filter(|issue| {
            if let Some(closed_at) = issue["closed_at"].as_str() {
                return closed_at.starts_with(date);
            }
            return false;
        })
        .collect();

    // その日に作成されたメモを取得（since以降に更新されたIssueから種別:メモラベル付きで日付フィルタ）
    let all_json = client.list_issues_since(owner, repo, "all", &since).await?;
    let all_issues: Vec<serde_json::Value> =
        serde_json::from_str(&all_json).map_err(|e| format!("JSONパースエラー: {}", e))?;

    let memos: Vec<&serde_json::Value> = all_issues
        .iter()
        .filter(|issue| {
            // created_atがその日であること
            let created_today = issue["created_at"]
                .as_str()
                .map(|s| s.starts_with(date))
                .unwrap_or(false);
            if !created_today {
                return false;
            }
            // 種別:メモ ラベルが付いていること
            let has_memo_label = issue["labels"]
                .as_array()
                .map(|labels| {
                    labels
                        .iter()
                        .any(|l| l["name"].as_str() == Some("種別:メモ"))
                })
                .unwrap_or(false);
            return has_memo_label;
        })
        .collect();

    // 統計情報: その日に作成された全Issue数
    let created_today_count = all_issues
        .iter()
        .filter(|issue| {
            issue["created_at"]
                .as_str()
                .map(|s| s.starts_with(date))
                .unwrap_or(false)
        })
        .count();

    // 進行中のIssue数（状態:進行中ラベル付きでopenのもの）
    // ※進行中カウントは現在の状態なのでsinceフィルタ不要だが、全件取得を避けるため
    //   ラベルフィルタで取得量を削減
    let in_progress_json = client.list_issues_by_label(owner, repo, "open", "状態:進行中").await?;
    let in_progress_issues: Vec<serde_json::Value> =
        serde_json::from_str(&in_progress_json).map_err(|e| format!("JSONパースエラー: {}", e))?;
    let in_progress_count = in_progress_issues.len();

    // Markdown生成
    let weekday = weekday_jp(&parsed_date);
    let mut md = format!("# {} ({})\n\n", date, weekday);

    // 既存ジャーナルの「## ノート」セクションを保持（完了の上に配置）。上書きに使う sha もここで取る。
    // 「ない」以外の理由で読めないときは書かずに止める（ノートを消したり、sha なしで書いて 422 になったりしないように）
    let path = format!("journal/{}.md", date);
    let existing = match client.get_contents(owner, repo, &path).await {
        Ok((content, sha)) => Some((content, sha)),
        Err(e) if e.starts_with("HTTP 404") => None,
        Err(e) => return Err(e),
    };
    let existing_notes = existing.as_ref().and_then(|(content, _)| extract_notes_section(content));
    if let Some(notes) = &existing_notes {
        md.push_str("## ノート\n");
        md.push_str(notes);
        if !notes.ends_with('\n') {
            md.push('\n');
        }
        md.push('\n');
    }

    // 完了セクション
    md.push_str("## 完了\n");
    if completed.is_empty() {
        md.push_str("- なし\n");
    } else {
        for issue in &completed {
            let number = issue["number"].as_u64().unwrap_or(0);
            let title = issue["title"].as_str().unwrap_or("");
            // セクションのラベル（前の「分野:」も）を添える
            let area = issue["labels"]
                .as_array()
                .and_then(|labels| {
                    labels.iter().find_map(|l| {
                        let name = l["name"].as_str().unwrap_or("");
                        if name.starts_with("セクション:") || name.starts_with("分野:") {
                            return Some(name.to_string());
                        }
                        return None;
                    })
                })
                .unwrap_or_default();
            if area.is_empty() {
                md.push_str(&format!("- [#{}] {}\n", number, title));
            } else {
                md.push_str(&format!("- [#{}] {} ({})\n", number, title, area));
            }
        }
    }

    // メモセクション
    md.push_str("\n## メモ\n");
    if memos.is_empty() {
        md.push_str("- なし\n");
    } else {
        for issue in &memos {
            let number = issue["number"].as_u64().unwrap_or(0);
            let title = issue["title"].as_str().unwrap_or("");
            md.push_str(&format!("- [#{}] {}\n", number, title));
        }
    }

    // 統計セクション
    md.push_str("\n## 統計\n");
    md.push_str(&format!("- 完了: {}\n", completed.len()));
    md.push_str(&format!("- 作成: {}\n", created_today_count));
    md.push_str(&format!("- 進行中: {}\n", in_progress_count));

    // GitHub Contents APIでアップロード
    let commit_message = format!("{}の日次ログを生成", date);

    let sha = existing.map(|(_, sha)| sha);
    client
        .put_contents(owner, repo, &path, &md, &commit_message, sha)
        .await?;

    return Ok(md);
}

/// Markdownから「## ノート」セクションの本文を抽出する
fn extract_notes_section(md: &str) -> Option<String> {
    let marker = "## ノート\n";
    if let Some(start) = md.find(marker) {
        let body_start = start + marker.len();
        // 次の「## 」見出しまで、またはファイル末尾まで
        let rest = &md[body_start..];
        let end = rest.find("\n## ").map(|i| i).unwrap_or(rest.len());
        let notes = rest[..end].trim_end();
        if notes.is_empty() {
            return None;
        }
        return Some(notes.to_string());
    }
    return None;
}

/// ノートの本文（なければ空）
pub fn notes_of(md: &str) -> String {
    extract_notes_section(md).unwrap_or_default()
}

/// ジャーナルの「## ノート」を notes に置き換えた Markdown（ノートはタイトル直後・完了の上に置く）
pub fn replace_notes(existing_content: &str, notes: &str) -> String {
    // 既存のノートセクションを除去
    let stripped = if let Some(start) = existing_content.find("## ノート\n") {
        let before = &existing_content[..start];
        let after_marker = start + "## ノート\n".len();
        let rest = &existing_content[after_marker..];
        let next_section = rest.find("\n## ").map(|i| after_marker + i);
        match next_section {
            Some(pos) => format!("{}{}", before.trim_end(), &existing_content[pos..]),
            None => before.trim_end().to_string(),
        }
    } else {
        existing_content.trim_end().to_string()
    };

    // ノートセクションをタイトル直後・完了の上に挿入
    let notes_trimmed = notes.trim();
    let md = if !notes_trimmed.is_empty() {
        // 最初の「## 」見出し（完了など）の直前にノートを挿入
        if let Some(first_section) = stripped.find("\n## ") {
            let before = stripped[..first_section].trim_end();
            let after = &stripped[first_section..];
            format!("{}\n\n## ノート\n{}\n{}", before, notes_trimmed, after)
        } else {
            // セクションが無い場合は末尾に追加
            format!("{}\n\n## ノート\n{}\n", stripped, notes_trimmed)
        }
    } else {
        format!("{}\n", stripped)
    };
    md
}

/// ジャーナルのノートセクションのみを更新してGitHubにアップロードする
pub async fn save_journal_notes(
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    date: &str,
    notes: &str,
) -> Result<String, String> {
    let path = format!("journal/{}.md", date);

    // 既存ジャーナルを取得（つながらないときは、そのことが分かるエラーのまま返す）
    let (existing_content, sha) = client.get_contents(owner, repo, &path).await.map_err(|e| {
        if is_network_error(&e) {
            e
        } else {
            format!("{}のジャーナルが見つかりません。先に生成してください。", date)
        }
    })?;
    let md = replace_notes(&existing_content, notes);

    let commit_message = format!("{}のノートを更新", date);
    client
        .put_contents(owner, repo, &path, &md, &commit_message, Some(sha))
        .await?;

    return Ok(md);
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn notes_are_placed_above_the_first_section() {
        let md = "# 2026-09-27 (日)\n\n## 完了\n- なし\n";
        let with_notes = replace_notes(md, "電車で考えた");
        assert_eq!(with_notes, "# 2026-09-27 (日)\n\n## ノート\n電車で考えた\n\n## 完了\n- なし");
        assert_eq!(notes_of(&with_notes), "電車で考えた");
        assert_eq!(replace_notes(&with_notes, "書き直した"), "# 2026-09-27 (日)\n\n## ノート\n書き直した\n\n## 完了\n- なし");
    }
}
