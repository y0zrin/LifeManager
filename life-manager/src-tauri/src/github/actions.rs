//! Actions（実行・ジョブ・ログ・もう一度実行・手で実行）と、コミットのチェック・セキュリティのお知らせ。
//! どれを先に直すか（解決する順の山）は画面で決める（lib/actions.ts）。ここは GitHub の大きな JSON を小さな形にする
use super::client::{is_network_error, GitHubClient};
use super::errors::{self, Permission};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::sync::Mutex;

type ClientState<'a> = tauri::State<'a, Mutex<Option<GitHubClient>>>;

async fn client_of(state: &ClientState<'_>) -> Result<GitHubClient, String> {
    let guard = state.lock().await;
    return Ok(guard.as_ref().ok_or("トークンが未設定です")?.clone());
}

fn parse(text: &str) -> Result<Value, String> {
    serde_json::from_str(text).map_err(|e| format!("JSONパースエラー: {}", e))
}

// --- エラーの言いかえ ---

const ACTIONS: Permission = Permission { name: "Actions", access: "Read and write" };
const CHECKS: Permission = Permission { name: "Checks", access: "Read-only" };
const DEPENDABOT: Permission = Permission { name: "Dependabot alerts", access: "Read-only" };
const CODE_SCANNING: Permission = Permission { name: "Code scanning alerts", access: "Read-only" };

const KNOWN: &[(&str, &str)] = &[
    ("does not have 'workflow_dispatch' trigger", "このワークフローは手で動かせません（ファイルに workflow_dispatch がありません）"),
    ("Unexpected inputs provided", "ワークフローにない入力があります。ワークフローを読み直してから、もう一度"),
    ("Required input", "入れなければいけない入力があります"),
    ("No ref found for", "そのブランチが GitHub にありません。先にプッシュします"),
    ("Cannot cancel a workflow run that is completed", "もう終わっているので、止められません"),
    ("cannot be rerun", "この実行は、もう一度動かせません（古すぎる・動いている途中 など）"),
    ("This workflow run is not re-runnable", "この実行は、もう一度動かせません（古すぎる・動いている途中 など）"),
    ("already running", "もう動いています。終わるのを待ってから、もう一度"),
    ("Actions has been disabled", "このリポジトリでは Actions が止められています（GitHub の Settings → Actions で使えるようにします）"),
];

fn explain(err: &str, what: &str) -> String {
    errors::explain(err, what, &ACTIONS, KNOWN)
}

// --- 画面で使う形 ---

fn person(v: &Value) -> Value {
    if v.is_null() {
        return Value::Null;
    }
    json!({ "login": v["login"], "avatar_url": v["avatar_url"] })
}

fn first_line(v: &Value) -> Value {
    json!(v.as_str().unwrap_or("").lines().next().unwrap_or(""))
}

/// 実行 1 つ。full_name は「持ち主/名前」（フォークから来た実行を見分ける）
fn compact_run(r: &Value, full_name: &str) -> Value {
    let head_repo = r["head_repository"]["full_name"].as_str().unwrap_or(full_name);
    json!({
        "id": r["id"],
        "name": r["name"],
        "title": r["display_title"],
        "workflow_id": r["workflow_id"],
        "path": r["path"],
        "branch": r["head_branch"],
        "sha": r["head_sha"],
        // push / pull_request / schedule / workflow_dispatch など
        "event": r["event"],
        // queued / in_progress / waiting / requested / pending / completed
        "status": r["status"],
        // success / failure / cancelled / skipped / timed_out / action_required / neutral / stale / startup_failure（終わるまで null）
        "conclusion": r["conclusion"],
        "run_number": r["run_number"],
        "run_attempt": r["run_attempt"],
        "actor": person(&r["actor"]),
        "created_at": r["created_at"],
        "updated_at": r["updated_at"],
        "started_at": r["run_started_at"],
        "html_url": r["html_url"],
        "pulls": r["pull_requests"].as_array().map(|a| a.iter().filter_map(|p| p["number"].as_u64()).collect::<Vec<_>>()).unwrap_or_default(),
        "fork": !head_repo.eq_ignore_ascii_case(full_name),
        "commit_message": first_line(&r["head_commit"]["message"]),
        "commit_author": r["head_commit"]["author"]["name"],
    })
}

fn compact_job(j: &Value) -> Value {
    let steps: Vec<Value> = j["steps"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|s| {
                    json!({
                        "number": s["number"],
                        "name": s["name"],
                        "status": s["status"],
                        "conclusion": s["conclusion"],
                        "started_at": s["started_at"],
                        "completed_at": s["completed_at"],
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({
        "id": j["id"],
        "run_id": j["run_id"],
        "name": j["name"],
        "status": j["status"],
        "conclusion": j["conclusion"],
        "started_at": j["started_at"],
        "completed_at": j["completed_at"],
        "html_url": j["html_url"],
        "labels": j["labels"],
        "steps": steps,
    })
}

fn compact_dependabot(a: &Value) -> Value {
    json!({
        "number": a["number"],
        // critical / high / medium / low
        "severity": a["security_advisory"]["severity"].as_str().or(a["security_vulnerability"]["severity"].as_str()),
        "package": a["dependency"]["package"]["name"],
        "ecosystem": a["dependency"]["package"]["ecosystem"],
        "manifest": a["dependency"]["manifest_path"],
        "summary": a["security_advisory"]["summary"],
        "vulnerable": a["security_vulnerability"]["vulnerable_version_range"],
        "fixed": a["security_vulnerability"]["first_patched_version"]["identifier"],
        "cve": a["security_advisory"]["cve_id"],
        "ghsa": a["security_advisory"]["ghsa_id"],
        "html_url": a["html_url"],
        "created_at": a["created_at"],
    })
}

fn compact_code_scanning(a: &Value) -> Value {
    let rule = &a["rule"];
    let instance = &a["most_recent_instance"];
    json!({
        "number": a["number"],
        // セキュリティの重さ（critical / high / medium / low）。なければ error / warning / note
        "severity": rule["security_severity_level"].as_str().or(rule["severity"].as_str()),
        "rule": rule["description"].as_str().or(rule["name"].as_str()).or(rule["id"].as_str()),
        "tool": a["tool"]["name"],
        "path": instance["location"]["path"],
        "line": instance["location"]["start_line"],
        "message": instance["message"]["text"],
        "html_url": a["html_url"],
        "created_at": a["created_at"],
    })
}

/// セキュリティのお知らせを読んだ結果。使っていない（off）・権限がない（forbidden）も、画面で案内できるように分ける
fn security_state(result: Result<String, String>, compact: fn(&Value) -> Value, permission: &Permission, what: &str) -> Value {
    match result {
        Ok(text) => match parse(&text) {
            Ok(v) => json!({ "state": "ok", "alerts": v.as_array().map(|a| a.iter().map(compact).collect::<Vec<_>>()).unwrap_or_default() }),
            Err(e) => json!({ "state": "error", "message": e }),
        },
        Err(e) => {
            let message = errors::github_message(&e);
            if e.contains("not accessible by") {
                json!({ "state": "forbidden", "message": errors::explain(&e, what, permission, &[]) })
            } else if is_network_error(&e) {
                json!({ "state": "error", "message": e })
            } else if message.contains("disabled")
                || message.contains("not enabled")
                || message.contains("no analysis found")
                || message.contains("Advanced Security")
                || e.starts_with("HTTP 404")
            {
                json!({ "state": "off", "message": message })
            } else {
                json!({ "state": "error", "message": errors::explain(&e, what, permission, &[]) })
            }
        }
    }
}

/// ログの 1 行の頭の時刻（2026-09-29T10:00:00.1234567Z ）を外す
fn strip_time(line: &str) -> &str {
    let b = line.as_bytes();
    if b.len() > 21 && b[4] == b'-' && b[7] == b'-' && b[10] == b'T' {
        if let Some(pos) = line[..line.len().min(40)].find("Z ") {
            return &line[pos + 2..];
        }
    }
    line
}

/// ログを行にする（時刻を外す。長すぎるときは後ろの max 行だけ。エラーはたいてい最後の方にある）
fn clean_log(text: &str, max: usize) -> (Vec<String>, bool) {
    let text = text.trim_start_matches('\u{feff}');
    let lines: Vec<&str> = text.lines().collect();
    let start = lines.len().saturating_sub(max);
    (lines[start..].iter().map(|l| strip_time(l).to_string()).collect(), start > 0)
}

fn scalar(v: &serde_yaml::Value) -> Option<String> {
    match v {
        serde_yaml::Value::String(s) => Some(s.clone()),
        serde_yaml::Value::Bool(b) => Some(b.to_string()),
        serde_yaml::Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// ワークフローのファイルから、手で実行（workflow_dispatch）の入力を読む。手で実行できなければ None
fn dispatch_inputs(yaml: &str) -> Option<Vec<Value>> {
    let doc: serde_yaml::Value = serde_yaml::from_str(yaml).ok()?;
    // YAML 1.1 の読み方では on が true になることがあるので、両方を見る
    let on = doc.get("on").or_else(|| doc.get(serde_yaml::Value::Bool(true)))?;
    match on {
        serde_yaml::Value::String(s) => (s == "workflow_dispatch").then(Vec::new),
        serde_yaml::Value::Sequence(list) => list.iter().any(|v| v.as_str() == Some("workflow_dispatch")).then(Vec::new),
        serde_yaml::Value::Mapping(map) => {
            let dispatch = map.get("workflow_dispatch")?;
            let mut out = Vec::new();
            if let Some(inputs) = dispatch.get("inputs").and_then(|i| i.as_mapping()) {
                for (name, spec) in inputs {
                    let Some(name) = scalar(name) else { continue };
                    out.push(json!({
                        "name": name,
                        "description": spec.get("description").and_then(scalar),
                        "required": spec.get("required").and_then(|r| r.as_bool()).unwrap_or(false),
                        "default": spec.get("default").and_then(scalar),
                        // string / boolean / choice / number / environment
                        "type": spec.get("type").and_then(scalar).unwrap_or_else(|| "string".into()),
                        "options": spec.get("options").and_then(|o| o.as_sequence()).map(|s| s.iter().filter_map(scalar).collect::<Vec<_>>()).unwrap_or_default(),
                    }));
                }
            }
            Some(out)
        }
        _ => None,
    }
}

fn names(list: &Value) -> Vec<String> {
    list.as_array().map(|a| a.iter().filter_map(|b| b["name"].as_str().map(String::from)).collect()).unwrap_or_default()
}

/// チェックの結果をまとめる（成功・失敗・動いている）
pub(crate) fn check_summary(checks: &Value) -> Value {
    let (mut success, mut failure, mut pending) = (0, 0, 0);
    for c in checks["check_runs"].as_array().into_iter().flatten() {
        if c["status"] != "completed" {
            pending += 1;
            continue;
        }
        match c["conclusion"].as_str().unwrap_or("") {
            "success" | "neutral" | "skipped" => success += 1,
            "failure" | "timed_out" | "action_required" | "startup_failure" => failure += 1,
            _ => {}
        }
    }
    json!({ "success": success, "failure": failure, "pending": pending })
}

fn compact_check(c: &Value) -> Value {
    let summary = c["output"]["summary"].as_str().unwrap_or("");
    json!({
        "id": c["id"],
        "name": c["name"],
        "status": c["status"],
        "conclusion": c["conclusion"],
        "started_at": c["started_at"],
        "completed_at": c["completed_at"],
        "html_url": c["html_url"],
        "details_url": c["details_url"],
        "app": c["app"]["name"],
        "title": c["output"]["title"],
        "summary": summary.chars().take(300).collect::<String>(),
    })
}

// --- 画面から呼ぶコマンド ---

/// 解決する順の山のもと: 実行（100 件）・ブランチ・保護されたブランチ・開いているプルリク・セキュリティのお知らせ
#[tauri::command]
pub async fn actions_overview(state: ClientState<'_>, owner: String, repo: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let full_name = format!("{}/{}", owner, repo);
    let (runs, info, branches, protected, pulls, dependabot, code_scanning) = tokio::join!(
        client.list_runs(&owner, &repo),
        client.get_repository(&owner, &repo),
        client.list_branches(&owner, &repo),
        client.list_protected_branches(&owner, &repo),
        client.list_open_pulls(&owner, &repo),
        client.dependabot_alerts(&owner, &repo),
        client.code_scanning_alerts(&owner, &repo),
    );
    let runs = parse(&runs.map_err(|e| explain(&e, "Actions の実行を読むこと"))?)?;
    let info = parse(&info.map_err(|e| explain(&e, "リポジトリを読むこと"))?)?;
    let branches = branches.ok().and_then(|t| parse(&t).ok()).map(|v| names(&v));
    let protected = protected.ok().and_then(|t| parse(&t).ok()).map(|v| names(&v)).unwrap_or_default();
    // プルリクの権限がなければ null（そのときは、実行に付いているプルリクの番号だけで見分ける）
    let pulls = pulls.ok().and_then(|t| parse(&t).ok()).map(|v| {
        v.as_array()
            .map(|a| {
                a.iter()
                    .map(|p| json!({ "number": p["number"], "title": p["title"], "head": p["head"]["ref"], "head_sha": p["head"]["sha"], "draft": p["draft"] }))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default()
    });
    Ok(json!({
        "default_branch": info["default_branch"],
        "can_push": info["permissions"]["push"].as_bool().unwrap_or(false),
        "branches": branches,
        "protected": protected,
        "pulls": pulls,
        "runs": runs["workflow_runs"].as_array().map(|a| a.iter().map(|r| compact_run(r, &full_name)).collect::<Vec<_>>()).unwrap_or_default(),
        "dependabot": security_state(dependabot, compact_dependabot, &DEPENDABOT, "Dependabot のお知らせを読むこと"),
        "code_scanning": security_state(code_scanning, compact_code_scanning, &CODE_SCANNING, "コードスキャンのお知らせを読むこと"),
    }))
}

/// ワークフローの一覧。手で実行できるもの（workflow_dispatch）には、入力の一覧（dispatch）を付ける
#[tauri::command]
pub async fn actions_workflows(state: ClientState<'_>, owner: String, repo: String) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let list = parse(&client.list_workflows(&owner, &repo).await.map_err(|e| explain(&e, "ワークフローを読むこと"))?)?;
    let workflows = list["workflows"].as_array().cloned().unwrap_or_default();
    let mut tasks = tokio::task::JoinSet::new();
    for (i, w) in workflows.iter().enumerate() {
        let path = w["path"].as_str().unwrap_or("").to_string();
        let (c, o, r) = (client.clone(), owner.clone(), repo.clone());
        tasks.spawn(async move { (i, if path.ends_with(".yml") || path.ends_with(".yaml") { c.read_text(&o, &r, &path).await.ok() } else { None }) });
    }
    let mut texts: HashMap<usize, String> = HashMap::new();
    while let Some(done) = tasks.join_next().await {
        if let Ok((i, Some(text))) = done {
            texts.insert(i, text);
        }
    }
    Ok(workflows
        .iter()
        .enumerate()
        .map(|(i, w)| {
            json!({
                "id": w["id"],
                "name": w["name"],
                "path": w["path"],
                // active / disabled_manually / disabled_inactivity など
                "state": w["state"],
                "html_url": w["html_url"],
                "dispatch": texts.get(&i).and_then(|t| dispatch_inputs(t)),
            })
        })
        .collect())
}

#[tauri::command]
pub async fn run_jobs(state: ClientState<'_>, owner: String, repo: String, run_id: u64) -> Result<Vec<Value>, String> {
    let client = client_of(&state).await?;
    let jobs = parse(&client.list_run_jobs(&owner, &repo, run_id).await.map_err(|e| explain(&e, "ジョブを読むこと"))?)?;
    Ok(jobs["jobs"].as_array().map(|a| a.iter().map(compact_job).collect()).unwrap_or_default())
}

/// ジョブのログ（時刻を外した行。長いときは後ろの 5000 行）
#[tauri::command]
pub async fn job_log(state: ClientState<'_>, owner: String, repo: String, job_id: u64) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let text = client.job_log(&owner, &repo, job_id).await.map_err(|e| {
        if e.starts_with("HTTP 410") || e.contains("expired") {
            "ログは、もう残っていません（GitHub が一定の日数で消します）".to_string()
        } else {
            explain(&e, "ログを読むこと")
        }
    })?;
    let (lines, truncated) = clean_log(&text, 5000);
    Ok(json!({ "lines": lines, "truncated": truncated }))
}

/// もう一度動かす（failed_only なら失敗したジョブだけ）
#[tauri::command]
pub async fn rerun_run(state: ClientState<'_>, owner: String, repo: String, run_id: u64, failed_only: bool) -> Result<(), String> {
    let client = client_of(&state).await?;
    client.rerun_run(&owner, &repo, run_id, failed_only).await.map_err(|e| explain(&e, "もう一度動かすこと"))?;
    Ok(())
}

#[tauri::command]
pub async fn cancel_run(state: ClientState<'_>, owner: String, repo: String, run_id: u64) -> Result<(), String> {
    let client = client_of(&state).await?;
    client.cancel_run(&owner, &repo, run_id).await.map_err(|e| explain(&e, "止めること"))?;
    Ok(())
}

/// 手で実行（workflow_dispatch）。inputs は {名前: 値}（値は文字）
#[tauri::command]
pub async fn dispatch_workflow(state: ClientState<'_>, owner: String, repo: String, workflow_id: u64, git_ref: String, inputs: Value) -> Result<(), String> {
    let client = client_of(&state).await?;
    client
        .dispatch_workflow(&owner, &repo, workflow_id, &git_ref, &inputs)
        .await
        .map_err(|e| explain(&e, "手で実行すること"))?;
    Ok(())
}

/// コミットのチェック（プルリクの「チェック」タブ）: Actions などのチェックと、外の CI の状態
#[tauri::command]
pub async fn commit_checks(state: ClientState<'_>, owner: String, repo: String, sha: String) -> Result<Value, String> {
    let client = client_of(&state).await?;
    let (checks, status) = tokio::join!(client.check_runs(&owner, &repo, &sha), client.commit_status(&owner, &repo, &sha));
    let checks = parse(&checks.map_err(|e| errors::explain(&e, "チェックを読むこと", &CHECKS, &[]))?)?;
    let statuses: Vec<Value> = status
        .ok()
        .and_then(|t| parse(&t).ok())
        .and_then(|v| v["statuses"].as_array().cloned())
        .unwrap_or_default()
        .iter()
        .map(|s| json!({ "context": s["context"], "state": s["state"], "description": s["description"], "target_url": s["target_url"], "updated_at": s["updated_at"] }))
        .collect();
    Ok(json!({
        "checks": checks["check_runs"].as_array().map(|a| a.iter().map(compact_check).collect::<Vec<_>>()).unwrap_or_default(),
        "statuses": statuses,
    }))
}

/// いくつかのコミットのチェックのまとめ（プルリクの一覧の印。多くても 30 件）
#[tauri::command]
pub async fn commits_checks(state: ClientState<'_>, owner: String, repo: String, shas: Vec<String>) -> Result<HashMap<String, Value>, String> {
    let client = client_of(&state).await?;
    let mut tasks = tokio::task::JoinSet::new();
    for sha in shas.into_iter().take(30) {
        let (c, o, r) = (client.clone(), owner.clone(), repo.clone());
        tasks.spawn(async move {
            let result = c.check_runs(&o, &r, &sha).await;
            (sha, result)
        });
    }
    let mut out = HashMap::new();
    while let Some(done) = tasks.join_next().await {
        if let Ok((sha, Ok(text))) = done {
            if let Ok(v) = parse(&text) {
                out.insert(sha, check_summary(&v));
            }
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_dispatch_inputs_from_the_workflow_file() {
        let map = "name: 手で動かす\non:\n  push:\n    branches: [main]\n  workflow_dispatch:\n    inputs:\n      level:\n        description: どこまで\n        required: true\n        default: warning\n        type: choice\n        options: [info, warning, debug]\n      dry:\n        type: boolean\n        default: false\njobs: {}\n";
        let inputs = dispatch_inputs(map).expect("手で動かせる");
        assert_eq!(inputs.len(), 2);
        assert_eq!(inputs[0]["name"], "level");
        assert_eq!(inputs[0]["required"], true);
        assert_eq!(inputs[0]["options"], json!(["info", "warning", "debug"]));
        assert_eq!(inputs[1]["type"], "boolean");
        assert_eq!(inputs[1]["default"], "false");

        assert_eq!(dispatch_inputs("on: workflow_dispatch\njobs: {}\n"), Some(vec![]));
        assert_eq!(dispatch_inputs("on: [push, workflow_dispatch]\n"), Some(vec![]));
        assert_eq!(dispatch_inputs("on:\n  workflow_dispatch:\n"), Some(vec![]));
        assert_eq!(dispatch_inputs("on: [push, pull_request]\n"), None);
        assert_eq!(dispatch_inputs("on: push\n"), None);
        assert_eq!(dispatch_inputs("これは YAML ではない: [\n"), None);
    }

    #[test]
    fn strips_times_from_the_log() {
        let text = "\u{feff}2026-09-29T10:00:00.1234567Z ##[group]Run npm test\n2026-09-29T10:00:01.0000000Z FAIL src/a.test.ts\nplain line\n";
        let (lines, truncated) = clean_log(text, 5000);
        assert_eq!(lines, vec!["##[group]Run npm test", "FAIL src/a.test.ts", "plain line"]);
        assert!(!truncated);
        let (tail, cut) = clean_log("a\nb\nc\nd", 2);
        assert_eq!(tail, vec!["c", "d"]);
        assert!(cut);
    }

    #[test]
    fn compacts_runs_and_marks_forks() {
        let r = json!({
            "id": 58, "name": "テスト", "display_title": "ルーチンの 422 を直す", "workflow_id": 7, "path": ".github/workflows/test.yml",
            "head_branch": "fix/routine", "head_sha": "9f2c1ab", "event": "push", "status": "completed", "conclusion": "failure",
            "run_number": 58, "run_attempt": 1, "actor": { "login": "y0zrin2", "avatar_url": "a", "id": 3 },
            "pull_requests": [{ "number": 68 }], "head_repository": { "full_name": "y0zrin/LifeManager" },
            "head_commit": { "message": "ルーチンの 422 を直す\n\n本文", "author": { "name": "Yui" } }
        });
        let c = compact_run(&r, "y0zrin/LifeManager");
        assert_eq!(c["branch"], "fix/routine");
        assert_eq!(c["pulls"], json!([68]));
        assert_eq!(c["fork"], false);
        assert_eq!(c["commit_message"], "ルーチンの 422 を直す");
        assert!(c["actor"].get("id").is_none());
        let fork = json!({ "head_repository": { "full_name": "someone/LifeManager" } });
        assert_eq!(compact_run(&fork, "y0zrin/LifeManager")["fork"], true);
    }

    #[test]
    fn tells_off_and_forbidden_security_apart() {
        let off = security_state(Err(r#"HTTP 403 Forbidden: {"message":"Dependabot alerts are disabled for this repository."}"#.into()), compact_dependabot, &DEPENDABOT, "読むこと");
        assert_eq!(off["state"], "off");
        let none = security_state(Err(r#"HTTP 404 Not Found: {"message":"no analysis found"}"#.into()), compact_code_scanning, &CODE_SCANNING, "読むこと");
        assert_eq!(none["state"], "off");
        let forbidden = security_state(Err(r#"HTTP 403 Forbidden: {"message":"Resource not accessible by integration"}"#.into()), compact_dependabot, &DEPENDABOT, "読むこと");
        assert_eq!(forbidden["state"], "forbidden");
        assert!(forbidden["message"].as_str().unwrap().contains("「Dependabot alerts」の権限"));
        let ok = security_state(
            Ok(r#"[{"number":1,"security_advisory":{"severity":"high","summary":"s"},"dependency":{"package":{"name":"lodash"}},"security_vulnerability":{"first_patched_version":{"identifier":"4.17.21"}}}]"#.into()),
            compact_dependabot,
            &DEPENDABOT,
            "読むこと",
        );
        assert_eq!(ok["alerts"][0]["package"], "lodash");
        assert_eq!(ok["alerts"][0]["severity"], "high");
        assert_eq!(ok["alerts"][0]["fixed"], "4.17.21");
    }

    #[test]
    fn summarizes_checks() {
        let checks = json!({ "check_runs": [
            { "status": "completed", "conclusion": "success" },
            { "status": "completed", "conclusion": "failure" },
            { "status": "completed", "conclusion": "skipped" },
            { "status": "in_progress", "conclusion": null },
            { "status": "completed", "conclusion": "cancelled" }
        ]});
        assert_eq!(check_summary(&checks), json!({ "success": 2, "failure": 1, "pending": 1 }));
    }
}
