use crate::github::client::GitHubClient;

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

    // その日にクローズされたIssueを取得（closed状態のIssue一覧から日付でフィルタ）
    let closed_json = client.list_issues(owner, repo, "closed").await?;
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

    // その日に作成されたメモを取得（全Issueから種別:メモラベル付きで日付フィルタ）
    // open + closed 両方から探す
    let open_json = client.list_issues(owner, repo, "all").await?;
    let all_issues: Vec<serde_json::Value> =
        serde_json::from_str(&open_json).map_err(|e| format!("JSONパースエラー: {}", e))?;

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
    let open_json2 = client.list_issues(owner, repo, "open").await?;
    let open_issues: Vec<serde_json::Value> =
        serde_json::from_str(&open_json2).map_err(|e| format!("JSONパースエラー: {}", e))?;
    let in_progress_count = open_issues
        .iter()
        .filter(|issue| {
            issue["labels"]
                .as_array()
                .map(|labels| {
                    labels
                        .iter()
                        .any(|l| l["name"].as_str() == Some("状態:進行中"))
                })
                .unwrap_or(false)
        })
        .count();

    // Markdown生成
    let weekday = weekday_jp(&parsed_date);
    let mut md = format!("# {} ({})\n\n", date, weekday);

    // 完了セクション
    md.push_str("## 完了\n");
    if completed.is_empty() {
        md.push_str("- なし\n");
    } else {
        for issue in &completed {
            let number = issue["number"].as_u64().unwrap_or(0);
            let title = issue["title"].as_str().unwrap_or("");
            // 分野ラベルを抽出
            let area = issue["labels"]
                .as_array()
                .and_then(|labels| {
                    labels.iter().find_map(|l| {
                        let name = l["name"].as_str().unwrap_or("");
                        if name.starts_with("分野:") {
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
    let path = format!("journal/{}.md", date);
    let commit_message = format!("{}の日次ログを生成", date);

    // 既存ファイルがあればSHAを取得（上書き更新のため）
    let sha = match client.get_contents(owner, repo, &path).await {
        Ok((_, existing_sha)) => Some(existing_sha),
        Err(_) => None,
    };

    client
        .put_contents(owner, repo, &path, &md, &commit_message, sha)
        .await?;

    return Ok(md);
}

/// 指定日のジャーナルをGitHubから取得する
pub async fn get_journal(
    client: &GitHubClient,
    owner: &str,
    repo: &str,
    date: &str,
) -> Result<String, String> {
    let path = format!("journal/{}.md", date);
    match client.get_contents(owner, repo, &path).await {
        Ok((content, _sha)) => return Ok(content),
        Err(_) => return Err(format!("{}のジャーナルが見つかりません", date)),
    }
}
