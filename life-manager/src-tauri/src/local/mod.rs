//! ローカルのプロジェクト（GitHub を使わないプロジェクト。1.1）。データは作品のフォルダの .lifemanager/ に置く。
//! 画面には GitHub の Issue などと同じ形で返し、画面の側はなるべく変えない（1.1 の詳細設計 2 章）。
//!
//! 4-1（#156）では、置き場を開く・作る・書く・読めないファイルを退避する・データのフォルダの git に記録する、までを作る。
//! タスク・コメント・日誌などの読み書き（4-3〜4-5）と、コマンドからの呼び出しは、このあとのタスクで足す
#![allow(dead_code)]

pub mod files;
pub mod front;
pub mod record;

use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Emitter};

/// 読めないファイルを退避したことを知らせる先（元のパス・移した先）
type BrokenNotice = Arc<dyn Fn(&str, &str) + Send + Sync>;

/// ローカルのプロジェクトの owner（GitHub のユーザー名には `_` が使えないので、GitHub のプロジェクトとぶつからない）
pub const LOCAL_OWNER: &str = "_local";
/// データのフォルダ（作品のフォルダの中）
pub const DATA_DIR: &str = ".lifemanager";
/// データの形の版。形を変えたら上げ、古い版は読み替える
pub const FORMAT_VERSION: u32 = 1;
const MANIFEST: &str = "lifemanager.yaml";

pub fn is_local(owner: &str) -> bool {
    return owner == LOCAL_OWNER;
}

/// 今の時刻（この PC の時刻帯つき。例 2026-10-02T10:20:05+09:00）
pub fn now() -> String {
    return chrono::Local::now().to_rfc3339_opts(chrono::SecondsFormat::Secs, false);
}

/// lifemanager.yaml（版・名前・使う人・次の番号）
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Manifest {
    pub version: u32,
    pub name: String,
    pub created_at: String,
    /// 次のタスクの番号（tasks/ の中のいちばん大きい番号 + 1 と、大きいほうを使う）
    pub next_task: i64,
    pub next_milestone: i64,
    #[serde(default)]
    pub people: Vec<Person>,
}

/// 使う人
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Person {
    pub name: String,
}

/// labels.yaml の 1 件
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Label {
    pub name: String,
    pub color: String,
    #[serde(default)]
    pub description: String,
}

/// ローカルのプロジェクト
#[derive(Clone)]
pub struct LocalProject {
    /// 作品のフォルダ
    pub root: PathBuf,
    /// データのフォルダ（作品のフォルダの .lifemanager）
    pub data: PathBuf,
    /// プロジェクトの名前（一覧の repo）
    pub name: String,
    /// 読めないファイルを退避したことを画面に知らせる先（テストでは None。
    /// AppHandle を直に持つと、テストの実行ファイルが画面の部品まで読み込もうとして起動しなくなる）
    notice: Option<BrokenNotice>,
}

impl std::fmt::Debug for LocalProject {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        return f.debug_struct("LocalProject").field("root", &self.root).field("name", &self.name).finish();
    }
}

/// フォルダが見つからないときの文（一覧の作品のフォルダが動いた・消えたとき）
pub fn folder_missing(name: &str) -> String {
    return format!("ローカルのプロジェクト「{}」のフォルダが見つかりません。設定 → 接続 でフォルダを選び直してください", name);
}

/// プロジェクトごとの書き込みの鍵（キーはデータのフォルダ）。同じプロジェクトへの書き込みと記録のコミットを 1 つずつにする
static LOCKS: Mutex<BTreeMap<PathBuf, Arc<Mutex<()>>>> = Mutex::new(BTreeMap::new());
/// このアプリを起動してから、開くときの片付け（残った一時ファイル・記録の用意）を済ませたデータのフォルダ
static PREPARED: Mutex<BTreeSet<PathBuf>> = Mutex::new(BTreeSet::new());

fn lock_of(data: &Path) -> Arc<Mutex<()>> {
    let mut locks = LOCKS.lock().unwrap_or_else(|e| e.into_inner());
    return locks.entry(data.to_path_buf()).or_insert_with(|| Arc::new(Mutex::new(()))).clone();
}

impl LocalProject {
    fn at(root: &Path, name: &str) -> LocalProject {
        return LocalProject { root: root.to_path_buf(), data: root.join(DATA_DIR), name: name.to_string(), notice: None };
    }

    /// 前に作ったプロジェクトを開く。lifemanager.yaml が読めないときは、番号が分からなくなるので開かない（2.3）
    pub fn open(root: &Path, name: &str) -> Result<LocalProject, String> {
        if !root.is_dir() {
            return Err(folder_missing(name));
        }
        let project = LocalProject::at(root, name);
        let manifest = project.manifest()?;
        if manifest.version > FORMAT_VERSION {
            return Err("このプロジェクトは新しい版の Life Manager で作られています。Life Manager を新しくしてから開いてください".to_string());
        }
        project.prepare();
        return Ok(project);
    }

    /// 新しく作る（作品のフォルダに .lifemanager/ を作る）。使う人は person（初めは git の user.name。default_person）
    pub fn create(root: &Path, name: &str, person: &str) -> Result<LocalProject, String> {
        std::fs::create_dir_all(root).map_err(|e| format!("{}: {}", root.display(), e))?;
        let project = LocalProject::at(root, name);
        if project.path(MANIFEST).exists() {
            return Err("このフォルダには、もうローカルのプロジェクトがあります（.lifemanager）".to_string());
        }
        project.locked(|| -> Result<(), String> {
            let labels: Vec<Label> = crate::DEFAULT_LABELS
                .iter()
                .map(|(name, color, description)| Label { name: name.to_string(), color: color.to_string(), description: description.to_string() })
                .collect();
            project.write_yaml("labels.yaml", &labels)?;
            project.write_yaml("milestones.yaml", &Vec::<serde_yaml::Value>::new())?;
            // lifemanager.yaml は最後に書く（途中で止まっても、作りかけのフォルダを「作ったプロジェクト」と見ない）
            let manifest = Manifest {
                version: FORMAT_VERSION,
                name: name.to_string(),
                created_at: now(),
                next_task: 1,
                next_milestone: 1,
                people: vec![Person { name: person.to_string() }],
            };
            project.write_yaml(MANIFEST, &manifest)?;
            return Ok(());
        })?;
        project.prepare();
        record::commit_now(&project, record::CREATED_PROJECT);
        return Ok(project);
    }

    /// 前に作ったプロジェクトがあるか（lifemanager.yaml があるか）
    pub fn exists(root: &Path) -> bool {
        return root.join(DATA_DIR).join(MANIFEST).is_file();
    }

    /// 読めないファイルを退避したことを、画面に知らせるようにする
    pub fn with_app(mut self, app: AppHandle) -> LocalProject {
        self.notice = Some(Arc::new(move |file: &str, moved: &str| {
            let _ = app.emit("local-broken", serde_json::json!({ "file": file, "moved": moved }));
        }));
        return self;
    }

    /// 開くときの片付け。アプリを起動してから最初の 1 回だけ、書き込みの鍵を取ってする
    /// （コマンドのたびに開くので、2 回目からは何もしない）
    fn prepare(&self) {
        let prepared = || PREPARED.lock().unwrap_or_else(|e| e.into_inner()).contains(&self.data);
        if prepared() {
            return;
        }
        self.locked(|| {
            if prepared() {
                return;
            }
            let removed = files::clean_leftovers(&self.data);
            if removed > 0 {
                eprintln!("前に書きかけで残った一時ファイルを {} 個消しました（{}）", removed, self.data.display());
            }
            record::ensure(self);
            PREPARED.lock().unwrap_or_else(|e| e.into_inner()).insert(self.data.clone());
        });
    }

    /// 書き込みの鍵を取って f をする（同じプロジェクトへの書き込みを 1 つずつにする。2.2）。f の中で locked を呼ばない
    pub fn locked<R>(&self, f: impl FnOnce() -> R) -> R {
        let lock = lock_of(&self.data);
        let _guard = lock.lock().unwrap_or_else(|e| e.into_inner());
        return f();
    }

    /// データのフォルダの中のパス（rel は `/` 区切り）
    pub fn path(&self, rel: &str) -> PathBuf {
        return rel.split('/').filter(|s| !s.is_empty()).fold(self.data.clone(), |p, s| p.join(s));
    }

    pub fn manifest(&self) -> Result<Manifest, String> {
        let text = match files::read(&self.path(MANIFEST)) {
            Ok(Some(text)) => text,
            Ok(None) => {
                return Err(format!(
                    "「{}」にローカルのプロジェクトのデータ（.lifemanager）がありません。設定 → 接続 でフォルダを選び直してください",
                    self.root.display()
                ))
            }
            Err(e) => {
                eprintln!("{}", e);
                return Err(manifest_broken());
            }
        };
        return serde_yaml::from_str(&text).map_err(|e| {
            eprintln!("{}: {}", self.path(MANIFEST).display(), e);
            manifest_broken()
        });
    }

    /// lifemanager.yaml を書く（鍵を取った中で呼ぶ）
    pub fn save_manifest(&self, manifest: &Manifest) -> Result<(), String> {
        return self.write_yaml(MANIFEST, manifest);
    }

    /// 文字を書く（一時ファイルに書いてから置き換える。鍵を取った中で呼ぶ）
    pub fn write_text(&self, rel: &str, text: &str) -> Result<(), String> {
        return files::write_atomic(&self.path(rel), text);
    }

    /// YAML にして書く（鍵を取った中で呼ぶ）
    pub fn write_yaml<T: Serialize>(&self, rel: &str, value: &T) -> Result<(), String> {
        let text = serde_yaml::to_string(value).map_err(|e| e.to_string())?;
        return self.write_text(rel, &text);
    }

    /// 文字を読む。ないときは None
    pub fn read_text(&self, rel: &str) -> Result<Option<String>, String> {
        return files::read(&self.path(rel));
    }

    /// 読めないファイルを broken/ へ移し、画面に知らせる（2.3）。rel はデータのフォルダからのパス
    pub fn broken(&self, rel: &str, why: &str) {
        match files::quarantine(&self.data, &self.path(rel)) {
            Ok(moved) => {
                eprintln!("読めなかったファイルを {} に移しました: {}（{}）", moved, rel, why);
                if let Some(notice) = &self.notice {
                    notice(rel, &moved);
                }
            }
            Err(e) => eprintln!("読めなかったファイル {} を移せませんでした（{}）: {}", rel, why, e),
        }
    }
}

fn manifest_broken() -> String {
    return ".lifemanager/lifemanager.yaml を読めませんでした。ファイルを直すか、broken から戻してください".to_string();
}

/// 作るときの使う人の名前: この PC の git の user.name。なければ OS のユーザー名
pub fn default_person(root: &Path) -> String {
    if let Ok(run) = crate::git::runner::run(root, &["config", "--get", "user.name"]) {
        let name = run.output.trim();
        if !name.is_empty() {
            return name.to_string();
        }
    }
    return std::env::var("USERNAME").or_else(|_| std::env::var("USER")).unwrap_or_else(|_| "me".to_string());
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static COUNTER: AtomicUsize = AtomicUsize::new(0);

    /// テストごとの使い捨てフォルダ（終わったら消す）
    pub(crate) struct Scratch {
        pub root: PathBuf,
    }

    impl Scratch {
        pub(crate) fn new(name: &str) -> Scratch {
            crate::git::scenario_tests::isolate_git_config();
            let n = COUNTER.fetch_add(1, Ordering::SeqCst);
            let root = std::env::temp_dir().join(format!("lm-local-{}-{}-{}", name, std::process::id(), n));
            let _ = std::fs::remove_dir_all(&root);
            std::fs::create_dir_all(&root).unwrap();
            return Scratch { root };
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.root);
        }
    }

    // UT-06: lifemanager.yaml が壊れていれば、直し方の文のエラー。ないフォルダもエラー
    #[test]
    fn open_needs_a_readable_manifest() {
        let s = Scratch::new("open");
        let missing = s.root.join("ない");
        assert_eq!(LocalProject::open(&missing, "game").unwrap_err(), folder_missing("game"));

        // データのフォルダがない
        let empty = s.root.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        assert!(LocalProject::open(&empty, "game").unwrap_err().contains("設定 → 接続 でフォルダを選び直してください"));

        // 壊れた lifemanager.yaml
        let work = s.root.join("work");
        LocalProject::create(&work, "game", "y0zrin").unwrap();
        std::fs::write(work.join(DATA_DIR).join(MANIFEST), "version: [1\nname: game\n").unwrap();
        assert_eq!(LocalProject::open(&work, "game").unwrap_err(), manifest_broken());

        // 新しい版で作られた
        std::fs::write(
            work.join(DATA_DIR).join(MANIFEST),
            "version: 2\nname: game\ncreated_at: 2026-10-07T10:00:00+09:00\nnext_task: 1\nnext_milestone: 1\n",
        )
        .unwrap();
        assert!(LocalProject::open(&work, "game").unwrap_err().contains("新しい版"));
    }

    #[test]
    fn create_writes_the_first_files() {
        let s = Scratch::new("create");
        let work = s.root.join("action-game");
        assert!(!LocalProject::exists(&work));
        let project = LocalProject::create(&work, "action-game", "y0zrin").unwrap();
        assert!(LocalProject::exists(&work));

        let manifest = project.manifest().unwrap();
        assert_eq!(manifest.version, FORMAT_VERSION);
        assert_eq!((manifest.next_task, manifest.next_milestone), (1, 1));
        assert_eq!(manifest.people, vec![Person { name: "y0zrin".to_string() }]);

        let labels: Vec<Label> = serde_yaml::from_str(&project.read_text("labels.yaml").unwrap().unwrap()).unwrap();
        assert_eq!(labels.len(), crate::DEFAULT_LABELS.len());
        assert_eq!(labels[0], Label { name: "優先:高".to_string(), color: "B60205".to_string(), description: "先にやる".to_string() });
        assert_eq!(project.read_text("milestones.yaml").unwrap().unwrap().trim(), "[]");

        // 2 回は作らない。開くことはできる
        assert!(LocalProject::create(&work, "action-game", "y0zrin").unwrap_err().contains("もうローカルのプロジェクトがあります"));
        assert_eq!(LocalProject::open(&work, "action-game").unwrap().manifest().unwrap(), manifest);
    }

    #[test]
    fn path_joins_slash_separated_parts() {
        let project = LocalProject::at(Path::new("work"), "game");
        assert_eq!(project.path("tasks/12/task.md"), Path::new("work").join(DATA_DIR).join("tasks").join("12").join("task.md"));
    }
}
