//! どちらの置き場を使うかを決める（1.1 の詳細設計 1.1）。owner が `_local` ならローカルのプロジェクト（local）、ほかは GitHub（offline）。
//! コマンドは名前と引数を今のまま使い、ここで振り分ける（振り分ける関数は 4-3 #158 から足す）
#![allow(dead_code)]

use crate::credential::CredentialEntry as Entry;
use crate::github::client::GitHubClient;
use crate::local::{self, LocalProject};
use std::path::PathBuf;
use tauri::AppHandle;
use tokio::sync::Mutex;

pub enum Backend {
    GitHub(GitHubClient),
    Local(LocalProject),
}

/// コマンドの入口で、プロジェクトの置き場を選ぶ
pub async fn backend_for(
    app: &AppHandle,
    state: &tauri::State<'_, Mutex<Option<GitHubClient>>>,
    owner: &str,
    repo: &str,
) -> Result<Backend, String> {
    let client = if local::is_local(owner) { None } else { state.lock().await.clone() };
    let projects = || Entry::new("life-manager", "projects").ok().and_then(|e| e.get_password().ok()).unwrap_or_default();
    return Ok(match choose(owner, repo, projects, client)? {
        Backend::Local(project) => Backend::Local(project.with_app(app.clone())),
        github => github,
    });
}

/// 置き場を選ぶ（キーチェーンを読むところを外に出して、テストできるようにしてある）。
/// プロジェクトの一覧は、ローカルのプロジェクトのときだけ読む
pub fn choose(owner: &str, repo: &str, projects: impl FnOnce() -> String, client: Option<GitHubClient>) -> Result<Backend, String> {
    if local::is_local(owner) {
        let root = local_folder_of(&projects(), repo).ok_or_else(|| local::folder_missing(repo))?;
        return Ok(Backend::Local(LocalProject::open(&root, repo)?));
    }
    return Ok(Backend::GitHub(client.ok_or("トークンが未設定です")?));
}

/// プロジェクトの一覧（キーチェーンの projects の JSON）から、ローカルのプロジェクトの作品のフォルダを引く
pub fn local_folder_of(projects_json: &str, name: &str) -> Option<PathBuf> {
    let list: Vec<serde_json::Value> = serde_json::from_str(projects_json).ok()?;
    return list
        .iter()
        .find(|p| p["owner"].as_str() == Some(local::LOCAL_OWNER) && p["repo"].as_str() == Some(name))
        .and_then(|p| p["path"].as_str())
        .filter(|path| !path.trim().is_empty())
        .map(PathBuf::from);
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::tests::Scratch;

    fn list_with(name: &str, path: &std::path::Path) -> String {
        return serde_json::json!([
            { "owner": "y0zrin", "repo": "LifeManager", "name": "Life Manager" },
            { "owner": "_local", "repo": name, "name": name, "kind": "local", "path": path.to_string_lossy() },
        ])
        .to_string();
    }

    // UT-25: _local は Local、ほかは GitHub。ローカルのフォルダが見つからなければ、直し方の文のエラー
    #[test]
    fn local_owner_opens_the_folder_from_the_list() {
        let s = Scratch::new("backend");
        let work = s.root.join("action-game");
        LocalProject::create(&work, "action-game", "y0zrin").unwrap();

        match choose("_local", "action-game", || list_with("action-game", &work), None).unwrap() {
            Backend::Local(project) => assert_eq!(project.root, work),
            Backend::GitHub(_) => panic!("ローカルのはず"),
        }
        let github = choose("y0zrin", "LifeManager", || panic!("GitHub のプロジェクトでは一覧を読まない"), Some(GitHubClient::new("t".to_string())));
        assert!(matches!(github, Ok(Backend::GitHub(_))));
        assert_eq!(choose("y0zrin", "LifeManager", String::new, None).err().as_deref(), Some("トークンが未設定です"));

        // 一覧にない・フォルダが動いた
        let missing = local::folder_missing("action-game");
        assert_eq!(choose("_local", "action-game", || "[]".to_string(), None).err(), Some(missing.clone()));
        assert_eq!(choose("_local", "action-game", || list_with("action-game", &s.root.join("moved")), None).err(), Some(missing));
        assert_eq!(choose("_local", "action-game", String::new, None).err(), Some(local::folder_missing("action-game")));
    }

    #[test]
    fn local_folder_is_looked_up_by_name() {
        let list = serde_json::json!([
            { "owner": "_local", "repo": "a", "path": "D:/games/a" },
            { "owner": "_local", "repo": "b", "path": "" },
            { "owner": "someone", "repo": "a", "path": "D:/elsewhere" },
        ])
        .to_string();
        assert_eq!(local_folder_of(&list, "a"), Some(PathBuf::from("D:/games/a")));
        assert_eq!(local_folder_of(&list, "b"), None);
        assert_eq!(local_folder_of(&list, "c"), None);
        assert_eq!(local_folder_of("壊れた", "a"), None);
    }
}
