//! アプリの窓と、その中の枠（iframe。メディアビューワーの PDF・HTML）が、外のページへ移らないようにする（Windows）。
//! PDF の中のリンクを押すと、Edge の PDF を見る仕組みが窓ごと外のページへ移してしまい、アプリの画面が外のページに置き換わっていた
//! （枠の中のリンクなら、枠だけが移る）。どちらでも、アプリの画面に偽のログイン画面なども出せてしまう。
//! 外のページ・この PC のファイル・data: へは移さない。http・https のリンクは、いつものブラウザで開く。
//! アプリは外のページへ自分で移ることはない（リンクは、いつも opener でブラウザに開く）

use tauri::Manager;

/// 窓（と、その中の枠）の移動を見張る
pub fn guard(w: &tauri::WebviewWindow) {
    let app = w.app_handle().clone();
    let _ = w.with_webview(move |webview| unsafe {
        let Ok(core) = webview.controller().CoreWebView2() else { return };
        let mut token = 0i64;
        let _ = core.add_NavigationStarting(&handler(app.clone(), true), &mut token);
        // 枠の移動も、窓の移動と同じ形の知らせで来る
        let _ = core.add_FrameNavigationStarting(&handler(app, false), &mut token);
    });
}

/// 移動の知らせを受けて、外へは移さない（リンクは、ブラウザで開く）。
/// 窓（top）の移動は、PDF の中のリンクを押したときだけ起きる（アプリは自分で外へ移らず、枠の中のページは窓を動かせない）ので、ブラウザで開く
/// （PDF を見る仕組みからの移動は、人が押したものとして来ない）。枠の中のページは自分で移り続けられるので、人が押したときだけ開く
fn handler(app: tauri::AppHandle, top: bool) -> webview2_com::Microsoft::Web::WebView2::Win32::ICoreWebView2NavigationStartingEventHandler {
    use webview2_com::{take_pwstr, NavigationStartingEventHandler};
    use windows_core::{BOOL, PWSTR};
    NavigationStartingEventHandler::create(Box::new(move |_, args| {
        let Some(args) = args else { return Ok(()) };
        let mut uri = PWSTR::null();
        unsafe { args.Uri(&mut uri)? };
        let uri = take_pwstr(uri);
        let Some(outside) = blocked(&uri, cfg!(debug_assertions)) else { return Ok(()) };
        unsafe { args.SetCancel(true)? };
        let mut user = BOOL::default();
        let _ = unsafe { args.IsUserInitiated(&mut user) };
        if outside && (top || user.as_bool()) {
            use tauri_plugin_opener::OpenerExt;
            let _ = app.opener().open_url(uri, None::<&str>);
        }
        Ok(())
    }))
}

/// そこへ移さないか。移さないなら Some（true = ブラウザで開いてよい外のページ）。
/// 移してよいのは、アプリの中身（tauri.localhost。開発のときは localhost の開発サーバーも）・blob:（PDF・動画）・about:（HTML の srcdoc）と、
/// WebView2 の中のもの（PDF を見る仕組みなど）
fn blocked(uri: &str, dev: bool) -> Option<bool> {
    let lower = uri.to_ascii_lowercase();
    if let Some(rest) = lower.strip_prefix("https://").or_else(|| lower.strip_prefix("http://")) {
        let host = rest.split(['/', '?', '#']).next().unwrap_or("");
        let host = host.rsplit('@').next().unwrap_or(host);
        let host = host.split(':').next().unwrap_or(host);
        let inside = host == "tauri.localhost" || (dev && (host == "localhost" || host == "127.0.0.1"));
        return if inside { None } else { Some(true) };
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
    fn windows_and_frames_stay_inside_the_app() {
        let b = |uri: &str| blocked(uri, false);
        // 外のページは移さず、ブラウザで開く
        assert_eq!(b("https://example.com/login"), Some(true));
        assert_eq!(b("HTTP://Example.com"), Some(true));
        assert_eq!(b("https://tauri.localhost.evil.com/"), Some(true));
        assert_eq!(b("https://user@evil.com:8443/x"), Some(true));
        assert_eq!(b("http://asset.localhost/C:/Users/x/secret.txt"), Some(true));
        // 配る版では、localhost も外
        assert_eq!(b("http://localhost:1420/"), Some(true));
        // この PC のファイル・data: は移さず、開きもしない
        assert_eq!(b("file:///C:/Users/x/secret.txt"), Some(false));
        assert_eq!(b("data:text/html,<form>"), Some(false));
        // アプリの中身・PDF・HTML の srcdoc・WebView2 の中のものは、そのまま
        assert_eq!(b("http://tauri.localhost/index.html"), None);
        assert_eq!(b("blob:http://tauri.localhost/6c1f0a2e"), None);
        assert_eq!(b("about:srcdoc"), None);
        assert_eq!(b("about:blank"), None);
        assert_eq!(b("edge://pdf/index.html"), None);
        assert_eq!(b("chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai/index.html"), None);
        // 開発のとき（tauri dev）は、開発サーバーの中を動ける
        assert_eq!(blocked("http://localhost:1420/", true), None);
        assert_eq!(blocked("http://127.0.0.1:1420/x", true), None);
        assert_eq!(blocked("https://example.com/", true), Some(true));
    }
}
