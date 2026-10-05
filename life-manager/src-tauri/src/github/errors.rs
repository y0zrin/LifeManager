//! GitHub のエラーを、何ができなかったかと直し方のわかる日本語にする（プルリク・Actions で共通）
use super::client::is_network_error;
use serde_json::Value;

/// "HTTP 422 Unprocessable Entity: {json}" から、GitHub の message（と errors の message）を取り出す
pub fn github_message(err: &str) -> String {
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

/// どの権限がいるか（足りないときの直し方に出す）。name は GitHub の画面の名前（"Pull requests" など）
pub struct Permission {
    pub name: &'static str,
    /// "Read and write" / "Read-only"
    pub access: &'static str,
}

/// GitHub のエラーを、何をしようとしたか（what。「マージすること」など）を添えて日本語にする。
/// known は、よく出るエラー（英語の一部）と、その言いかえ
pub fn explain(err: &str, what: &str, permission: &Permission, known: &[(&str, &str)]) -> String {
    if is_network_error(err) {
        return err.to_string();
    }
    let message = github_message(err);
    let has = |s: &str| message.contains(s) || err.contains(s);
    if has("not accessible by personal access token") {
        return format!(
            "今のトークン（自分で作ったトークン）では、{}ができません。GitHub のトークンの画面で、このトークンに「{}」の権限（{}）を足すか、「GitHub でログイン」で入り直してください",
            what, permission.name, permission.access
        );
    }
    if has("not accessible by integration") {
        return format!(
            "{}ができません。GitHub の Life Manager に「{}」の権限がまだないか、このリポジトリに Life Manager が入っていません。持ち主（リーダー）が GitHub で Life Manager の権限の更新を承認するか、このリポジトリを選ぶと使えます。承認は、持ち主のアカウントで https://github.com/settings/installations を開き、Life Manager App の「Configure」から行います（組織のリポジトリは、組織の Settings → GitHub Apps）",
            what, permission.name
        );
    }
    for (needle, japanese) in known {
        if has(needle) {
            return japanese.to_string();
        }
    }
    if err.starts_with("HTTP 404") {
        return format!("{}ができません。消されたか、見る権限がないため見つかりません", what);
    }
    if err.starts_with("HTTP 403") {
        return format!("{}ができません（権限がありません）: {}", what, message);
    }
    format!("{}ができませんでした: {}", what, message)
}
