//! プルリク（一覧・詳細・作る・マージ・レビュー）。GitHub の返す大きな JSON を、画面で使う小さな形にして返す。
//! 失敗したときは、何ができなかったかと直し方を日本語で返す（権限が足りない・競合がある など）
use super::client::{is_network_error, GitHubClient};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::Mutex;

type ClientState<'a> = tauri::State<'a, Mutex<Option<GitHubClient>>>;

/// 今のトークンの GitHub クライアント。通信のあいだほかの操作を待たせないよう、複製してすぐにロックを離す
async fn client_of(state: &ClientState<'_>) -> Result<GitHubClient, String> {
    let guard = state.lock().await;
    return Ok(guard.as_ref().ok_or("トークンが未設定です")?.clone());
}

fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("JSONパースエラー: {}", e))
}

// --- エラーの言いかえ ---

/// "HTTP 422 Unprocessable Entity: {json}" から、GitHub の message（と errors の message）を取り出す
fn github_message(err: &str) -> String {
    let body = match err.split_once(": ") {
        Some((head, body)) if head.starts_with("HTTP ") || head == "GraphQL" => body,
        _ => err,
    };
    let Ok(v) = serde_json::from_str::<Value>(body) else {
        return body.to_string();
    };
    let mut parts: Vec<String> = Vec::new();
    if let Some(m) = v["message"].as_str() {
        parts.push(m.to_string());
    }
    for e in v["errors"].as_array().into_iter().flatten() {
        if let Some(m) = e["message"].as_str() {
            parts.push(m.to_string());
        } else if let (Some(field), Some(code)) = (e["field"].as_str(), e["code"].as_str()) {
            parts.push(format!("{} {}", field, code));
        }
    }
    if parts.is_empty() {
        body.to_string()
    } else {
        parts.join(" / ")
    }
}

/// GitHub のエラーを、何をしようとしたか（what。「マージすること」など）を添えて、直し方のわかる日本語にする
pub fn explain(err: &str, what: &str) -> String {
    if is_network_error(err) {
        return err.to_string();
    }
    let message = github_message(err);
    let has = |s: &str| message.contains(s) || err.contains(s);
    if has("not accessible by personal access token") {
        return format!(
            "今のトークン（自分で作ったトークン）では、{}ができません。GitHub のトークンの画面で、このトークンに「Pull requests」の権限（Read and write）を足すか、「GitHub でログイン」で入り直してください",
            what
        );
    }
    if has("not accessible by integration") {
        return format!(
            "{}ができません。GitHub の Life Manager に「Pull requests」の権限がまだないか、このリポジトリに Life Manager が入っていません。持ち主（リーダー）が GitHub で Life Manager の権限の更新を承認する（またはこのリポジトリを選ぶ）と使えます",
            what
        );
    }
    let known: &[(&str, &str)] = &[
        ("A pull request already exists", "このブランチからのプルリクは、もうあります（プルリクの一覧から開けます）"),
        ("No commits between", "2 つのブランチに違いがありません。先に変更をコミットして、プッシュします"),
        ("head invalid", "そのブランチが GitHub にありません。先にプッシュします"),
        ("base invalid", "入れる先のブランチが GitHub にありません"),
        ("Can not approve your own pull request", "自分のプルリクは承認できません（ほかの人に見てもらいます）"),
        ("Can not request changes on your own pull request", "自分のプルリクには、修正を依頼できません"),
        ("Review cannot be requested from pull request author", "プルリクを作った人には、レビューをお願いできません"),
        ("not a collaborator", "レビューをお願いできるのは、このリポジトリのメンバーだけです"),
        ("still a draft", "下書きのプルリクはマージできません。先に「レビューをお願いする」にします"),
        ("Head branch was modified", "そのあいだにブランチに新しいコミットが入りました。読み直してから、もう一度マージします"),
        ("Base branch was modified", "そのあいだに入れる先のブランチが変わりました。読み直してから、もう一度マージします"),
        ("Merge commits are not allowed", "このリポジトリでは「マージコミット」でマージできません（リポジトリの設定）。ほかの仕方を選びます"),
        ("Squash merges are not allowed", "このリポジトリでは「スカッシュ」でマージできません（リポジトリの設定）。ほかの仕方を選びます"),
        ("Rebase merges are not allowed", "このリポジトリでは「リベース」でマージできません（リポジトリの設定）。ほかの仕方を選びます"),
        ("approving review", "マージするには、ほかの人の承認が要ります（ブランチの保護ルール）"),
        ("status check", "マージする前に、決められたチェックが通る必要があります（ブランチの保護ルール）"),
        ("merge conflict", "競合（コンフリクト）があるため、GitHub の上では取り込めません。手元で取り込んで直し、プッシュします"),
        ("not mergeable", "今はマージできません（競合がある・ブランチの保護ルールに合っていない など）"),
        ("expected head sha", "そのあいだにブランチに新しいコミットが入りました。読み直してから、もう一度"),
        ("Reference does not exist", "そのブランチはもうありません"),
        ("Reference already exists", "同じ名前のブランチが、もうあります"),
        ("Protected branch", "保護されたブランチなので、消せません"),
    ];
    for (needle, japanese) in known {
        if has(needle) {
            return japanese.to_string();
        }
    }
    if err.starts_with("HTTP 404") {
        return format!("{}ができません（見つかりません。消されたか、見る権限がありません）", what);
    }
    if err.starts_with("HTTP 403") {
        return format!("{}ができません（権限がありません）: {}", what, message);
    }
    format!("{}ができませんでした: {}", what, message)
}

// --- 画面で使う形 ---

fn person(v: &Value) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    json!({ "login": v["login"], "avatar_url": v["avatar_url"] })
}

fn people(v: &Value) -> Vec<Value> {
    v.as_array().map(|a| a.iter().map(person).collect()).unwrap_or_default()
}

/// 一覧で使う形
pub fn summary(p: &Value) -> Value {
    json!({
        "number": p["number"],
        "node_id": p["node_id"],
        "title": p["title"],
        "body": p["body"].as_str().unwrap_or(""),
        "state": p["state"],
        "draft": p["draft"].as_bool().unwrap_or(false),
        "merged": !p["merged_at"].is_null() || p["merged"].as_bool().unwrap_or(false),
        "user": person(&p["user"]),
        "head": p["head"]["ref"],
        "head_sha": p["head"]["sha"],
        // フォークから出したプルリクは、別のリポジトリ。フォークが消されていると null
        "head_repo": p["head"]["repo"]["full_name"],
        "base": p["base"]["ref"],
        "created_at": p["created_at"],
        "updated_at": p["updated_at"],
        "closed_at": p["closed_at"],
        "merged_at": p["merged_at"],
        "requested_reviewers": people(&p["requested_reviewers"]),
        "labels": p["labels"].as_array().map(|a| a.iter().map(|l| json!({ "name": l["name"], "color": l["color"] })).collect::<Vec<_>>()).unwrap_or_default(),
        "html_url": p["html_url"],
    })
}

/// 詳細で使う形（一覧の形に、マージできるか・数などを足す）
pub fn detail(p: &Value) -> Value {
    let mut v = summary(p);
    let extra = json!({
        // マージできるか。GitHub が調べているあいだは null
        "mergeable": p["mergeable"],
        // clean / dirty（競合）/ blocked（保護ルール）/ behind / unstable（チェックの失敗）/ draft / unknown など
        "mergeable_state": p["mergeable_state"],
        "merged_by": person(&p["merged_by"]),
        "merge_commit_sha": p["merge_commit_sha"],
        "commits": p["commits"],
        "additions": p["additions"],
        "deletions": p["deletions"],
        "changed_files": p["changed_files"],
        "comments": p["comments"],
        "review_comments": p["review_comments"],
    });
    if let (Some(map), Some(more)) = (v.as_object_mut(), extra.as_object()) {
        for (k, value) in more {
            map.insert(k.clone(), value.clone());
        }
    }
    v
}

fn compact_file(f: &Value) -> Value {
    json!({
        "filename": f["filename"],
        "previous_filename": f["previous_filename"],
        // added / removed / modified / renamed / copied / changed / unchanged
        "status": f["status"],
        "additions": f["additions"],
        "deletions": f["deletions"],
        // 画像などのバイナリや、大きすぎる変更には無い
        "patch": f["patch"],
    })
}

fn compact_commit(c: &Value) -> Value {
    json!({
        "sha": c["sha"],
        "message": c["commit"]["message"],
        "author_name": c["commit"]["author"]["name"],
        "date": c["commit"]["author"]["date"],
        // GitHub のアカウントとつながっていないコミットは null
        "author": person(&c["author"]),
    })
}

fn compact_review_comment(c: &Value) -> Value {
    json!({
        "id": c["id"],
        "user": person(&c["user"]),
        "path": c["path"],
        "line": c["line"].as_u64().or(c["original_line"].as_u64()),
        "side": c["side"].as_str().unwrap_or("RIGHT"),
        "body": c["body"],
        "diff_hunk": c["diff_hunk"],
        "at": c["created_at"],
        // あとでその行が変わった（今の差分には出ない）
        "outdated": c["position"].is_null(),
        "in_reply_to": c["in_reply_to_id"],
    })
}

/// 会話に出す出来事（ほかは読み飛ばす）
const EVENTS: &[&str] = &[
    "commented",
    "reviewed",
    "committed",
    "merged",
    "closed",
    "reopened",
    "head_ref_deleted",
    "head_ref_restored",
    "head_ref_force_pushed",
    "review_requested",
    "review_request_removed",
    "review_dismissed",
    "ready_for_review",
    "convert_to_draft",
    "renamed",
    "base_ref_changed",
    "cross-referenced",
    "labeled",
    "unlabeled",
    "assigned",
    "unassigned",
];

/// タイムラインの 1 つを、会話に出す形にする。レビューには、その行のコメントを付ける
fn compact_event(e: &Value, review_comments: &[Value]) -> Option<Value> {
    let kind = e["event"].as_str()?;
    if !EVENTS.contains(&kind) {
        return None;
    }
    let actor = if e["actor"].is_null() { person(&e["user"]) } else { person(&e["actor"]) };
    let at = e["created_at"]
        .as_str()
        .or(e["submitted_at"].as_str())
        .or(e["author"]["date"].as_str())
        .or(e["committer"]["date"].as_str());
    let mut out = json!({ "event": kind, "actor": actor, "at": at });
    match kind {
        "commented" => {
            out["id"] = e["id"].clone();
            out["body"] = json!(e["body"].as_str().unwrap_or(""));
        }
        "reviewed" => {
            out["actor"] = person(&e["user"]);
            out["id"] = e["id"].clone();
            out["body"] = json!(e["body"].as_str().unwrap_or(""));
            out["state"] = json!(e["state"].as_str().unwrap_or("").to_uppercase());
            let id = e["id"].as_u64();
            let comments: Vec<Value> = review_comments
                .iter()
                .filter(|c| id.is_some() && c["pull_request_review_id"].as_u64() == id)
                .map(compact_review_comment)
                .collect();
            out["comments"] = json!(comments);
        }
        "committed" => {
            out["sha"] = e["sha"].clone();
            out["message"] = e["message"].clone();
            out["author_name"] = e["author"]["name"].clone();
        }
        "merged" | "closed" | "reopened" => out["commit_id"] = e["commit_id"].clone(),
        "review_requested" | "review_request_removed" => out["reviewer"] = person(&e["requested_reviewer"]),
        "review_dismissed" => out["body"] = e["dismissed_review"]["dismissal_message"].clone(),
        "renamed" => {
            out["from"] = e["rename"]["from"].clone();
            out["to"] = e["rename"]["to"].clone();
        }
        "labeled" | "unlabeled" => out["label"] = json!({ "name": e["label"]["name"], "color": e["label"]["color"] }),
        "assigned" | "unassigned" => out["assignee"] = person(&e["assignee"]),
        "cross-referenced" => {
            let i = &e["source"]["issue"];
            out["source"] = json!({
                "number": i["number"],
                "title": i["title"],
                "pull": !i["pull_request"].is_null(),
                "repo": i["repository"]["full_name"],
            });
        }
        _ => {}
    }
    Some(out)
}

/// タイムラインを会話の並びにする
pub fn conversation(timeline: &Value, review_comments: &Value) -> Vec<Value> {
    let comments: Vec<Value> = review_comments.as_array().cloned().unwrap_or_default();
    timeline
        .as_array()
        .map(|events| events.iter().filter_map(|e| compact_event(e, &comments)).collect())
        .unwrap_or_default()
}

/// レビューした人ごとの最後の判断（承認・修正の依頼）。コメントだけのレビューは判断を変えない。取り下げ（DISMISSED）で消える
pub fn verdicts<'a>(reviews: impl Iterator<Item = (&'a str, &'a str)>) -> Value {
    let mut last: Vec<(String, String)> = Vec::new();
    for (login, state) in reviews {
        let state = state.to_uppercase();
        if state != "APPROVED" && state != "CHANGES_REQUESTED" && state != "DISMISSED" {
            continue;
        }
        match last.iter_mut().find(|(l, _)| l == login) {
            Some(entry) => entry.1 = state,
            None => last.push((login.to_string(), state)),
        }
    }
    let of = |s: &str| last.iter().filter(|(_, st)| st == s).map(|(l, _)| l.clone()).collect::<Vec<_>>();
    json!({ "approved": of("APPROVED"), "changes_requested": of("CHANGES_REQUESTED") })
}

/// GitHub の「レビューの一覧」から判断を読む
fn verdicts_of_reviews(reviews: &Value) -> Value {
    let list = reviews.as_array().cloned().unwrap_or_default();
    verdicts(list.iter().filter_map(|r| Some((r["user"]["login"].as_str()?, r["state"].as_str()?))))
}

/// 会話（compact_event の形）から判断を読む
fn verdicts_of_conversation(items: &[Value]) -> Value {
    verdicts(
        items
            .iter()
            .filter(|e| e["event"] == "reviewed")
            .filter_map(|e| Some((e["actor"]["login"].as_str()?, e["state"].as_str()?))),
    )
}

// --- 画面から呼ぶコマンド ---

/// プルリクの一覧（すべての状態。更新の新しい順）
#[tauri::command]
pub async fn list_pulls(state: ClientState<'_>, owner: String, repo: String) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let text = client.list_pulls(&owner, &repo).await.map_err(|e| explain(&e, "プルリクを読むこと"))?;
    Ok(parse(&text)?.as_array().map(|a| a.iter().map(summary).collect()).unwrap_or_default())
}

/// プルリクごとの、承認した人・修正を依頼した人（一覧の印。開いているものだけ、多くても 30 件）
#[tauri::command]
pub async fn pull_verdicts(state: ClientState<'_>, owner: String, repo: String, numbers: Vec<u64>) -> Result<HashMap<String, Value>, String> {
    let client = client_of(&state).await?;
    let mut tasks = tokio::task::JoinSet::new();
    for n in numbers.into_iter().take(30) {
        let (c, o, r) = (client.clone(), owner.clone(), repo.clone());
        tasks.spawn(async move { (n, c.list_pull_reviews(&o, &r, n).await) });
    }
    let mut out = HashMap::new();
    while let Some(done) = tasks.join_next().await {
        if let Ok((n, Ok(text))) = done {
            if let Ok(reviews) = parse(&text) {
                out.insert(n.to_string(), verdicts_of_reviews(&reviews));
            }
        }
    }
    Ok(out)
}

/// 1 つのプルリクの詳しいこと（マージできるか・会話・レビューの判断・ブランチが残っているか）
#[tauri::command]
pub async fn pull_detail(state: ClientState<'_>, owner: String, repo: String, number: u64) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let pull = parse(&client.get_pull(&owner, &repo, number).await.map_err(|e| explain(&e, "プルリクを読むこと"))?)?;
    let head = pull["head"]["ref"].as_str().unwrap_or("").to_string();
    let same_repo = pull["head"]["repo"]["full_name"].as_str() == Some(format!("{}/{}", owner, repo).as_str());
    let closed = pull["state"] == "closed";
    let (timeline, comments, exists) = tokio::join!(
        client.list_timeline(&owner, &repo, number as u32),
        client.list_pull_review_comments(&owner, &repo, number),
        async {
            // 閉じたあと（マージしたあと）に、ブランチを消したか・戻せるか
            if same_repo && closed && !head.is_empty() {
                client.branch_exists(&owner, &repo, &head).await.ok()
            } else {
                None
            }
        }
    );
    let timeline = parse(&timeline.map_err(|e| explain(&e, "プルリクの会話を読むこと"))?)?;
    let comments = comments.ok().and_then(|t| parse(&t).ok()).unwrap_or_else(|| json!([]));
    let items = conversation(&timeline, &comments);
    let mut out = detail(&pull);
    out["verdicts"] = verdicts_of_conversation(&items);
    out["conversation"] = json!(items);
    out["head_exists"] = json!(exists);
    out["same_repo"] = json!(same_repo);
    Ok(out)
}

/// 変更したファイル（ファイルごとの差分つき）
#[tauri::command]
pub async fn pull_files(state: ClientState<'_>, owner: String, repo: String, number: u64) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let text = client.list_pull_files(&owner, &repo, number).await.map_err(|e| explain(&e, "変更したファイルを読むこと"))?;
    Ok(parse(&text)?.as_array().map(|a| a.iter().map(compact_file).collect()).unwrap_or_default())
}

#[tauri::command]
pub async fn pull_commits(state: ClientState<'_>, owner: String, repo: String, number: u64) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let text = client.list_pull_commits(&owner, &repo, number).await.map_err(|e| explain(&e, "コミットを読むこと"))?;
    Ok(parse(&text)?.as_array().map(|a| a.iter().map(compact_commit).collect()).unwrap_or_default())
}

/// プルリクを作る・マージするときに使う、リポジトリのこと（既定のブランチ・ブランチの一覧・使えるマージの仕方・書き込めるか）
#[tauri::command]
pub async fn pull_repo_info(state: ClientState<'_>, owner: String, repo: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let (info, branches) = tokio::join!(client.get_repository(&owner, &repo), client.list_branches(&owner, &repo));
    let info = parse(&info.map_err(|e| explain(&e, "リポジトリを読むこと"))?)?;
    let branches = parse(&branches.map_err(|e| explain(&e, "ブランチを読むこと"))?)?;
    // マージの設定は、書き込めない人には返らないことがある。そのときは使えるものとしておく（断られたら GitHub の理由を見せる）
    let allowed = |key: &str| info[key].as_bool().unwrap_or(true);
    Ok(json!({
        "default_branch": info["default_branch"],
        "branches": branches.as_array().map(|a| a.iter().filter_map(|b| b["name"].as_str()).collect::<Vec<_>>()).unwrap_or_default(),
        "allow_merge_commit": allowed("allow_merge_commit"),
        "allow_squash_merge": allowed("allow_squash_merge"),
        "allow_rebase_merge": allowed("allow_rebase_merge"),
        "delete_branch_on_merge": info["delete_branch_on_merge"].as_bool().unwrap_or(false),
        "can_push": info["permissions"]["push"].as_bool().unwrap_or(false),
    }))
}

/// 2 つのブランチの違い（プルリクを作る前に、入るコミットと変更を見る）
#[tauri::command]
pub async fn compare_branches(state: ClientState<'_>, owner: String, repo: String, base: String, head: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let c = parse(&client.compare(&owner, &repo, &base, &head).await.map_err(|e| explain(&e, "ブランチの違いを読むこと"))?)?;
    let list = |key: &str, f: fn(&Value) -> Value| c[key].as_array().map(|a| a.iter().map(f).collect::<Vec<_>>()).unwrap_or_default();
    Ok(json!({
        // ahead（head が先に進んでいる）/ behind / diverged / identical
        "status": c["status"],
        "ahead_by": c["ahead_by"],
        "behind_by": c["behind_by"],
        "total_commits": c["total_commits"],
        "commits": list("commits", compact_commit),
        "files": list("files", compact_file),
    }))
}

/// プルリクを作る。reviewers があれば、続けてレビューをお願いする（お願いできなくても、プルリクはできている）
#[tauri::command]
pub async fn create_pull(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    title: String,
    head: String,
    base: String,
    body: String,
    draft: bool,
    reviewers: Vec<String>,
) -> Result<Value, String> {
    let client = client_of(&state).await?;
    if title.trim().is_empty() {
        return Err("題名を入力してください".into());
    }
    let created = parse(
        &client
            .create_pull(&owner, &repo, title.trim(), &head, &base, &body, draft)
            .await
            .map_err(|e| explain(&e, "プルリクを作ること"))?,
    )?;
    let mut reviewers_error: Option<String> = None;
    if !reviewers.is_empty() {
        let number = created["number"].as_u64().unwrap_or(0);
        if let Err(e) = client.request_reviewers(&owner, &repo, number, &reviewers).await {
            reviewers_error = Some(explain(&e, "レビューをお願いすること"));
        }
    }
    Ok(json!({ "pull": summary(&created), "reviewers_error": reviewers_error }))
}

/// 題名・本文を直す、閉じる（pull_state = closed）、開き直す（open）
#[tauri::command]
pub async fn update_pull(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    number: u64,
    title: Option<String>,
    body: Option<String>,
    pull_state: Option<String>,
) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let mut payload = serde_json::Map::new();
    if let Some(t) = title {
        if t.trim().is_empty() {
            return Err("題名を入力してください".into());
        }
        payload.insert("title".into(), json!(t.trim()));
    }
    if let Some(b) = body {
        payload.insert("body".into(), json!(b));
    }
    let what = match pull_state.as_deref() {
        Some("closed") => "プルリクを閉じること",
        Some("open") => "プルリクを開き直すこと",
        _ => "プルリクを直すこと",
    };
    if let Some(s) = pull_state {
        payload.insert("state".into(), json!(s));
    }
    let text = client.update_pull(&owner, &repo, number, &Value::Object(payload)).await.map_err(|e| explain(&e, what))?;
    Ok(summary(&parse(&text)?))
}

/// マージする。delete_branch があれば、続けて GitHub のそのブランチを消す（消せなくても、マージはできている）
#[tauri::command]
pub async fn merge_pull(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    number: u64,
    method: String,
    sha: String,
    delete_branch: Option<String>,
) -> Result<Value, String> {
    if !["merge", "squash", "rebase"].contains(&method.as_str()) {
        return Err(format!("マージの仕方「{}」は使えません", method));
    }
    let client = client_of(&state).await?;
    let merged = parse(&client.merge_pull(&owner, &repo, number, &method, &sha).await.map_err(|e| explain(&e, "マージすること"))?)?;
    let mut branch_deleted = false;
    let mut branch_error: Option<String> = None;
    if let Some(branch) = delete_branch.filter(|b| !b.is_empty()) {
        match client.delete_branch_ref(&owner, &repo, &branch).await {
            Ok(_) => branch_deleted = true,
            // リポジトリの設定（マージしたらブランチを消す）で、GitHub がもう消していた
            Err(e) if e.contains("Reference does not exist") => branch_deleted = true,
            Err(e) => branch_error = Some(explain(&e, &format!("ブランチ {} を消すこと", branch))),
        }
    }
    Ok(json!({
        "sha": merged["sha"],
        "branch_deleted": branch_deleted,
        "branch_error": branch_error,
    }))
}

/// レビューを送る（承認する・修正を依頼する・コメント）
#[tauri::command]
pub async fn review_pull(state: ClientState<'_>, owner: String, repo: String, number: u64, event: String, body: String) -> Result<(), String> {
    let what = match event.as_str() {
        "APPROVE" => "承認すること",
        "REQUEST_CHANGES" => "修正を依頼すること",
        "COMMENT" => "レビューを送ること",
        _ => return Err(format!("レビューの種類「{}」は使えません", event)),
    };
    if event != "APPROVE" && body.trim().is_empty() {
        return Err("何を直してほしいか（コメント）を書いてください".into());
    }
    let client = client_of(&state).await?;
    client.create_review(&owner, &repo, number, &event, &body).await.map_err(|e| explain(&e, what))?;
    Ok(())
}

/// 会話にコメントを書く（プルリクも Issue と同じコメント）
#[tauri::command]
pub async fn comment_pull(state: ClientState<'_>, owner: String, repo: String, number: u64, body: String) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("コメントを入力してください".into());
    }
    let client = client_of(&state).await?;
    client.create_comment(&owner, &repo, number as u32, &body).await.map_err(|e| explain(&e, "コメントを書くこと"))?;
    Ok(())
}

/// 差分の 1 行にコメントを付ける（その場でレビューとして送られる）
#[tauri::command]
pub async fn comment_pull_line(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    number: u64,
    commit_id: String,
    path: String,
    line: u64,
    side: String,
    body: String,
) -> Result<(), String> {
    if body.trim().is_empty() {
        return Err("コメントを入力してください".into());
    }
    let side = if side == "LEFT" { "LEFT" } else { "RIGHT" };
    let client = client_of(&state).await?;
    client
        .create_review_comment(&owner, &repo, number, &commit_id, &path, line, side, &body)
        .await
        .map_err(|e| explain(&e, "行にコメントを付けること"))?;
    Ok(())
}

/// レビューをお願いする人を足す・外す
#[tauri::command]
pub async fn set_pull_reviewers(
    state: ClientState<'_>,
    owner: String,
    repo: String,
    number: u64,
    add: Vec<String>,
    remove: Vec<String>,
) -> Result<(), String> {
    let client = client_of(&state).await?;
    if !add.is_empty() {
        client.request_reviewers(&owner, &repo, number, &add).await.map_err(|e| explain(&e, "レビューをお願いすること"))?;
    }
    if !remove.is_empty() {
        client.remove_reviewers(&owner, &repo, number, &remove).await.map_err(|e| explain(&e, "お願いを取り消すこと"))?;
    }
    Ok(())
}

/// 入れる先の新しいコミットを、プルリクのブランチに取り込む
#[tauri::command]
pub async fn update_pull_branch(state: ClientState<'_>, owner: String, repo: String, number: u64, head_sha: String) -> Result<(), String> {
    let client = client_of(&state).await?;
    client.update_pull_branch(&owner, &repo, number, &head_sha).await.map_err(|e| explain(&e, "ブランチを更新すること"))?;
    Ok(())
}

/// 下書きにする（draft = true）・レビューをお願いできる状態にする（false）。REST にないので GraphQL で
#[tauri::command]
pub async fn set_pull_draft(state: ClientState<'_>, node_id: String, draft: bool) -> Result<(), String> {
    let client = client_of(&state).await?;
    let (query, what) = if draft {
        (
            "mutation($id: ID!) { convertPullRequestToDraft(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
            "下書きに戻すこと",
        )
    } else {
        (
            "mutation($id: ID!) { markPullRequestReadyForReview(input: {pullRequestId: $id}) { pullRequest { isDraft } } }",
            "レビューをお願いできる状態にすること",
        )
    };
    client.graphql(query, json!({ "id": node_id })).await.map_err(|e| explain(&e, what))?;
    Ok(())
}

/// マージしたあとの片づけ: GitHub のブランチを消す
#[tauri::command]
pub async fn delete_pull_branch(state: ClientState<'_>, owner: String, repo: String, branch: String) -> Result<(), String> {
    let client = client_of(&state).await?;
    client
        .delete_branch_ref(&owner, &repo, &branch)
        .await
        .map_err(|e| explain(&e, &format!("ブランチ {} を消すこと", branch)))?;
    Ok(())
}

/// 消したブランチを戻す（最後のコミットから作り直す）
#[tauri::command]
pub async fn restore_pull_branch(state: ClientState<'_>, owner: String, repo: String, branch: String, sha: String) -> Result<(), String> {
    let client = client_of(&state).await?;
    client
        .create_branch_ref(&owner, &repo, &branch, &sha)
        .await
        .map_err(|e| explain(&e, &format!("ブランチ {} を戻すこと", branch)))?;
    Ok(())
}

/// このブランチから出したプルリク（作業の流れで使う）。開いているものがあればそれ、なければいちばん新しいもの。
/// 開いているものには、承認・修正の依頼をした人を付ける
#[tauri::command]
pub async fn branch_pull(state: ClientState<'_>, owner: String, repo: String, branch: String) -> Result<Option<Value>, String> {
    let client = client_of(&state).await?;
    let list = parse(&client.list_pulls_from(&owner, &repo, &branch).await.map_err(|e| explain(&e, "プルリクを読むこと"))?)?;
    let pulls = list.as_array().cloned().unwrap_or_default();
    let Some(chosen) = pulls.iter().find(|p| p["state"] == "open").or(pulls.first()) else {
        return Ok(None);
    };
    let mut out = summary(chosen);
    if chosen["state"] == "open" {
        let number = chosen["number"].as_u64().unwrap_or(0);
        if let Ok(text) = client.list_pull_reviews(&owner, &repo, number).await {
            out["verdicts"] = verdicts_of_reviews(&parse(&text)?);
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn explains_permission_and_known_errors() {
        let integration = r#"HTTP 403 Forbidden: {"message":"Resource not accessible by integration","documentation_url":"x"}"#;
        assert!(explain(integration, "マージすること").contains("「Pull requests」の権限"));
        assert!(explain(integration, "マージすること").starts_with("マージすることができません"));

        let pat = r#"HTTP 403 Forbidden: {"message":"Resource not accessible by personal access token"}"#;
        assert!(explain(pat, "プルリクを読むこと").contains("トークンの画面"));

        let exists = r#"HTTP 422 Unprocessable Entity: {"message":"Validation Failed","errors":[{"resource":"PullRequest","code":"custom","message":"A pull request already exists for y0zrin:feature/x."}]}"#;
        assert_eq!(explain(exists, "プルリクを作ること"), "このブランチからのプルリクは、もうあります（プルリクの一覧から開けます）");

        let head = r#"HTTP 422 Unprocessable Entity: {"message":"Validation Failed","errors":[{"resource":"PullRequest","field":"head","code":"invalid"}]}"#;
        assert_eq!(explain(head, "プルリクを作ること"), "そのブランチが GitHub にありません。先にプッシュします");

        let own = r#"HTTP 422 Unprocessable Entity: {"message":"Unprocessable Entity","errors":["Can not approve your own pull request"]}"#;
        assert_eq!(explain(own, "承認すること"), "自分のプルリクは承認できません（ほかの人に見てもらいます）");

        let draft = r#"HTTP 405 Method Not Allowed: {"message":"Pull Request is still a draft"}"#;
        assert!(explain(draft, "マージすること").starts_with("下書きのプルリクは"));

        let graphql = "GraphQL: Resource not accessible by integration";
        assert!(explain(graphql, "下書きに戻すこと").contains("「Pull requests」の権限"));

        let other = r#"HTTP 500 Internal Server Error: {"message":"Server Error"}"#;
        assert_eq!(explain(other, "マージすること"), "マージすることができませんでした: Server Error");

        let offline = format!("{}error sending request", crate::github::client::NETWORK_ERROR);
        assert_eq!(explain(&offline, "マージすること"), offline);
    }

    #[test]
    fn keeps_the_last_verdict_of_each_reviewer() {
        let reviews = json!([
            { "user": { "login": "a" }, "state": "CHANGES_REQUESTED" },
            { "user": { "login": "b" }, "state": "APPROVED" },
            { "user": { "login": "a" }, "state": "COMMENTED" },
            { "user": { "login": "a" }, "state": "APPROVED" },
            { "user": { "login": "c" }, "state": "CHANGES_REQUESTED" },
            { "user": { "login": "b" }, "state": "DISMISSED" },
        ]);
        let v = verdicts_of_reviews(&reviews);
        assert_eq!(v["approved"], json!(["a"]));
        assert_eq!(v["changes_requested"], json!(["c"]));
    }

    #[test]
    fn builds_the_conversation_from_the_timeline() {
        let timeline = json!([
            { "event": "committed", "sha": "abc", "message": "ボスを直す", "author": { "name": "Yui", "date": "2026-10-01T10:00:00Z" } },
            { "event": "subscribed", "actor": { "login": "y" }, "created_at": "2026-10-01T10:01:00Z" },
            { "event": "review_requested", "actor": { "login": "y" }, "requested_reviewer": { "login": "z", "avatar_url": "u" }, "created_at": "2026-10-01T10:02:00Z" },
            { "event": "reviewed", "id": 7, "user": { "login": "z", "avatar_url": "u" }, "state": "changes_requested", "body": "ここを直して", "submitted_at": "2026-10-01T11:00:00Z" },
            { "event": "commented", "id": 9, "actor": { "login": "y" }, "user": { "login": "y" }, "body": "直しました", "created_at": "2026-10-01T12:00:00Z" },
            { "event": "merged", "actor": { "login": "z" }, "commit_id": "def", "created_at": "2026-10-01T13:00:00Z" }
        ]);
        let comments = json!([
            { "id": 1, "pull_request_review_id": 7, "path": "src/Boss.cpp", "line": 12, "side": "RIGHT", "body": "範囲の外に出ます", "position": 3, "user": { "login": "z" } },
            { "id": 2, "pull_request_review_id": 8, "path": "src/Other.cpp", "line": 1, "body": "別のレビュー", "position": null, "user": { "login": "z" } }
        ]);
        let items = conversation(&timeline, &comments);
        let kinds: Vec<&str> = items.iter().map(|e| e["event"].as_str().unwrap()).collect();
        assert_eq!(kinds, vec!["committed", "review_requested", "reviewed", "commented", "merged"]);
        assert_eq!(items[0]["at"], "2026-10-01T10:00:00Z");
        assert_eq!(items[1]["reviewer"]["login"], "z");
        assert_eq!(items[2]["state"], "CHANGES_REQUESTED");
        assert_eq!(items[2]["actor"]["login"], "z");
        assert_eq!(items[2]["comments"].as_array().unwrap().len(), 1);
        assert_eq!(items[2]["comments"][0]["path"], "src/Boss.cpp");
        assert_eq!(items[2]["comments"][0]["outdated"], false);
        assert_eq!(items[4]["commit_id"], "def");
        assert_eq!(verdicts_of_conversation(&items)["changes_requested"], json!(["z"]));
    }

    #[test]
    fn summary_marks_merged_pulls() {
        let p = json!({
            "number": 12, "title": "t", "body": null, "state": "closed", "draft": false, "merged_at": "2026-10-01T13:00:00Z",
            "user": { "login": "y", "avatar_url": "a", "id": 1 },
            "head": { "ref": "feature/x", "sha": "abc", "repo": { "full_name": "y/r" } },
            "base": { "ref": "main" }, "requested_reviewers": [], "labels": [{ "name": "種別:バグ", "color": "d73a4a", "id": 3 }]
        });
        let s = summary(&p);
        assert_eq!(s["merged"], true);
        assert_eq!(s["body"], "");
        assert_eq!(s["head"], "feature/x");
        assert_eq!(s["head_repo"], "y/r");
        assert_eq!(s["labels"][0], json!({ "name": "種別:バグ", "color": "d73a4a" }));
        assert!(s["user"].get("id").is_none());
    }
}
