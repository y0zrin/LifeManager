//! アプリの中の枠（iframe。メディアビューワーの PDF・HTML）が、外のページへ移らないようにする（Windows）。
//! PDF の中のリンクを押すと、枠ごと外のページに移り、アプリの画面の一部に見えてしまう（偽のログイン画面なども出せてしまう）。
//! 外のページ・この PC のファイル・data: へは移さない。人が押した http・https のリンクは、いつものブラウザで開く

/// メインの窓の枠の移動を見張る
pub fn guard(w: &tauri::WebviewWindow) {
    use tauri::Manager;
    let app = w.app_handle().clone();
    let _ = w.with_webview(move |webview| unsafe {
        use webview2_com::{take_pwstr, NavigationStartingEventHandler};
        use windows_core::{BOOL, PWSTR};
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        // 枠の移動も、窓の移動と同じ形の知らせで来る
        let handler = NavigationStartingEventHandler::create(Box::new(move |_, args| {
            let Some(args) = args else { return Ok(()) };
            let mut uri = PWSTR::null();
            args.Uri(&mut uri)?;
            let uri = take_pwstr(uri);
            let Some(outside) = blocked(&uri) else { return Ok(()) };
            args.SetCancel(true)?;
            let mut user = BOOL::default();
            let _ = args.IsUserInitiated(&mut user);
            if outside && user.as_bool() {
                use tauri_plugin_opener::OpenerExt;
                let _ = app.opener().open_url(uri, None::<&str>);
            }
            Ok(())
        }));
        let mut token = 0i64;
        let _ = core.add_FrameNavigationStarting(&handler, &mut token);
    });
}

/// 枠をそこへ移さないか。移さないなら Some（true = ブラウザで開いてよい外のページ）。
/// 移してよいのは、アプリの中身（tauri.localhost）・blob:（PDF・動画）・about:（HTML の srcdoc）と、WebView2 の中のもの（PDF を見る仕組みなど）
fn blocked(uri: &str) -> Option<bool> {
    let lower = uri.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.rsplit('@').next().unwrap_or(host);
        let host = host.split(':').next().unwrap_or(host);
        return if host == "tauri.localhost" { None } else { Some(true) };
    }
    if lower.starts_with("file:") || lower.starts_with("data:") || lower.starts_with("ftp:") {
        return Some(false);
    }
    None
}

#[cfg(test)]
mod tests {
    use super::blocked;

    #[test]
    fn frames_stay_inside_the_app() {
        // 外のページは移さず、ブラウザで開く
        assert_eq!(blocked("https://example.com/login"), Some(true));
        assert_eq!(blocked("HTTP://Example.com"), Some(true));
        assert_eq!(blocked("https://tauri.localhost.evil.com/"), Some(true));
        assert_eq!(blocked("https://user@evil.com:8443/x"), Some(true));
        assert_eq!(blocked("http://asset.localhost/C:/Users/x/secret.txt"), Some(true));
        // この PC のファイル・data: は移さず、開きもしない
        assert_eq!(blocked("file:///C:/Users/x/secret.txt"), Some(false));
        assert_eq!(blocked("data:text/html,<form>"), Some(false));
        // アプリの中身・PDF・HTML の srcdoc・WebView2 の中のものは、そのまま
        assert_eq!(blocked("http://tauri.localhost/index.html"), None);
        assert_eq!(blocked("blob:http://tauri.localhost/6c1f0a2e"), None);
        assert_eq!(blocked("about:srcdoc"), None);
        assert_eq!(blocked("about:blank"), None);
        assert_eq!(blocked("edge://pdf/index.html"), None);
        assert_eq!(blocked("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"), None);
    }
}
