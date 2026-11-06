//! Windows, tray, the global shortcut, and the sleep watcher.
use std::time::{Duration, Instant, SystemTime};

#[cfg(not(feature = "e2e"))]
use promptly_native::autotype::{Desktop, Win32Desktop};
use promptly_native::autotype::Target;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Emitter, Manager, WebviewUrl, WebviewWindowBuilder, WindowEvent};
#[cfg(not(feature = "e2e"))]
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use crate::commands::OverlayState;
use crate::state::App;
use crate::updater;

/// Everything both windows' webviews share. WebView2 needs these to be the same across a
/// data folder, and timers must keep running while the window's hidden in the tray, or the
/// page's own sleep check reads a throttled timer as the machine having slept.
const BROWSER_ARGS: &str = "--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection,IntensiveWakeUpThrottling --disable-background-timer-throttling --disable-renderer-backgrounding";

fn allowed_navigation(url: &tauri::Url) -> bool {
    match url.scheme() {
        "tauri" => url.host_str() == Some("localhost"),
        "http" | "https" => url.host_str() == Some("tauri.localhost"),
        "blob" => url.path().starts_with("http://tauri.localhost/"),
        "about" => url.as_str() == "about:blank",
        _ => false,
    }
}

pub fn create_windows(app: &AppHandle, hidden: bool) -> tauri::Result<()> {
    let data_dir = app.state::<App>().data_dir.join("webview");
    let menu = app_menu(app)?;
    let main = WebviewWindowBuilder::new(app, "main", WebviewUrl::App("index.html".into()))
        .title("Promptly Passwords")
        .inner_size(1120.0, 760.0)
        .min_inner_size(420.0, 420.0)
        .center()
        .menu(menu)
        .visible(!hidden)
        .data_directory(data_dir.clone())
        .additional_browser_args(BROWSER_ARGS)
        // On by default, and it would keep what is typed in forms (item fields, even the Secret
        // Key) in plain text in the profile. The e2e disk scan found exactly that.
        .general_autofill_enabled(false)
        .on_navigation(allowed_navigation)
        .build()?;
    let app_for_main = app.clone();
    main.on_window_event(move |event| {
        // Closing the window keeps the app in the tray. Quit is in the tray menu.
        if let WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            if let Some(w) = app_for_main.get_webview_window("main") {
                let _ = w.hide();
            }
        }
    });
    main.on_menu_event(|window, event| handle_menu(window.app_handle(), event.id.as_ref()));

    let overlay = WebviewWindowBuilder::new(app, "overlay", WebviewUrl::App("overlay.html".into()))
        .title("Promptly quick search")
        .inner_size(640.0, 420.0)
        .resizable(false)
        .decorations(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .center()
        .visible(false)
        .data_directory(data_dir)
        .additional_browser_args(BROWSER_ARGS)
        // On by default, and it would keep what is typed in forms (item fields, even the Secret
        // Key) in plain text in the profile. The e2e disk scan found exactly that.
        .general_autofill_enabled(false)
        .on_navigation(allowed_navigation)
        .build()?;
    let app_for_overlay = app.clone();
    overlay.on_window_event(move |event| match event {
        WindowEvent::CloseRequested { api, .. } => {
            api.prevent_close();
            hide_overlay(&app_for_overlay);
        }
        // Clicking away dismisses it. The e2e build keeps it, since a test run can't count
        // on having real focus on someone's desktop.
        #[cfg(not(feature = "e2e"))]
        WindowEvent::Focused(false) => hide_overlay(&app_for_overlay),
        _ => {}
    });
    Ok(())
}

fn app_menu(app: &AppHandle) -> tauri::Result<Menu<tauri::Wry>> {
    let file = Submenu::with_items(
        app,
        "App",
        true,
        &[
            &MenuItem::with_id(app, "quick", "Quick search\tCtrl+Shift+Space", true, None::<&str>)?,
            &MenuItem::with_id(app, "lock", "Lock", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "Desktop settings…", true, None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "hide", "Close to tray", true, None::<&str>)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    Menu::with_items(app, &[&file])
}

pub fn create_tray(app: &AppHandle) -> tauri::Result<()> {
    let menu = Menu::with_items(
        app,
        &[
            &MenuItem::with_id(app, "open", "Open Promptly Passwords", true, None::<&str>)?,
            &MenuItem::with_id(app, "quick", "Quick search\tCtrl+Shift+Space", true, None::<&str>)?,
            &MenuItem::with_id(app, "lock", "Lock", true, None::<&str>)?,
            &MenuItem::with_id(app, "settings", "Desktop settings…", true, None::<&str>)?,
            &MenuItem::with_id(app, "updates", "Check for updates", updater::enabled(app), None::<&str>)?,
            &PredefinedMenuItem::separator(app)?,
            &MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?,
        ],
    )?;
    let icon = app.default_window_icon().cloned().ok_or(tauri::Error::InvalidIcon(std::io::Error::other("no app icon")))?;
    TrayIconBuilder::with_id("main")
        .icon(icon)
        .tooltip("Promptly Passwords")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| handle_menu(app, event.id.as_ref()))
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click { button: MouseButton::Left, button_state: MouseButtonState::Up, .. } = event {
                show_main(tray.app_handle());
            }
        })
        .build(app)?;
    Ok(())
}

fn handle_menu(app: &AppHandle, id: &str) {
    match id {
        "open" => show_main(app),
        "quick" => {
            open_overlay(app, None);
        }
        "lock" => {
            let _ = app.emit_to("main", "app:lock", ());
        }
        "settings" => {
            show_main(app);
            let _ = app.emit_to("main", "app:settings", ());
        }
        "updates" => updater::check_now(app.clone()),
        "hide" => {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.hide();
            }
        }
        "quit" => {
            // A secret on the clipboard shouldn't outlive the app.
            let _ = app.state::<App>().clip.lock().unwrap().clear_if_ours();
            app.exit(0);
        }
        _ => {}
    }
}

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

#[cfg(feature = "e2e")]
pub fn register_shortcut(_app: &AppHandle) {}

#[cfg(not(feature = "e2e"))]
pub fn register_shortcut(app: &AppHandle) {
    let shortcut = Shortcut::new(Some(Modifiers::CONTROL | Modifiers::SHIFT), Code::Space);
    let registered = app.global_shortcut().on_shortcut(shortcut, |app, _shortcut, event| {
        if event.state == ShortcutState::Pressed {
            let d = Win32Desktop;
            let w = d.foreground();
            // The window the person was in. Ours isn't a target.
            let target = (w.0 != 0 && !d.is_own(w)).then(|| Target { window: w, title: d.title(w) });
            open_overlay(app, target);
        }
    });
    // Another app may hold the keys. The app still works, and the settings screen says so.
    if let Err(e) = registered {
        eprintln!("quick search shortcut not available: {e}");
    }
}

/// The only place a gesture gets made. Returns its token.
pub fn open_overlay(app: &AppHandle, target: Option<Target>) -> String {
    let state = app.state::<App>();
    let target_title = target.as_ref().map(|t| t.title.clone());
    let token = state.gestures.lock().unwrap().issue(promptly_native::random_token(), target, Instant::now());
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.center();
        let _ = w.show();
        let _ = w.set_focus();
    }
    let _ = app.emit_to("overlay", "quick:open", OverlayState { token: token.clone(), target_title });
    token
}

pub fn hide_overlay(app: &AppHandle) {
    app.state::<App>().gestures.lock().unwrap().clear();
    hide_overlay_keep_gesture_cleared(app);
}

/// Auto-type has already used the gesture by the time it calls this.
pub fn hide_overlay_keep_gesture_cleared(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("overlay") {
        let _ = w.hide();
    }
    let _ = app.emit_to("overlay", "quick:closed", ());
}

/// A clock jump tells us the machine slept. Runs in Rust, so a throttled page can't miss it.
pub fn watch_for_sleep(app: AppHandle) {
    std::thread::spawn(move || {
        const TICK: Duration = Duration::from_secs(10);
        const SLEPT: Duration = Duration::from_secs(60);
        let mut last = SystemTime::now();
        loop {
            std::thread::sleep(TICK);
            let now = SystemTime::now();
            if now.duration_since(last).map(|d| d > SLEPT).unwrap_or(false) {
                let _ = app.emit_to("main", "power:resumed", ());
            }
            last = now;
        }
    });
}

pub fn open_in_browser(url: &str) -> Result<(), String> {
    promptly_native::dialog::open_url(url)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn url(s: &str) -> tauri::Url {
        s.parse().unwrap()
    }

    #[test]
    fn navigation_stays_inside_the_app() {
        assert!(allowed_navigation(&url("http://tauri.localhost/index.html")));
        assert!(allowed_navigation(&url("tauri://localhost/")));
        assert!(allowed_navigation(&url("about:blank")));
        assert!(allowed_navigation(&url("blob:http://tauri.localhost/1234")));
        assert!(!allowed_navigation(&url("https://evil.example.org/")));
        assert!(!allowed_navigation(&url("http://tauri.localhost.evil.org/")));
        assert!(!allowed_navigation(&url("http://localhost:8092/passwords")));
        assert!(!allowed_navigation(&url("file:///c:/windows/system32/calc.exe")));
        assert!(!allowed_navigation(&url("blob:https://evil.example.org/1234")));
        assert!(!allowed_navigation(&url("javascript:alert(1)")));
    }
}
