//! マニュアル（resources/manual.html）を、ブラウザで開く。章（#work など）を渡すと、その章から開く（#235）。
//! Windows は、ファイルを開くときに URL の # から後ろを落とすので、その章へ飛ぶだけの小さなページを一時フォルダに書いて、それを開く
use std::path::PathBuf;
use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager};
use tauri_plugin_opener::OpenerExt;

/// 章の名前（manual.html の section の id）。英小文字・数字・- だけ
fn check_section(section: &str) -> Result<(), String> {
    let ok = !section.is_empty() && section.len() <= 40 && section.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-');
    if ok {
        Ok(())
    } else {
        Err(format!("マニュアルの章の名前が正しくありません: {}", section))
    }
}

/// 章へ飛ぶだけのページ
fn jump_page(url: &str) -> String {
    let quoted = serde_json::to_string(url).unwrap_or_else(|_| "\"\"".into());
    format!("<!doctype html>\n<meta charset=\"utf-8\">\n<title>Life Manager マニュアル</title>\n<script>location.replace({});</script>\n", quoted)
}

#[tauri::command]
pub fn open_manual(app: AppHandle, section: Option<String>) -> Result<(), String> {
    let found = app
        .path()
        .resolve("resources/manual.html", BaseDirectory::Resource)
        .map_err(|e| format!("マニュアルが見つかりません: {}", e))?;
    // \\?\ で始まると URL にできないので、ふつうのパスに戻す
    let manual = PathBuf::from(found.to_string_lossy().trim_start_matches(r"\\?\").to_string());
    if !manual.is_file() {
        return Err("マニュアルが見つかりません".into());
    }
    let Some(section) = section.filter(|s| !s.is_empty()) else {
        return app.opener().open_path(manual.to_string_lossy(), None::<&str>).map_err(|e| e.to_string());
    };
    check_section(&section)?;
    let mut url = tauri::Url::from_file_path(&manual).map_err(|_| "マニュアルの場所を URL にできませんでした".to_string())?;
    url.set_fragment(Some(&section));
    let page = std::env::temp_dir().join("life-manager-manual.html");
    std::fs::write(&page, jump_page(url.as_str())).map_err(|e| format!("マニュアルを開けませんでした: {}", e))?;
    app.opener().open_path(page.to_string_lossy(), None::<&str>).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::{check_section, jump_page};

    #[test]
    fn accepts_only_plain_section_names() {
        assert!(check_section("work").is_ok());
        assert!(check_section("git-basics").is_ok());
        assert!(check_section("").is_err());
        assert!(check_section("work\"><script>").is_err());
        assert!(check_section("Work").is_err());
    }

    #[test]
    fn jump_page_quotes_the_url() {
        let page = jump_page("file:///C:/Life%20Manager/resources/manual.html#work");
        assert!(page.contains("location.replace(\"file:///C:/Life%20Manager/resources/manual.html#work\")"));
    }
}
