//! アプリの窓の外に出す「おしらせ」の小さな窓と、インジケーター（タスクトレイ）。
//! おしらせの窓は、枠なし・透明・いつも手前・タスクバーに出ない・入力を奪わない。中身（index.html）は同じで、窓の名前（notice）で出し分ける。
//! 高さは知らせの数に合わせて変え、知らせがなければ画面の外へ退ける。出す角（右上・右下・左上・左下）は設定で選ぶ。
//! 窓は隠さない（隠した窓を出し直すと、Windows では入力の場所〔フォーカス〕を取ってしまうので、出したまま動かすだけにする）
//! メインの窓の × は、設定でインジケーターに残す（はじめはこれ）か、終了する。スマホ版では、どれも何もしない

use std::sync::atomic::{AtomicBool, Ordering};
use tauri::AppHandle;
#[cfg(desktop)]
use tauri::Manager;

#[cfg(desktop)]
pub const NOTICE_LABEL: &str = "notice";
#[cfg(desktop)]
const MAIN_LABEL: &str = "main";
/// おしらせの窓の幅（画面の点。拡大率は掛ける）と、画面の端からの間
#[cfg(desktop)]
const NOTICE_WIDTH: f64 = 440.0;
#[cfg(desktop)]
const NOTICE_MARGIN: f64 = 12.0;
/// 知らせがないときに置いておく所（どの画面にもかからない。物理の点）
#[cfg(desktop)]
const PARKED: i32 = -30000;

/// × を押したとき、インジケーターに残すか（はじめは残す。画面の設定から変える）
static CLOSE_TO_TRAY: AtomicBool = AtomicBool::new(true);

/// メインの窓を前に出す（隠していれば出し、最小化していれば戻す）。スマホでは何もしない（窓は 1 つで、いつも前）
#[cfg(desktop)]
pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(MAIN_LABEL) {
        set_webview_visible(&w, true);
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(not(desktop))]
pub fn show_main(_app: &AppHandle) {}

/// WebView2 に、見えているかを伝える。隠した・最小化した窓では false にして、描くのを止める
/// （wry は窓を隠しても見えている扱いのまま描き続ける。false のあいだも JavaScript は動く〔おしらせの問い合わせは続く〕。
/// 隠れているページと同じ扱いになり、アニメーションは止まり、タイマーはゆっくりになる）
#[cfg(windows)]
pub fn set_webview_visible(w: &tauri::WebviewWindow, visible: bool) {
    let _ = w.with_webview(move |webview| unsafe {
        let _ = webview.controller().SetIsVisible(visible);
    });
}

#[cfg(all(desktop, not(windows)))]
pub fn set_webview_visible(_w: &tauri::WebviewWindow, _visible: bool) {}

/// 起動したときに: おしらせの窓（隠しておく）・インジケーター・メインの窓の × の扱い
#[cfg(desktop)]
pub fn setup(app: &tauri::App) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
    use tauri::{Emitter, WebviewUrl, WebviewWindowBuilder, WindowEvent};

    // はじめから出しておく（画面の外に。入力の場所を取らないよう、出すのはこの 1 回だけ）
    let notice = WebviewWindowBuilder::new(app, NOTICE_LABEL, WebviewUrl::App("index.html".into()))
        .title("Life Manager のおしらせ")
        .inner_size(NOTICE_WIDTH, 120.0)
        .position(PARKED as f64, PARKED as f64)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .maximizable(false)
        .minimizable(false)
        .focused(false)
        .focusable(false)
        .visible(true)
        .build()?;
    // おしらせの窓は閉じない（ほかのアプリから閉じる知らせが来ても残す。アプリを終えるときは、いっしょに消える）
    notice.on_window_event(|event| {
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
        }
    });

    let open = MenuItem::with_id(app, "open", "Life Manager を開く", true, None::<&str>)?;
    let separator = PredefinedMenuItem::separator(app)?;
    let quit = MenuItem::with_id(app, "quit", "終了する", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&open, &separator, &quit])?;
    let mut tray = TrayIconBuilder::with_id("main")
        .tooltip("Life Manager")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "open" => show_main(app),
            "quit" => app.exit(0),
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        });
    if let Some(icon) = app.default_window_icon() {
        tray = tray.icon(icon.clone());
    }
    tray.build(app)?;

    if let Some(main) = app.get_webview_window(MAIN_LABEL) {
        let handle = app.handle().clone();
        main.on_window_event(move |event| match event {
            WindowEvent::CloseRequested { api, .. } => {
                if CLOSE_TO_TRAY.load(Ordering::SeqCst) {
                    api.prevent_close();
                    if let Some(w) = handle.get_webview_window(MAIN_LABEL) {
                        let _ = w.hide();
                        set_webview_visible(&w, false);
                    }
                    // はじめて残したときは、どこに残ったかを知らせる（おしらせの窓が出す）
                    let _ = handle.emit_to(NOTICE_LABEL, "lm-to-tray", ());
                } else {
                    // おしらせの窓が残っていると終わらないので、アプリごと終える
                    handle.exit(0);
                }
            }
            // 最小化したら描くのを止め、戻したら描く。最小化の直後にも Focused(true) が来るので、最小化していないかを確かめてから起こす
            WindowEvent::Resized(_) | WindowEvent::Focused(true) => {
                if let Some(w) = handle.get_webview_window(MAIN_LABEL) {
                    let minimized = w.is_minimized().unwrap_or(false);
                    let visible = w.is_visible().unwrap_or(true);
                    set_webview_visible(&w, visible && !minimized);
                }
            }
            _ => {}
        });
    }
    Ok(())
}

/// おしらせの窓の高さを中身に合わせ、選んだ角に置く（0 なら画面の外へ退ける）。height は画面の点（CSS の px）。
/// スマホにはおしらせの窓がないので、何もしない
#[cfg(not(desktop))]
#[tauri::command]
pub fn notice_fit(_app: AppHandle, _height: f64, _corner: String) -> Result<(), String> {
    Ok(())
}

#[cfg(desktop)]
#[tauri::command]
pub fn notice_fit(app: AppHandle, height: f64, corner: String) -> Result<(), String> {
    let Some(w) = app.get_webview_window(NOTICE_LABEL) else { return Ok(()) };
    if height <= 0.0 {
        let _ = w.set_position(tauri::PhysicalPosition::new(PARKED, PARKED));
        return Ok(());
    }
    // メインの窓がある画面（隠しているときは、いちばんの画面）
    let main_visible = app.get_webview_window(MAIN_LABEL).map(|m| m.is_visible().unwrap_or(false)).unwrap_or(false);
    let monitor = if main_visible {
        app.get_webview_window(MAIN_LABEL).and_then(|m| m.current_monitor().ok().flatten())
    } else {
        None
    }
    .or_else(|| app.primary_monitor().ok().flatten());
    let Some(monitor) = monitor else { return Ok(()) };
    let scale = monitor.scale_factor();
    let area = monitor.work_area();
    let (ax, ay) = (area.position.x as f64, area.position.y as f64);
    let (aw, ah) = (area.size.width as f64, area.size.height as f64);
    let width = NOTICE_WIDTH * scale;
    let height = (height * scale).min(ah * 0.85).max(1.0);
    let margin = NOTICE_MARGIN * scale;
    let x = if corner.ends_with("left") { ax + margin } else { ax + aw - width - margin };
    let y = if corner.starts_with("bottom") { ay + ah - height - margin } else { ay + margin };
    // 先に移してから大きさを合わせる（拡大率の違う画面へ移ったとき、Windows が大きさを変えることがあるため）
    let _ = w.set_position(tauri::PhysicalPosition::new(x.round() as i32, y.round() as i32));
    let _ = w.set_size(tauri::PhysicalSize::new(width.round() as u32, height.round() as u32));
    Ok(())
}

/// おしらせの「開く」: メインの窓を前に出す
#[tauri::command]
pub fn focus_main(app: AppHandle) {
    show_main(&app);
}

/// × を押したとき、インジケーターに残すか（画面の設定から）
#[tauri::command]
pub fn set_close_to_tray(on: bool) {
    CLOSE_TO_TRAY.store(on, Ordering::SeqCst);
}

/// インジケーターのメニューの字を、画面の言語にする（#256）。字は画面の側が訳して渡す。スマホでは何もしない
#[cfg(desktop)]
#[tauri::command]
pub fn set_tray_labels(app: AppHandle, open: String, quit: String) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
    let Some(tray) = app.tray_by_id("main") else {
        return Ok(());
    };
    let open = MenuItem::with_id(&app, "open", &open, true, None::<&str>).map_err(|e| e.to_string())?;
    let separator = PredefinedMenuItem::separator(&app).map_err(|e| e.to_string())?;
    let quit = MenuItem::with_id(&app, "quit", &quit, true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(&app, &[&open, &separator, &quit]).map_err(|e| e.to_string())?;
    tray.set_menu(Some(menu)).map_err(|e| e.to_string())
}

#[cfg(not(desktop))]
#[tauri::command]
pub fn set_tray_labels(_app: AppHandle, _open: String, _quit: String) -> Result<(), String> {
    Ok(())
}
