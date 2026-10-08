//! データのフォルダのファイルを書く・読む・退避する（1.1 の詳細設計 2.2・2.3）
use std::fs::{self, File};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::Duration;

/// 書く。同じフォルダの「名前.tmp」に書き、ディスクに書き終えてから置き換える（書いている途中で止まっても、元のファイルは壊れない）。
/// 改行は LF にそろえる
pub fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        fs::create_dir_all(dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    }
    let tmp = tmp_path(path);
    let text = text.replace("\r\n", "\n");
    let written = (|| -> std::io::Result<()> {
        let mut file = File::create(&tmp)?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        return Ok(());
    })();
    if let Err(e) = written.and_then(|_| replace(&tmp, path)) {
        let _ = fs::remove_file(&tmp);
        return Err(format!("{}: {}", path.display(), e));
    }
    return Ok(());
}

fn tmp_path(path: &Path) -> PathBuf {
    let mut name = path.file_name().map(|n| n.to_os_string()).unwrap_or_default();
    name.push(".tmp");
    return path.with_file_name(name);
}

/// 置き換える。Windows では、ウイルス対策などがファイルを開いていて一瞬だけ置き換えられないことがあるので、少し待って何度か試す
fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    let mut tries: u64 = 0;
    loop {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::PermissionDenied && tries < 5 => {
                tries += 1;
                std::thread::sleep(Duration::from_millis(30 * tries));
            }
            Err(e) => return Err(e),
        }
    }
}

/// 読む。ないときは None。UTF-8 で読めないときは Err（読む側が broken/ へ移す）。改行は LF にそろえる
pub fn read(path: &Path) -> Result<Option<String>, String> {
    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("{}: {}", path.display(), e)),
    };
    let text = String::from_utf8(bytes).map_err(|_| format!("{}: not UTF-8", path.display()))?;
    let text = text.strip_prefix('\u{feff}').unwrap_or(&text).replace("\r\n", "\n");
    return Ok(Some(text));
}

/// 開くときに、前に止まって残った一時ファイル（*.tmp）を消す。データのフォルダの git（.git）の中は見ない。消した数を返す
pub fn clean_leftovers(data: &Path) -> usize {
    let mut removed = 0;
    let mut dirs = vec![data.to_path_buf()];
    while let Some(dir) = dirs.pop() {
        let Ok(entries) = fs::read_dir(&dir) else { continue };
        for entry in entries.flatten() {
            let Ok(kind) = entry.file_type() else { continue };
            let path = entry.path();
            if kind.is_dir() {
                if entry.file_name() != ".git" {
                    dirs.push(path);
                }
            } else if kind.is_file() && path.extension().is_some_and(|e| e == "tmp") && fs::remove_file(&path).is_ok() {
                removed += 1;
            }
        }
    }
    return removed;
}

/// 読めないファイルを broken/ へ移す。名前は「日時_元のパス」（`/` は `__`。例 broken/2026-10-07T10-20-05_tasks__12__task.md）。
/// 移した先を、データのフォルダからのパス（`/` 区切り）で返す
pub fn quarantine(data: &Path, file: &Path) -> Result<String, String> {
    let rel = file.strip_prefix(data).map_err(|_| format!("{}: outside {}", file.display(), data.display()))?;
    let flat = rel.components().map(|c| c.as_os_str().to_string_lossy().to_string()).collect::<Vec<_>>().join("__");
    let stamp = chrono::Local::now().format("%Y-%m-%dT%H-%M-%S").to_string();
    let dir = data.join("broken");
    fs::create_dir_all(&dir).map_err(|e| format!("{}: {}", dir.display(), e))?;
    let mut name = format!("{}_{}", stamp, flat);
    let mut n = 2;
    while dir.join(&name).exists() {
        name = format!("{}-{}_{}", stamp, n, flat);
        n += 1;
    }
    let target = dir.join(&name);
    if fs::rename(file, &target).is_err() {
        fs::copy(file, &target).map_err(|e| format!("{}: {}", file.display(), e))?;
        fs::remove_file(file).map_err(|e| format!("{}: {}", file.display(), e))?;
    }
    return Ok(format!("broken/{}", name));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::local::tests::Scratch;

    // UT-01: 新しく書ける。あるファイルを置き換える。終わったあと *.tmp が残らない。\r\n は \n になる
    #[test]
    fn write_atomic_replaces_and_leaves_no_tmp() {
        let s = Scratch::new("write");
        let path = s.root.join("tasks").join("12").join("task.md");
        write_atomic(&path, "一行目\r\n二行目\r\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "一行目\n二行目\n");
        write_atomic(&path, "置き換えた\n").unwrap();
        assert_eq!(fs::read_to_string(&path).unwrap(), "置き換えた\n");
        let names: Vec<String> = fs::read_dir(path.parent().unwrap()).unwrap().flatten().map(|e| e.file_name().to_string_lossy().to_string()).collect();
        assert_eq!(names, vec!["task.md".to_string()]);
    }

    #[test]
    fn read_returns_none_for_missing_and_err_for_non_utf8() {
        let s = Scratch::new("read");
        assert_eq!(read(&s.root.join("ない.md")).unwrap(), None);
        let bom = s.root.join("bom.md");
        fs::write(&bom, "\u{feff}a\r\nb").unwrap();
        assert_eq!(read(&bom).unwrap().as_deref(), Some("a\nb"));
        let bad = s.root.join("bad.md");
        fs::write(&bad, [0x82, 0xa0, 0xff]).unwrap();
        assert!(read(&bad).is_err());
    }

    // UT-02: 開くときに、残っていた *.tmp を消す。ほかのファイルは消さない
    #[test]
    fn clean_leftovers_removes_only_tmp_files() {
        let s = Scratch::new("leftovers");
        let task = s.root.join("tasks").join("3");
        fs::create_dir_all(task.join("comments")).unwrap();
        fs::create_dir_all(s.root.join(".git")).unwrap();
        fs::write(task.join("task.md"), "本文").unwrap();
        fs::write(task.join("task.md.tmp"), "書きかけ").unwrap();
        fs::write(task.join("comments").join("a.md.tmp"), "書きかけ").unwrap();
        fs::write(s.root.join("labels.yaml.tmp"), "書きかけ").unwrap();
        fs::write(s.root.join(".git").join("x.tmp"), "git のもの").unwrap();
        assert_eq!(clean_leftovers(&s.root), 3);
        assert!(task.join("task.md").exists());
        assert!(!task.join("task.md.tmp").exists());
        assert!(!s.root.join("labels.yaml.tmp").exists());
        assert!(s.root.join(".git").join("x.tmp").exists());
    }

    // UT-05: 読めないファイルを broken/日時_元のパス へ移す（/ は __）。元の場所には残らない
    #[test]
    fn quarantine_moves_into_broken() {
        let s = Scratch::new("broken");
        let file = s.root.join("tasks").join("12").join("task.md");
        fs::create_dir_all(file.parent().unwrap()).unwrap();
        fs::write(&file, "---\ntitle: [\n").unwrap();
        let moved = quarantine(&s.root, &file).unwrap();
        assert!(moved.starts_with("broken/") && moved.ends_with("_tasks__12__task.md"), "{}", moved);
        assert!(!file.exists());
        assert_eq!(fs::read_to_string(s.root.join(&moved)).unwrap(), "---\ntitle: [\n");

        // 同じ名前がもうあっても、上書きしない
        fs::write(&file, "二つ目").unwrap();
        let again = quarantine(&s.root, &file).unwrap();
        assert_ne!(again, moved);
        assert_eq!(fs::read_to_string(s.root.join(&again)).unwrap(), "二つ目");
    }
}
