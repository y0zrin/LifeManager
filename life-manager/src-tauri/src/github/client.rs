use base64::{Engine, engine::general_purpose::STANDARD};
use reqwest::header::{HeaderMap, HeaderValue, ACCEPT, AUTHORIZATION, USER_AGENT};

const BASE_URL: &str = "https://api.github.com";

#[derive(Clone)]
pub struct GitHubClient {
    http: reqwest::Client,
    token: String,
}

impl GitHubClient {
    pub fn new(token: String) -> GitHubClient {
        return GitHubClient {
            http: reqwest::Client::new(),
            token: token,
        };
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
            payload.insert("milestone".to_string(), serde_json::json!(m));
        }
        if let Some(a) = assignees {
            payload.insert("assignees".to_string(), serde_json::json!(a));
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

    // --- Contents API ---

    pub async fn get_contents(
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
        if let Some(s) = sha {
            payload["sha"] = serde_json::Value::String(s);
        }
        return self.put(&url, &payload).await;
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
                .headers(self.build_headers())
                .send()
                .await
                .map_err(|e| e.to_string())?;

            // Linkヘッダーから次ページURLを抽出
            let link_header = response
                .headers()
                .get("link")
                .and_then(|v| v.to_str().ok())
                .map(|s| s.to_string());

            let status = response.status();
            let body = response.text().await.map_err(|e| e.to_string())?;

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

    // --- User ---

    pub async fn get_authenticated_user(&self) -> Result<String, String> {
        let url = format!("{}/user", BASE_URL);
        self.get(&url).await
    }

    // --- HTTP共通メソッド ---

    async fn get(&self, url: &str) -> Result<String, String> {
        let response = self
            .http
            .get(url)
            .headers(self.build_headers())
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let body = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, body));
        }
        return Ok(body);
    }

    async fn post(&self, url: &str, payload: &serde_json::Value) -> Result<String, String> {
        let response = self
            .http
            .post(url)
            .headers(self.build_headers())
            .json(payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let result = response.text().await.map_err(|e| e.to_string())?;
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
            .headers(self.build_headers())
            .json(payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let result = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn patch_json(&self, url: &str, payload: &serde_json::Value) -> Result<String, String> {
        let response = self
            .http
            .patch(url)
            .headers(self.build_headers())
            .json(payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let result = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn delete(&self, url: &str) -> Result<String, String> {
        let response = self
            .http
            .delete(url)
            .headers(self.build_headers())
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let result = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    async fn put(&self, url: &str, payload: &serde_json::Value) -> Result<String, String> {
        let response = self
            .http
            .put(url)
            .headers(self.build_headers())
            .json(payload)
            .send()
            .await
            .map_err(|e| e.to_string())?;

        let status = response.status();
        let result = response.text().await.map_err(|e| e.to_string())?;
        if !status.is_success() {
            return Err(format!("HTTP {}: {}", status, result));
        }
        return Ok(result);
    }

    fn build_headers(&self) -> HeaderMap {
        let mut headers = HeaderMap::new();
        let auth = format!("Bearer {}", self.token);
        headers.insert(AUTHORIZATION, HeaderValue::from_str(&auth).unwrap());
        headers.insert(USER_AGENT, HeaderValue::from_static("life-manager"));
        headers.insert(
            ACCEPT,
            HeaderValue::from_static("application/vnd.github+json"),
        );
        return headers;
    }
}
