use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

const BASE_URL: &str = "https://api.github.com";

/// 通信そのものができなかった（オフラインなど）ときのエラーの頭に付ける。これが付いたエラーは、つながってから送り直せる
pub const NETWORK_ERROR: &str = "通信できませんでした: ";

fn network_error(e: reqwest::Error) -> String {
    return format!("{}{}", NETWORK_ERROR, e);
}

/// 通信できなかったためのエラーか（GitHub が断ったエラーとは分ける）
pub fn is_network_error(message: &str) -> bool {
    return message.starts_with(NETWORK_ERROR);
}

/// ブランチの名前を URL に入れる形にする（feature/x の / はそのまま。# ? % や空白などだけを変える）
fn encode_ref(name: &str) -> String {
    return urlencoding::encode(name).replace("%2F", "/");
}

#[derive(Clone)]
pub struct GitHubClient {
    http: reqwest::Client,
    token: String,
    /// いつものトークンを使う（「GitHub でログイン」の鍵は 8 時間ごとに新しくなるので、送るたびに今の鍵を取り出す）
    follow_default: bool,
}

impl GitHubClient {
    /// このトークンだけを使うクライアント（貼ったトークン・プロジェクト専用のトークン・確かめるとき）
    pub fn new(token: String) -> GitHubClient {
        return GitHubClient::build(token, false);
    }

    /// いつものトークンを使うクライアント。ログインの鍵が新しくなっても、作り直さずに使い続けられる
    pub fn following_default(token: String) -> GitHubClient {
        return GitHubClient::build(token, true);
    }

    fn build(token: String, follow_default: bool) -> GitHubClient {
        // つながらないときに長く待たせないよう、時間を区切る
        let http = reqwest::Client::builder()
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(30))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        return GitHubClient { http, token, follow_default };
    }

    /// 送るときに使うトークン（ログインの鍵なら、期限が近ければ新しくしたもの）
    async fn current_token(&self) -> String {
        if self.follow_default {
            if let Some(token) = crate::tokens::fresh_default().await {
                return token;
            }
        }
        return self.token.clone();
    }

    /// 1 つの Issue（送信待ちの変更を送る前に、今の GitHub の内容と比べるため）
    pub async fn get_issue(&self, owner: &str, repo: &str, issue_number: u32) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/issues/{}", BASE_URL, owner, repo, issue_number);
        return self.get(&url).await;
    }

    // --- Issue ---

    pub async fn list_issues(
        &self,
        owner: &str,
        repo: &str,
        state: &str,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues?state={}&per_page=100",
            BASE_URL, owner, repo, state
        );
        // 100件超のIssueに対応するためページネーションで全件取得
        return self.get_all_pages(&url).await;
    }

    /// 指定ラベル付きのIssueのみ取得
    pub async fn list_issues_by_label(
        &self,
        owner: &str,
        repo: &str,
        state: &str,
        label: &str,
    ) -> Result<String, String> {
        let encoded_label = urlencoding::encode(label);
        let url = format!(
            "{}/repos/{}/{}/issues?state={}&labels={}&per_page=100",
            BASE_URL, owner, repo, state, encoded_label
        );
        return self.get_all_pages(&url).await;
    }

    /// since(ISO 8601)以降に更新されたIssueのみ取得
    pub async fn list_issues_since(
        &self,
        owner: &str,
        repo: &str,
        state: &str,
        since: &str,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues?state={}&since={}&per_page=100",
            BASE_URL, owner, repo, state, since
        );
        return self.get_all_pages(&url).await;
    }

    pub async fn create_issue(
        &self,
        owner: &str,
        repo: &str,
        title: &str,
        body: &str,
        labels: Vec<String>,
        milestone: Option<u32>,
        assignees: Option<Vec<String>>,
    ) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/issues", BASE_URL, owner, repo);
        let mut payload = serde_json::json!({
            "title": title,
            "body": body,
            "labels": labels
        });
        if let Some(m) = milestone {
            payload["milestone"] = serde_json::json!(m);
        }
        if let Some(a) = assignees {
            payload["assignees"] = serde_json::json!(a);
        }
        return self.post(&url, &payload).await;
    }

    pub async fn update_issue(
        &self,
        owner: &str,
        repo: &str,
        issue_number: u32,
        title: Option<String>,
        body: Option<String>,
        state: Option<String>,
        labels: Option<Vec<String>>,
        milestone: Option<u32>,
        assignees: Option<Vec<String>>,
        state_reason: Option<String>,
        duplicate_issue_id: Option<u64>,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}",
            BASE_URL, owner, repo, issue_number
        );

        let mut payload = serde_json::Map::new();
        if let Some(t) = title {
            payload.insert("title".to_string(), serde_json::Value::String(t));
        }
        if let Some(b) = body {
            payload.insert("body".to_string(), serde_json::Value::String(b));
        }
        if let Some(s) = state {
            payload.insert("state".to_string(), serde_json::Value::String(s));
        }
        if let Some(l) = labels {
            payload.insert("labels".to_string(), serde_json::json!(l));
        }
        if let Some(m) = milestone {
            if m == 0 {
                payload.insert("milestone".to_string(), serde_json::Value::Null);
            } else {
                payload.insert("milestone".to_string(), serde_json::json!(m));
            }
        }
        if let Some(a) = assignees {
            payload.insert("assignees".to_string(), serde_json::json!(a));
        }
        // 閉じる理由（完了・予定なし・重複）。重複なら、元の Issue の id も
        if let Some(r) = state_reason {
            payload.insert("state_reason".to_string(), serde_json::Value::String(r));
        }
        if let Some(id) = duplicate_issue_id {
            payload.insert("duplicate_issue_id".to_string(), serde_json::json!(id));
        }
        return self.patch(&url, &payload).await;
    }

    // --- Collaborators ---

    pub async fn list_collaborators(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/collaborators?per_page=100",
            BASE_URL, owner, repo
        );
        return self.get_all_pages(&url).await;
    }

    // --- Labels ---

    pub async fn list_labels(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/labels?per_page=100",
            BASE_URL, owner, repo
        );
        // 100件超のラベルに対応するためページネーションで全件取得
        return self.get_all_pages(&url).await;
    }

    pub async fn create_label(
        &self,
        owner: &str,
        repo: &str,
        name: &str,
        color: &str,
        description: &str,
    ) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/labels", BASE_URL, owner, repo);
        let payload = serde_json::json!({
            "name": name,
            "color": color,
            "description": description
        });
        return self.post(&url, &payload).await;
    }

    pub async fn update_label(
        &self,
        owner: &str,
        repo: &str,
        current_name: &str,
        new_name: &str,
        color: &str,
        description: &str,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/labels/{}",
            BASE_URL, owner, repo, urlencoding::encode(current_name)
        );
        let payload = serde_json::json!({
            "new_name": new_name,
            "color": color,
            "description": description
        });
        return self.patch_json(&url, &payload).await;
    }

    pub async fn delete_label(
        &self,
        owner: &str,
        repo: &str,
        name: &str,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/labels/{}",
            BASE_URL, owner, repo, urlencoding::encode(name)
        );
        return self.delete(&url).await;
    }

    // --- Milestones ---

    pub async fn list_milestones(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/milestones?state=open&per_page=100",
            BASE_URL, owner, repo
        );
        return self.get(&url).await;
    }

    pub async fn create_milestone(
        &self,
        owner: &str,
        repo: &str,
        title: &str,
        description: &str,
        due_on: Option<String>,
    ) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/milestones", BASE_URL, owner, repo);
        let mut payload = serde_json::json!({
            "title": title,
            "description": description
        });
        if let Some(d) = due_on {
            payload["due_on"] = serde_json::Value::String(d);
        }
        return self.post(&url, &payload).await;
    }

    pub async fn update_milestone(
        &self,
        owner: &str,
        repo: &str,
        milestone_number: u32,
        title: Option<String>,
        description: Option<String>,
        due_on: Option<String>,
        state: Option<String>,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/milestones/{}",
            BASE_URL, owner, repo, milestone_number
        );
        let mut payload = serde_json::Map::new();
        if let Some(t) = title {
            payload.insert("title".to_string(), serde_json::Value::String(t));
        }
        if let Some(d) = description {
            payload.insert("description".to_string(), serde_json::Value::String(d));
        }
        if let Some(d) = due_on {
            if d.is_empty() {
                payload.insert("due_on".to_string(), serde_json::Value::Null);
            } else {
                payload.insert("due_on".to_string(), serde_json::Value::String(d));
            }
        }
        if let Some(s) = state {
            payload.insert("state".to_string(), serde_json::Value::String(s));
        }
        return self.patch(&url, &payload).await;
    }

    // --- Comments ---

    pub async fn list_comments(
        &self,
        owner: &str,
        repo: &str,
        issue_number: u32,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}/comments?per_page=100",
            BASE_URL, owner, repo, issue_number
        );
        return self.get(&url).await;
    }

    pub async fn create_comment(
        &self,
        owner: &str,
        repo: &str,
        issue_number: u32,
        body: &str,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}/comments",
            BASE_URL, owner, repo, issue_number
        );
        let payload = serde_json::json!({ "body": body });
        return self.post(&url, &payload).await;
    }

    // --- ファイル（Issue テンプレートなど） ---

    /// フォルダの中のファイルの名前（フォルダがなければ空）
    pub async fn list_directory(&self, owner: &str, repo: &str, path: &str) -> Result<Vec<String>, String> {
        let url = format!("{}/repos/{}/{}/contents/{}", BASE_URL, owner, repo, path);
        match self.get(&url).await {
            Ok(resp) => {
                let json: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
                Ok(json
                    .as_array()
                    .map(|xs| {
                        xs.iter()
                            .filter(|x| x["type"].as_str() == Some("file"))
                            .filter_map(|x| x["name"].as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default())
            }
            Err(e) if e.starts_with("HTTP 404") => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// フォルダの中のファイルとフォルダの名前（フォルダは名前の後ろに / を付ける。なければ空）
    pub async fn list_entries(&self, owner: &str, repo: &str, path: &str) -> Result<Vec<String>, String> {
        let url = format!("{}/repos/{}/{}/contents/{}", BASE_URL, owner, repo, path);
        match self.get(&url).await {
            Ok(resp) => {
                let json: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
                Ok(json
                    .as_array()
                    .map(|xs| {
                        xs.iter()
                            .filter_map(|x| {
                                let name = x["name"].as_str()?;
                                Some(if x["type"].as_str() == Some("dir") { format!("{}/", name) } else { name.to_string() })
                            })
                            .collect()
                    })
                    .unwrap_or_default())
            }
            Err(e) if e.starts_with("HTTP 404") => Ok(Vec::new()),
            Err(e) => Err(e),
        }
    }

    /// ファイルの中身（テキスト）
    pub async fn read_text(&self, owner: &str, repo: &str, path: &str) -> Result<String, String> {
        self.fetch_contents(owner, repo, path).await.map(|(content, _)| content)
    }

    /// いくつかのファイルを 1 つのコミットにして、既定のブランチに足す（Git Data API: ツリー → コミット → ブランチを進める）
    pub async fn commit_files(&self, owner: &str, repo: &str, files: &[(String, String)], message: &str) -> Result<String, String> {
        let parse = |s: String| serde_json::from_str::<serde_json::Value>(&s).map_err(|e| e.to_string());
        let info = parse(self.get_repository(owner, repo).await?)?;
        let branch = info["default_branch"].as_str().unwrap_or("main").to_string();
        let base = format!("{}/repos/{}/{}/git", BASE_URL, owner, repo);
        let head_ref = parse(self.get(&format!("{}/ref/heads/{}", base, branch)).await?)?;
        let head = head_ref["object"]["sha"].as_str().ok_or("ブランチの先頭が分かりませんでした")?.to_string();
        let head_commit = parse(self.get(&format!("{}/commits/{}", base, head)).await?)?;
        let base_tree = head_commit["tree"]["sha"].as_str().ok_or("ブランチの中身が分かりませんでした")?.to_string();
        let items: Vec<serde_json::Value> = files
            .iter()
            .map(|(path, content)| serde_json::json!({ "path": path, "mode": "100644", "type": "blob", "content": content }))
            .collect();
        let tree = parse(self.post(&format!("{}/trees", base), &serde_json::json!({ "base_tree": base_tree, "tree": items })).await?)?;
        let tree_sha = tree["sha"].as_str().ok_or("ファイルの一覧を作れませんでした")?.to_string();
        let commit = parse(
            self.post(&format!("{}/commits", base), &serde_json::json!({ "message": message, "tree": tree_sha, "parents": [head] }))
                .await?,
        )?;
        let sha = commit["sha"].as_str().ok_or("コミットを作れませんでした")?.to_string();
        self.patch_json(&format!("{}/refs/heads/{}", base, branch), &serde_json::json!({ "sha": sha })).await?;
        Ok(sha)
    }

    // --- 変更の履歴（タイムライン） ---

    /// Issue に起きたこと（コメント・ラベル・担当・閉じた・ほかの Issue やコミットから触れられた など）を古い順に
    pub async fn list_timeline(&self, owner: &str, repo: &str, issue_number: u32) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}/timeline?per_page=100",
            BASE_URL, owner, repo, issue_number
        );
        return self.get_all_pages(&url).await;
    }

    // --- サブイシュー（親子） ---

    /// 子の Issue の一覧（GitHub の画面と同じ並び）
    pub async fn list_sub_issues(&self, owner: &str, repo: &str, issue_number: u32) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}/sub_issues?per_page=100",
            BASE_URL, owner, repo, issue_number
        );
        return self.get_all_pages(&url).await;
    }

    /// 子にする。sub_issue_id は Issue の番号ではなく id。replace_parent なら、ほかの親から付け替える
    pub async fn add_sub_issue(
        &self,
        owner: &str,
        repo: &str,
        issue_number: u32,
        sub_issue_id: u64,
        replace_parent: bool,
    ) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}/sub_issues",
            BASE_URL, owner, repo, issue_number
        );
        let payload = serde_json::json!({ "sub_issue_id": sub_issue_id, "replace_parent": replace_parent });
        return self.post(&url, &payload).await;
    }

    /// 子から外す（親子のつながりを外すだけで、Issue は消えない）
    pub async fn remove_sub_issue(&self, owner: &str, repo: &str, issue_number: u32, sub_issue_id: u64) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/issues/{}/sub_issue",
            BASE_URL, owner, repo, issue_number
        );
        let payload = serde_json::json!({ "sub_issue_id": sub_issue_id });
        return self.delete_json(&url, &payload).await;
    }

    // --- Contents API ---

    /// ファイルの中身と sha。書いた直後に GitHub が古い版を返したときは、自分が書いた版にする（recent）
    pub async fn get_contents(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
    ) -> Result<(String, String), String> {
        let fetched = self.fetch_contents(owner, repo, path).await;
        return super::recent::correct(owner, repo, path, fetched);
    }

    async fn fetch_contents(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
    ) -> Result<(String, String), String> {
        let url = format!("{}/repos/{}/{}/contents/{}", BASE_URL, owner, repo, path);
        let resp = self.get(&url).await?;
        let json: serde_json::Value =
            serde_json::from_str(&resp).map_err(|e| e.to_string())?;

        if let Some(message) = json.get("message") {
            return Err(format!("GitHub API: {}", message));
        }

        let content_b64 = json["content"]
            .as_str()
            .ok_or("content field missing")?
            .replace('\n', "");
        let sha = json["sha"]
            .as_str()
            .ok_or("sha field missing")?
            .to_string();

        let decoded_bytes = STANDARD
            .decode(&content_b64)
            .map_err(|e| format!("base64 decode error: {}", e))?;
        let content =
            String::from_utf8(decoded_bytes).map_err(|e| format!("UTF-8 decode error: {}", e))?;

        return Ok((content, sha));
    }

    pub async fn put_contents(
        &self,
        owner: &str,
        repo: &str,
        path: &str,
        content: &str,
        message: &str,
        sha: Option<String>,
    ) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/contents/{}", BASE_URL, owner, repo, path);
        let encoded = STANDARD.encode(content.as_bytes());
        let mut payload = serde_json::json!({
            "message": message,
            "content": encoded,
        });
        if let Some(s) = &sha {
            payload["sha"] = serde_json::Value::String(s.clone());
        }
        let result = self.put(&url, &payload).await?;
        // 書いた版を覚えておく（直後に読み直したとき、GitHub がまだ古い版を返すことがあるため）
        if let Some(new_sha) = serde_json::from_str::<serde_json::Value>(&result)
            .ok()
            .and_then(|v| v["content"]["sha"].as_str().map(|s| s.to_string()))
        {
            super::recent::remember(owner, repo, path, sha.as_deref(), &new_sha, content);
        }
        return Ok(result);
    }

    // --- ページネーション対応メソッド ---

    /// 全ページを取得して結合した配列を返す（Linkヘッダーのrel="next"を辿る）
    /// 安全のため最大10ページ（1000件）で打ち切る
    pub async fn get_all_pages(&self, url: &str) -> Result<String, String> {
        const MAX_PAGES: usize = 10;
        let mut all_items: Vec<serde_json::Value> = Vec::new();
        let mut next_url: Option<String> = Some(url.to_string());
        let mut page_count: usize = 0;

        while let Some(current_url) = next_url.take() {
            page_count += 1;
            if page_count > MAX_PAGES {
                // 無限ループ防止: 最大ページ数に到達
                break;
            }

            let response = self
                .http
                .get(&current_url)
                .headers(self.build_headers().await)
                .send()
                .await
                .map_err(network_error)?;

            // Linkヘッダーから次ページURLを抽出
            let link_header = response
                .headers()
                .get("link")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let status = response.status();
            let body = response.text().await.map_err(network_error)?;

            // APIエラーレスポンスのチェック
            if !status.is_success() {
                return Err(format!("HTTP {}: {}", status, body));
            }

            // レスポンスをJSON配列としてパースして結合
            let page_items: Vec<serde_json::Value> =
                serde_json::from_str(&body).map_err(|e| format!("JSONパースエラー: {}", e))?;
            all_items.extend(page_items);

            // 次ページURLを解析
            next_url = link_header.and_then(|header| Self::parse_next_link(&header));
        }

        let result =
            serde_json::to_string(&all_items).map_err(|e| format!("JSONシリアライズエラー: {}", e))?;
        return Ok(result);
    }

    /// Linkヘッダーからrel="next"のURLを抽出する
    /// 形式: <https://api.github.com/...?page=2>; rel="next", <...>; rel="last"
    fn parse_next_link(link_header: &str) -> Option<String> {
        for part in link_header.split(',') {
            let part = part.trim();
            if part.contains("rel=\"next\"") {
                // <URL> 部分を抽出
                if let Some(start) = part.find('<') {
                    if let Some(end) = part.find('>') {
                        return Some(part[start + 1..end].to_string());
                    }
                }
            }
        }
        return None;
    }

    // --- コミットの履歴（ブランチ画面・全体図。スマホ版や、作業フォルダのない PC で使う） ---

    pub async fn get_repository(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    pub async fn list_branches(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/branches?per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    pub async fn list_tags(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/tags?per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    /// ブランチ（またはコミット）から辿れるコミットを新しい順に per_page 件
    pub async fn list_commits(&self, owner: &str, repo: &str, sha: &str, per_page: u32) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/commits?sha={}&per_page={}",
            BASE_URL,
            owner,
            repo,
            urlencoding::encode(sha),
            per_page
        );
        return self.get(&url).await;
    }

    /// 1 つのコミット（変更したファイルと、ファイルごとの差分つき）
    pub async fn get_commit(&self, owner: &str, repo: &str, sha: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/commits/{}", BASE_URL, owner, repo, urlencoding::encode(sha));
        return self.get(&url).await;
    }

    // --- User ---

    pub async fn get_authenticated_user(&self) -> Result<String, String> {
        let url = format!("{}/user", BASE_URL);
        self.get(&url).await
    }

    // --- トークンの確認・ログインしたあとのリポジトリ選び ---

    /// 状態・ヘッダ・本文をそのまま返す GET（トークンの確認で、期限のヘッダや 404・403 を見分けるため）。path は /user などの API のパス
    pub async fn get_raw(&self, path: &str) -> Result<(u16, HeaderMap, String), String> {
        let response = self
            .http
            .get(format!("{}{}", BASE_URL, path))
            .headers(self.build_headers().await)
            .send()
            .await
            .map_err(network_error)?;
        let status = response.status().as_u16();
        let headers = response.headers().clone();
        let body = response.text().await.map_err(network_error)?;
        Ok((status, headers, body))
    }

    /// 自分が使えるリポジトリ（持っている・招待された・組織の）を、更新の新しい順に
    pub async fn list_user_repos(&self) -> Result<String, String> {
        let url = format!(
            "{}/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member",
            BASE_URL
        );
        return self.get_all_pages(&url).await;
    }

    /// 「GitHub でログイン」の鍵で使えるリポジトリ（Life Manager App を入れたリポジトリのうち、自分が触れるもの）。
    /// /user/repos は、入れていない公開リポジトリも返す（読めるが書けない）ので、入れた先から数える
    pub async fn list_installed_repos(&self) -> Result<Vec<serde_json::Value>, String> {
        let mut repos = Vec::new();
        for installation in self.list_installations().await? {
            let Some(id) = installation["id"].as_u64() else { continue };
            let path = format!("/user/installations/{}/repositories?per_page=100", id);
            repos.extend(self.get_list_pages(&path, "repositories").await?);
        }
        return Ok(repos);
    }

    /// Life Manager App を入れてある先（自分のアカウント・組織）のうち、自分が触れるもの
    pub async fn list_installations(&self) -> Result<Vec<serde_json::Value>, String> {
        return self.get_list_pages("/user/installations?per_page=100", "installations").await;
    }

    /// {"total_count": n, "<key>": [...]} の形の返事を、ページをたどってつなぐ（最大 10 ページ）
    async fn get_list_pages(&self, path: &str, key: &str) -> Result<Vec<serde_json::Value>, String> {
        let mut items = Vec::new();
        for page in 1..=10 {
            let (status, _, body) = self.get_raw(&format!("{}&page={}", path, page)).await?;
            if status >= 400 {
                return Err(format!("HTTP {}: {}", status, body));
            }
            let json: serde_json::Value = serde_json::from_str(&body).map_err(|e| format!("JSONパースエラー: {}", e))?;
            let list = json[key].as_array().cloned().unwrap_or_default();
            let done = list.len() < 100;
            items.extend(list);
            if done {
                break;
            }
        }
        return Ok(items);
    }

    // --- チーム（招待・メンバー）。最初のセットアップの「チームに入る」と、設定 → チーム ---

    /// 状態と本文をそのまま返す（招待の結果を、状態で見分けるため）。path は /repos/... などの API のパス
    async fn send_raw(&self, method: reqwest::Method, path: &str, payload: Option<&serde_json::Value>) -> Result<(u16, String), String> {
        let mut request = self.http.request(method, format!("{}{}", BASE_URL, path)).headers(self.build_headers().await);
        if let Some(p) = payload {
            request = request.json(p);
        }
        let response = request.send().await.map_err(network_error)?;
        let status = response.status().as_u16();
        let body = response.text().await.map_err(network_error)?;
        Ok((status, body))
    }

    /// 自分宛ての、リポジトリへの招待
    pub async fn list_my_repo_invitations(&self) -> Result<String, String> {
        self.get_all_pages(&format!("{}/user/repository_invitations?per_page=100", BASE_URL)).await
    }

    /// 自分宛ての、組織への招待（まだ受けていないもの）。受けるのは GitHub の画面で（アプリには write:org の権限がないため）
    pub async fn list_my_org_invitations(&self) -> Result<String, String> {
        self.get_all_pages(&format!("{}/user/memberships/orgs?state=pending&per_page=100", BASE_URL)).await
    }

    /// リポジトリへの招待を受ける（accept = true）・断る
    pub async fn answer_repo_invitation(&self, id: u64, accept: bool) -> Result<(), String> {
        let url = format!("{}/user/repository_invitations/{}", BASE_URL, id);
        if accept {
            self.patch_json(&url, &serde_json::json!({})).await?;
        } else {
            self.delete(&url).await?;
        }
        Ok(())
    }

    /// 自分のリポジトリを作る（README つき。すぐ clone できるように）
    pub async fn create_user_repo(&self, name: &str, private: bool) -> Result<String, String> {
        let payload = serde_json::json!({
            "name": name,
            "private": private,
            "auto_init": true,
            "description": "Life Manager で使うリポジトリ",
        });
        self.post(&format!("{}/user/repos", BASE_URL), &payload).await
    }

    /// リポジトリの情報（自分の権限 permissions と、持ち主が組織か）
    pub async fn get_repo(&self, owner: &str, repo: &str) -> Result<String, String> {
        self.get(&format!("{}/repos/{}/{}", BASE_URL, owner, repo)).await
    }

    /// 送った招待（まだ受けていないもの。管理者だけ読める）
    pub async fn list_repo_invitations(&self, owner: &str, repo: &str) -> Result<String, String> {
        self.get_all_pages(&format!("{}/repos/{}/{}/invitations?per_page=100", BASE_URL, owner, repo)).await
    }

    /// 招待する（201 = 招待した、204 = もう使える人）。permission は組織のリポジトリのときだけ効く
    pub async fn invite_collaborator(&self, owner: &str, repo: &str, username: &str, permission: Option<&str>) -> Result<(u16, String), String> {
        let path = format!("/repos/{}/{}/collaborators/{}", owner, repo, urlencoding::encode(username));
        let payload = match permission {
            Some(p) => serde_json::json!({ "permission": p }),
            None => serde_json::json!({}),
        };
        self.send_raw(reqwest::Method::PUT, &path, Some(&payload)).await
    }

    /// その名前の人が GitHub にいるか（招待できなかったとき、理由を見分けるため）
    pub async fn user_exists(&self, username: &str) -> Result<bool, String> {
        let (status, _) = self.send_raw(reqwest::Method::GET, &format!("/users/{}", urlencoding::encode(username)), None).await?;
        Ok(status != 404)
    }

    /// 送った招待を取り消す
    pub async fn cancel_repo_invitation(&self, owner: &str, repo: &str, id: u64) -> Result<(), String> {
        self.delete(&format!("{}/repos/{}/{}/invitations/{}", BASE_URL, owner, repo, id)).await?;
        Ok(())
    }

    /// メンバーを外す（リポジトリの直接のメンバーから。組織のリポジトリでは、組織のメンバーとしての権限は残る）
    pub async fn remove_collaborator(&self, owner: &str, repo: &str, username: &str) -> Result<(), String> {
        self.delete(&format!("{}/repos/{}/{}/collaborators/{}", BASE_URL, owner, repo, urlencoding::encode(username))).await?;
        Ok(())
    }

    // --- プルリク ---

    /// プルリクの一覧（開いている・閉じた・マージした、すべて。更新の新しい順）
    pub async fn list_pulls(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/pulls?state=all&sort=updated&direction=desc&per_page=100",
            BASE_URL, owner, repo
        );
        return self.get_all_pages(&url).await;
    }

    /// このリポジトリのブランチから出したプルリク（すべての状態。新しい順）
    pub async fn list_pulls_from(&self, owner: &str, repo: &str, branch: &str) -> Result<String, String> {
        let head = format!("{}:{}", owner, branch);
        let url = format!(
            "{}/repos/{}/{}/pulls?state=all&head={}&per_page=20",
            BASE_URL,
            owner,
            repo,
            urlencoding::encode(&head)
        );
        return self.get(&url).await;
    }

    pub async fn get_pull(&self, owner: &str, repo: &str, number: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}", BASE_URL, owner, repo, number);
        return self.get(&url).await;
    }

    /// 変更したファイル（ファイルごとの差分つき。大きいファイルは GitHub が差分を省く）
    pub async fn list_pull_files(&self, owner: &str, repo: &str, number: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/files?per_page=100", BASE_URL, owner, repo, number);
        return self.get_all_pages(&url).await;
    }

    pub async fn list_pull_commits(&self, owner: &str, repo: &str, number: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/commits?per_page=100", BASE_URL, owner, repo, number);
        return self.get_all_pages(&url).await;
    }

    /// レビュー（承認・修正の依頼・コメント）を古い順に
    pub async fn list_pull_reviews(&self, owner: &str, repo: &str, number: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/reviews?per_page=100", BASE_URL, owner, repo, number);
        return self.get_all_pages(&url).await;
    }

    /// 行に付けたコメント（レビューのコメント）
    pub async fn list_pull_review_comments(&self, owner: &str, repo: &str, number: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/comments?per_page=100", BASE_URL, owner, repo, number);
        return self.get_all_pages(&url).await;
    }

    pub async fn create_pull(
        &self,
        owner: &str,
        repo: &str,
        title: &str,
        head: &str,
        base: &str,
        body: &str,
        draft: bool,
    ) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls", BASE_URL, owner, repo);
        let payload = serde_json::json!({ "title": title, "head": head, "base": base, "body": body, "draft": draft });
        return self.post(&url, &payload).await;
    }

    /// 題名・本文・状態（open / closed）を変える
    pub async fn update_pull(&self, owner: &str, repo: &str, number: u64, payload: &serde_json::Value) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}", BASE_URL, owner, repo, number);
        return self.patch_json(&url, payload).await;
    }

    /// マージする。method は merge / squash / rebase。sha は見ていたときのブランチの先頭（そのあいだに変わっていたら GitHub が断る）
    pub async fn merge_pull(&self, owner: &str, repo: &str, number: u64, method: &str, sha: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/merge", BASE_URL, owner, repo, number);
        let payload = serde_json::json!({ "merge_method": method, "sha": sha });
        return self.put(&url, &payload).await;
    }

    /// レビューを送る。event は APPROVE / REQUEST_CHANGES / COMMENT
    pub async fn create_review(&self, owner: &str, repo: &str, number: u64, event: &str, body: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/reviews", BASE_URL, owner, repo, number);
        let payload = serde_json::json!({ "event": event, "body": body });
        return self.post(&url, &payload).await;
    }

    /// 差分の行にコメントを付ける。side は RIGHT（変えたあとの行）/ LEFT（消した行）
    pub async fn create_review_comment(
        &self,
        owner: &str,
        repo: &str,
        number: u64,
        commit_id: &str,
        path: &str,
        line: u64,
        side: &str,
        body: &str,
    ) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/comments", BASE_URL, owner, repo, number);
        let payload = serde_json::json!({ "body": body, "commit_id": commit_id, "path": path, "line": line, "side": side });
        return self.post(&url, &payload).await;
    }

    pub async fn request_reviewers(&self, owner: &str, repo: &str, number: u64, reviewers: &[String]) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/requested_reviewers", BASE_URL, owner, repo, number);
        return self.post(&url, &serde_json::json!({ "reviewers": reviewers })).await;
    }

    pub async fn remove_reviewers(&self, owner: &str, repo: &str, number: u64, reviewers: &[String]) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/requested_reviewers", BASE_URL, owner, repo, number);
        return self.delete_json(&url, &serde_json::json!({ "reviewers": reviewers })).await;
    }

    /// 入れる先のブランチの新しいコミットを、プルリクのブランチに取り込む（GitHub の「Update branch」）
    pub async fn update_pull_branch(&self, owner: &str, repo: &str, number: u64, head_sha: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls/{}/update-branch", BASE_URL, owner, repo, number);
        return self.put(&url, &serde_json::json!({ "expected_head_sha": head_sha })).await;
    }

    /// 2 つのブランチの違い（base に無くて head にあるコミットと、変更したファイル）
    pub async fn compare(&self, owner: &str, repo: &str, base: &str, head: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/compare/{}...{}", BASE_URL, owner, repo, encode_ref(base), encode_ref(head));
        return self.get(&url).await;
    }

    /// GitHub のブランチを消す（マージしたあとの片づけ）
    pub async fn delete_branch_ref(&self, owner: &str, repo: &str, branch: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/git/refs/heads/{}", BASE_URL, owner, repo, encode_ref(branch));
        return self.delete(&url).await;
    }

    /// GitHub にブランチを作る（消したブランチを戻す）
    pub async fn create_branch_ref(&self, owner: &str, repo: &str, branch: &str, sha: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/git/refs", BASE_URL, owner, repo);
        let payload = serde_json::json!({ "ref": format!("refs/heads/{}", branch), "sha": sha });
        return self.post(&url, &payload).await;
    }

    /// GitHub にこのブランチがあるか
    pub async fn branch_exists(&self, owner: &str, repo: &str, branch: &str) -> Result<bool, String> {
        let (status, _, body) = self.get_raw(&format!("/repos/{}/{}/branches/{}", owner, repo, encode_ref(branch))).await?;
        match status {
            200 => Ok(true),
            404 => Ok(false),
            _ => Err(format!("HTTP {}: {}", status, body)),
        }
    }

    /// GraphQL（REST にない操作: 下書きとレビューのお願いの切り替え）。GitHub のエラーは Err にする
    pub async fn graphql(&self, query: &str, variables: serde_json::Value) -> Result<serde_json::Value, String> {
        let url = format!("{}/graphql", BASE_URL);
        let text = self.post(&url, &serde_json::json!({ "query": query, "variables": variables })).await?;
        let json: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("JSONパースエラー: {}", e))?;
        if let Some(errors) = json["errors"].as_array() {
            let messages: Vec<&str> = errors.iter().filter_map(|e| e["message"].as_str()).collect();
            return Err(format!("GraphQL: {}", messages.join(" / ")));
        }
        return Ok(json["data"].clone());
    }

    // --- Actions・チェック・セキュリティ ---

    /// ワークフローの実行（新しい順に 100 件）
    pub async fn list_runs(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/actions/runs?per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    pub async fn list_workflows(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/actions/workflows?per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    /// 1 つの実行のジョブとステップ（もう一度動かしたときは、最後の分だけ）
    pub async fn list_run_jobs(&self, owner: &str, repo: &str, run_id: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/actions/runs/{}/jobs?per_page=100&filter=latest", BASE_URL, owner, repo, run_id);
        return self.get(&url).await;
    }

    /// ジョブのログ（ただの文字。GitHub は別の場所へ案内するので、そこから読む）
    pub async fn job_log(&self, owner: &str, repo: &str, job_id: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/actions/jobs/{}/logs", BASE_URL, owner, repo, job_id);
        return self.get(&url).await;
    }

    /// もう一度動かす（failed_only なら失敗したジョブだけ）
    pub async fn rerun_run(&self, owner: &str, repo: &str, run_id: u64, failed_only: bool) -> Result<String, String> {
        let url = format!(
            "{}/repos/{}/{}/actions/runs/{}/{}",
            BASE_URL,
            owner,
            repo,
            run_id,
            if failed_only { "rerun-failed-jobs" } else { "rerun" }
        );
        return self.post(&url, &serde_json::json!({})).await;
    }

    pub async fn cancel_run(&self, owner: &str, repo: &str, run_id: u64) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/actions/runs/{}/cancel", BASE_URL, owner, repo, run_id);
        return self.post(&url, &serde_json::json!({})).await;
    }

    /// 手で実行（workflow_dispatch）。git_ref はブランチの名前
    pub async fn dispatch_workflow(&self, owner: &str, repo: &str, workflow_id: u64, git_ref: &str, inputs: &serde_json::Value) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/actions/workflows/{}/dispatches", BASE_URL, owner, repo, workflow_id);
        return self.post(&url, &serde_json::json!({ "ref": git_ref, "inputs": inputs })).await;
    }

    /// 保護ルールのあるブランチ
    pub async fn list_protected_branches(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/branches?protected=true&per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    pub async fn list_open_pulls(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/pulls?state=open&per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    /// Dependabot のお知らせを有効にする（管理者だけ。Administration の権限）
    pub async fn enable_vulnerability_alerts(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/vulnerability-alerts", BASE_URL, owner, repo);
        return self.put(&url, &serde_json::json!({})).await;
    }

    /// Dependabot のお知らせ（開いているもの）
    pub async fn dependabot_alerts(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/dependabot/alerts?state=open&per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    /// コードスキャンのお知らせ（開いているもの）
    pub async fn code_scanning_alerts(&self, owner: &str, repo: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/code-scanning/alerts?state=open&per_page=100", BASE_URL, owner, repo);
        return self.get(&url).await;
    }

    /// コミットのチェック（Actions などが付ける結果）
    pub async fn check_runs(&self, owner: &str, repo: &str, sha: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/commits/{}/check-runs?per_page=100", BASE_URL, owner, repo, sha);
        return self.get(&url).await;
    }

    /// コミットの状態（外の CI などが付ける結果）
    pub async fn commit_status(&self, owner: &str, repo: &str, sha: &str) -> Result<String, String> {
        let url = format!("{}/repos/{}/{}/commits/{}/status", BASE_URL, owner, repo, sha);
        return self.get(&url).await;
    }

    // --- HTTP共通メソッド ---

    async fn get(&self, url: &str) -> Result<String, String> {
        let response = self
            .http
            .get(url)
            .headers(self.build_headers().await)
            .send()
            .await
            .map_err(network_error)?;

        let status = response.status();
        let body = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, body));
        }
        return Ok(body);
    }

    async fn post(&self, url: &str, payload: &serde_json::Value) -> Result<String, String> {
        let response = self
            .http
            .post(url)
            .headers(self.build_headers().await)
            .json(payload)
            .send()
            .await
            .map_err(network_error)?;

        let status = response.status();
        let result = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn patch(
        &self,
        url: &str,
        payload: &serde_json::Map<String, serde_json::Value>,
    ) -> Result<String, String> {
        let response = self
            .http
            .patch(url)
            .headers(self.build_headers().await)
            .json(payload)
            .send()
            .await
            .map_err(network_error)?;

        let status = response.status();
        let result = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn patch_json(&self, url: &str, payload: &serde_json::Value) -> Result<String, String> {
        let response = self
            .http
            .patch(url)
            .headers(self.build_headers().await)
            .json(payload)
            .send()
            .await
            .map_err(network_error)?;

        let status = response.status();
        let result = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn delete(&self, url: &str) -> Result<String, String> {
        let response = self
            .http
            .delete(url)
            .headers(self.build_headers().await)
            .send()
            .await
            .map_err(network_error)?;

        let status = response.status();
        let result = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    /// 送る中身のある DELETE（サブイシューを外すときなど）
    async fn delete_json(&self, url: &str, payload: &serde_json::Value) -> Result<String, String> {
        let response = self
            .http
            .delete(url)
            .headers(self.build_headers().await)
            .json(payload)
            .send()
            .await
            .map_err(network_error)?;

        let status = response.status();
        let result = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn put(&self, url: &str, payload: &serde_json::Value) -> Result<String, String> {
        let response = self
            .http
            .put(url)
            .headers(self.build_headers().await)
            .json(payload)
            .send()
            .await
            .map_err(network_error)?;

        let status = response.status();
        let result = response.text().await.map_err(network_error)?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn build_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let auth = format!("Bearer {}", self.current_token().await);
        // トークンに使えない文字（全角など）が混じっていても落ちないように（そのときは認証なしで送り、401 になる）
        if let Ok(value) = HeaderValue::from_str(&auth) {
            headers.insert(AUTHORIZATION, value);
        }
        headers.insert(USER_AGENT, HeaderValue::from_static("life-manager"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );
        return headers;
    }
}
