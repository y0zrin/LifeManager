//! コミットの前の見張り（#234）。変更のあるファイルの中から、コミットしない方がよいものを見つける:
//! - GitHub が受け取らない大きなファイル（100 MiB をこえる）
//! - ツールが作るフォルダ（Unity の Library・Unreal Engine の Saved・Visual Studio の .vs など）。
//!   そのツールのプロジェクトの印（Unity なら Assets と ProjectSettings）がとなりにあるときだけ数える
use super::ignore::top_level;
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;

/// GitHub が受け取らないファイルの大きさ（これをこえると、プッシュが断られる）
pub const GITHUB_FILE_LIMIT: u64 = 100 * 1024 * 1024;

#[derive(Debug, Serialize, PartialEq)]
pub struct WatchFinding {
    /// large: 大きすぎるファイル / generated: ツールが作るフォルダ
    pub kind: &'static str,
    /// ファイル、またはフォルダ（リポジトリのいちばん上から。フォルダは最後の / なし）
    pub path: String,
    /// generated: 作るツール（Unity など）
    pub tool: Option<&'static str>,
    /// large: 大きさ（バイト）
    pub size: Option<u64>,
    /// 当てはまった、変更のあるファイルの数（large は 1）
    pub files: u32,
}

/// フォルダの中にある、プロジェクトの印
#[derive(Default, Clone, Copy)]
struct Marks {
    /// Assets と ProjectSettings がある（Unity）
    unity: bool,
    /// *.uproject がある（Unreal Engine）
    unreal: bool,
    /// *.sln がある（Visual Studio のソリューション）
    solution: bool,
    /// *.csproj・*.vcxproj など（Visual Studio のプロジェクト）
    project: bool,
}

impl Marks {
    fn read(dir: &Path) -> Marks {
        let mut m = Marks { unity: dir.join("Assets").is_dir() && dir.join("ProjectSettings").is_dir(), ..Marks::default() };
        if let Ok(entries) = std::fs::read_dir(dir) {
            for e in entries.flatten() {
                let name = e.file_name().to_string_lossy().to_lowercase();
                if name.ends_with(".uproject") {
                    m.unreal = true;
                } else if name.ends_with(".sln") || name.ends_with(".slnx") {
                    m.solution = true;
                } else if [".csproj", ".vcxproj", ".fsproj", ".vbproj"].iter().any(|ext| name.ends_with(ext)) {
                    m.project = true;
                }
            }
        }
        m
    }
}

/// ツールが作るフォルダの名前（大文字・小文字は区別しない）と、となりにあるはずの印
struct Rule {
    tool: &'static str,
    names: &'static [&'static str],
    marked: fn(&Marks) -> bool,
}

const RULES: &[Rule] = &[
    Rule { tool: "Unity", names: &["Library", "Temp", "Obj", "Logs", "UserSettings", "Build", "Builds", "MemoryCaptures"], marked: |m| m.unity },
    Rule { tool: "Unreal Engine", names: &["Binaries", "DerivedDataCache", "Intermediate", "Saved"], marked: |m| m.unreal },
    // .vs は Visual Studio が開いたフォルダならどこにでも作る。node_modules は npm がどこにでも作る
    Rule { tool: "Visual Studio", names: &[".vs"], marked: |_| true },
    Rule { tool: "Visual Studio", names: &["x64", "x86", "ARM64", "Debug", "Release"], marked: |m| m.solution || m.project },
    Rule { tool: "Visual Studio", names: &["bin", "obj"], marked: |m| m.project },
    Rule { tool: "Node.js", names: &["node_modules"], marked: |_| true },
];

/// 変更のあるファイル（git status のパス）を見張る
pub fn commit_watch(repo: &Path, paths: &[String]) -> Result<Vec<WatchFinding>, String> {
    Ok(find(&top_level(repo)?, paths))
}

fn find(top: &Path, paths: &[String]) -> Vec<WatchFinding> {
    let mut marks: HashMap<String, Marks> = HashMap::new();
    let mut folders: Vec<WatchFinding> = Vec::new();
    let mut at: HashMap<String, usize> = HashMap::new();
    let mut large: Vec<WatchFinding> = Vec::new();
    for path in paths {
        if let Some((dir, tool)) = generated_dir(top, path, &mut marks) {
            match at.get(&dir) {
                Some(&i) => folders[i].files += 1,
                None => {
                    at.insert(dir.clone(), folders.len());
                    folders.push(WatchFinding { kind: "generated", path: dir, tool: Some(tool), size: None, files: 1 });
                }
            }
            continue;
        }
        // 消したファイルは、もうないので数えない
        if let Ok(meta) = std::fs::metadata(top.join(path)) {
            if meta.is_file() && meta.len() > GITHUB_FILE_LIMIT {
                large.push(WatchFinding { kind: "large", path: path.clone(), tool: None, size: Some(meta.len()), files: 1 });
            }
        }
    }
    folders.extend(large);
    folders
}

/// そのファイルが、ツールが作るフォルダの中にあれば、そのフォルダ（上から見て最初のもの）と、作るツール
fn generated_dir(top: &Path, path: &str, marks: &mut HashMap<String, Marks>) -> Option<(String, &'static str)> {
    let parts: Vec<&str> = path.split('/').filter(|p| !p.is_empty()).collect();
    // 最後はファイルの名前なので、フォルダだけを見る
    for i in 0..parts.len().saturating_sub(1) {
        let name = parts[i];
        for rule in RULES {
            if !rule.names.iter().any(|n| n.eq_ignore_ascii_case(name)) {
                continue;
            }
            let parent = parts[..i].join("/");
            let m = *marks.entry(parent.clone()).or_insert_with(|| Marks::read(&top.join(&parent)));
            if (rule.marked)(&m) {
                return Some((parts[..=i].join("/"), rule.tool));
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::path::PathBuf;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lm-watch-{}-{}", name, std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn touch(top: &Path, path: &str) {
        let p = top.join(path);
        fs::create_dir_all(p.parent().unwrap()).unwrap();
        fs::write(p, "x").unwrap();
    }

    fn paths(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn finds_folders_that_tools_make_only_next_to_their_project() {
        let top = temp("tools");
        // Unity のプロジェクトは、リポジトリの中のフォルダ（Game）にある
        for p in ["Game/Assets/Player.cs", "Game/ProjectSettings/ProjectVersion.txt", "Game/Library/ArtifactDB", "Game/Library/a/b.asset", "Game/Temp/x"] {
            touch(&top, p);
        }
        touch(&top, "Shooter/Shooter.uproject");
        touch(&top, "Shooter/Saved/Logs/Shooter.log");
        touch(&top, "Tool/Tool.sln");
        touch(&top, "Tool/x64/Debug/Tool.exe");
        touch(&top, "Tool/.vs/Tool/v17/.suo");
        // 印のないところの Build・Library は、ふつうのフォルダ
        touch(&top, "docs/Build/readme.md");
        touch(&top, "Library/notes.txt");

        let found = find(
            &top,
            &paths(&[
                "Game/Assets/Player.cs",
                "Game/Library/ArtifactDB",
                "Game/Library/a/b.asset",
                "Game/Temp/x",
                "Shooter/Saved/Logs/Shooter.log",
                "Tool/x64/Debug/Tool.exe",
                "Tool/.vs/Tool/v17/.suo",
                "docs/Build/readme.md",
                "Library/notes.txt",
            ]),
        );
        let got: Vec<(&str, Option<&str>, u32)> = found.iter().map(|f| (f.path.as_str(), f.tool, f.files)).collect();
        assert_eq!(
            got,
            vec![
                ("Game/Library", Some("Unity"), 2),
                ("Game/Temp", Some("Unity"), 1),
                ("Shooter/Saved", Some("Unreal Engine"), 1),
                ("Tool/x64", Some("Visual Studio"), 1),
                ("Tool/.vs", Some("Visual Studio"), 1),
            ]
        );
        let _ = fs::remove_dir_all(&top);
    }

    #[test]
    fn finds_files_github_does_not_take() {
        let top = temp("large");
        touch(&top, "small.txt");
        let big = top.join("Movies/opening.mp4");
        fs::create_dir_all(big.parent().unwrap()).unwrap();
        // 中身を書かずに大きさだけ決める（すぐ終わる）
        fs::File::create(&big).unwrap().set_len(GITHUB_FILE_LIMIT + 1).unwrap();

        let found = find(&top, &paths(&["small.txt", "Movies/opening.mp4", "deleted.bin"]));
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].kind, "large");
        assert_eq!(found[0].path, "Movies/opening.mp4");
        assert_eq!(found[0].size, Some(GITHUB_FILE_LIMIT + 1));
        let _ = fs::remove_dir_all(&top);
    }
}
