//! What the two pages can ask for. The overlay is the less trusted one: it gets titles and
//! usernames to show, never a secret, and can't call anything marked `main_only`.
use std::time::{Duration, Instant};

use promptly_native::autotype::{self, AutoTypeError, Key, Request as TypeRequest, Target, Win32Desktop};
use promptly_native::{backup, nmhost, reg};
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use zeroize::{Zeroize, Zeroizing};

use crate::state::App;
use crate::updater;
use crate::windows_ui;

pub fn main_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "main" {
        Ok(())
    } else {
        Err("Not allowed from this window".to_string())
    }
}

fn overlay_only(window: &WebviewWindow) -> Result<(), String> {
    if window.label() == "overlay" {
        Ok(())
    } else {
        Err("Not allowed from this window".to_string())
    }
}

fn hwnd_of(window: &WebviewWindow) -> Result<isize, String> {
    window.hwnd().map(|h| h.0 as isize).map_err(|e| e.to_string())
}

// ---- Connection ----

#[derive(Serialize)]
pub struct Connection {
    server: String,
    device_id: Option<String>,
    user_id: Option<String>,
}

#[tauri::command]
pub fn connection_get(window: WebviewWindow, app: State<'_, App>) -> Result<Option<Connection>, String> {
    main_only(&window)?;
    let s = app.settings.lock().unwrap();
    let has_token = app.token.lock().unwrap().is_some();
    Ok(match (&s.server, has_token) {
        (Some(server), true) => Some(Connection { server: server.clone(), device_id: s.device_id.clone(), user_id: s.user_id.clone() }),
        _ => None,
    })
}

/// Checks the address and remembers it, so the public connect calls can reach it.
#[tauri::command]
pub fn connection_begin(window: WebviewWindow, app: State<'_, App>, server: String) -> Result<String, String> {
    main_only(&window)?;
    // Never while connected: pointing at a new address must not be a way to move the token.
    if app.settings.lock().unwrap().server.is_some() || app.token.lock().unwrap().is_some() {
        return Err("This computer is already connected. Disconnect it first.".to_string());
    }
    let origin = promptly_native::net::normalise_server(&server).map_err(|e| e.to_string())?;
    *app.pending_server.lock().unwrap() = Some(origin.clone());
    Ok(origin)
}

/// Takes the token once and never gives it back.
#[tauri::command]
pub fn connection_save(window: WebviewWindow, app: State<'_, App>, token: String, device_id: String, user_id: String) -> Result<(), String> {
    main_only(&window)?;
    let server = app.pending_server.lock().unwrap().take().ok_or("No connection in progress")?;
    app.save_token(Zeroizing::new(token))?;
    {
        let mut s = app.settings.lock().unwrap();
        s.server = Some(server);
        s.device_id = Some(device_id);
        s.user_id = Some(user_id);
    }
    app.save_settings()
}

#[tauri::command]
pub fn connection_clear(window: WebviewWindow, app: State<'_, App>) -> Result<(), String> {
    main_only(&window)?;
    app.clear_token();
    {
        let mut s = app.settings.lock().unwrap();
        s.server = None;
        s.device_id = None;
        s.user_id = None;
    }
    let _ = app.hello.disable();
    app.save_settings()
}

#[tauri::command]
pub fn device_name(window: WebviewWindow) -> Result<String, String> {
    main_only(&window)?;
    let host = std::env::var("COMPUTERNAME").unwrap_or_default();
    Ok(if host.is_empty() { "Windows app".to_string() } else { format!("Windows app on {host}") })
}

#[tauri::command]
pub fn open_external(window: WebviewWindow, url: String) -> Result<(), String> {
    main_only(&window)?;
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web addresses open from here".to_string());
    }
    #[cfg(feature = "e2e")]
    if std::env::var_os("PROMPTLY_PW_NO_BROWSER").is_some() {
        return Ok(());
    }
    windows_ui::open_in_browser(&url)
}

// ---- Clipboard ----

const DEFAULT_CLEAR_SECS: u64 = 30;

#[tauri::command]
pub fn clipboard_copy(window: WebviewWindow, app: AppHandle, mut text: String, sensitive: bool, seconds: Option<u64>) -> Result<(), String> {
    main_only(&window)?;
    copy_now(&app, &text, sensitive, seconds)?;
    text.zeroize();
    Ok(())
}

pub fn copy_now(app: &AppHandle, text: &str, sensitive: bool, seconds: Option<u64>) -> Result<(), String> {
    let state = app.state::<App>();
    if !sensitive {
        return state.clip.lock().unwrap().copy_plain(text);
    }
    let generation = state.clip.lock().unwrap().copy_secret(text)?;
    let secs = seconds.unwrap_or(DEFAULT_CLEAR_SECS).clamp(5, 600);
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(Duration::from_secs(secs)).await;
        let _ = app.state::<App>().clip.lock().unwrap().clear_if_current(generation);
    });
    Ok(())
}

#[tauri::command]
pub fn clipboard_clear(window: WebviewWindow, app: State<'_, App>) -> Result<bool, String> {
    main_only(&window)?;
    app.clip.lock().unwrap().clear_if_ours()
}

// ---- Windows Hello ----

#[derive(Serialize)]
pub struct HelloStatus {
    available: bool,
    enabled: bool,
}

/// These block on Windows's own prompt, so they run on a worker thread.
#[tauri::command]
pub async fn hello_status(window: WebviewWindow, app: AppHandle) -> Result<HelloStatus, String> {
    main_only(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<App>();
        HelloStatus { available: state.hello.available(), enabled: state.hello.is_enabled() }
    })
    .await
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn hello_enable(window: WebviewWindow, app: AppHandle, request: Request<'_>) -> Result<(), String> {
    main_only(&window)?;
    let raw = match request.body() {
        InvokeBody::Raw(b) => Zeroizing::new(b.clone()),
        _ => return Err("expected raw bytes".to_string()),
    };
    let hwnd = hwnd_of(&window)?;
    tauri::async_runtime::spawn_blocking(move || app.state::<App>().hello.enable(hwnd, &raw, "Turn on Windows Hello unlock for Promptly Passwords").map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn hello_unlock(window: WebviewWindow, app: AppHandle) -> Result<Response, String> {
    main_only(&window)?;
    let hwnd = hwnd_of(&window)?;
    let secret = tauri::async_runtime::spawn_blocking(move || app.state::<App>().hello.unlock(hwnd, "Unlock Promptly Passwords").map_err(|e| e.to_string()))
        .await
        .map_err(|e| e.to_string())??;
    Ok(Response::new(secret.to_vec()))
}

#[tauri::command]
pub fn hello_disable(window: WebviewWindow, app: State<'_, App>) -> Result<(), String> {
    main_only(&window)?;
    app.hello.disable().map_err(|e| e.to_string())
}

// ---- Start with Windows ----

#[tauri::command]
pub fn autostart_get(window: WebviewWindow) -> Result<bool, String> {
    main_only(&window)?;
    Ok(reg::autostart_enabled())
}

#[tauri::command]
pub fn autostart_set(window: WebviewWindow, on: bool) -> Result<(), String> {
    main_only(&window)?;
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    reg::set_autostart(&exe.to_string_lossy(), on)
}

// ---- Backup ----

#[derive(Serialize)]
pub struct BackupStatus {
    enabled: bool,
    dir: String,
    every_hours: u32,
    keep: u32,
    last_run_ms: u64,
    last_error: Option<String>,
    has_password: bool,
    due: bool,
    default_dir: String,
}

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn default_backup_dir() -> String {
    let home = std::env::var("USERPROFILE").unwrap_or_default();
    format!(r"{home}\Documents\Promptly Passwords backups")
}

#[tauri::command]
pub fn backup_status(window: WebviewWindow, app: State<'_, App>) -> Result<BackupStatus, String> {
    main_only(&window)?;
    let s = app.settings.lock().unwrap().backup.clone();
    let every_hours = if s.every_hours == 0 { 24 } else { s.every_hours };
    Ok(BackupStatus {
        enabled: s.enabled,
        dir: if s.dir.is_empty() { default_backup_dir() } else { s.dir.clone() },
        every_hours,
        keep: if s.keep == 0 { 14 } else { s.keep },
        last_run_ms: s.last_run_ms,
        last_error: s.last_error.clone(),
        has_password: app.backup_password().is_some(),
        due: backup::is_due(s.enabled, s.last_run_ms, every_hours, now_ms()),
        default_dir: default_backup_dir(),
    })
}

#[tauri::command]
pub fn backup_configure(window: WebviewWindow, app: State<'_, App>, enabled: bool, dir: String, every_hours: u32, keep: u32) -> Result<(), String> {
    main_only(&window)?;
    let dir = dir.trim().to_string();
    if enabled && !std::path::Path::new(&dir).is_absolute() {
        return Err("Use a full folder path, like C:\\Backups".to_string());
    }
    {
        let mut s = app.settings.lock().unwrap();
        s.backup.enabled = enabled;
        s.backup.dir = dir;
        s.backup.every_hours = every_hours.clamp(1, 24 * 30);
        s.backup.keep = keep.clamp(1, 365);
    }
    app.save_settings()
}

/// `data` must already be an encrypted export. `backup::save` checks, and refuses otherwise.
#[tauri::command]
pub fn backup_save(window: WebviewWindow, app: State<'_, App>, data: String, stamp: String) -> Result<String, String> {
    main_only(&window)?;
    let (dir, keep) = {
        let s = app.settings.lock().unwrap();
        let dir = if s.backup.dir.is_empty() { default_backup_dir() } else { s.backup.dir.clone() };
        (dir, if s.backup.keep == 0 { 14 } else { s.backup.keep })
    };
    let result = backup::save(std::path::Path::new(&dir), &stamp, &data, keep);
    {
        let mut s = app.settings.lock().unwrap();
        match &result {
            Ok(_) => {
                s.backup.last_run_ms = now_ms();
                s.backup.last_error = None;
            }
            Err(e) => s.backup.last_error = Some(e.clone()),
        }
    }
    app.save_settings()?;
    result.map(|p| p.to_string_lossy().to_string())
}

#[tauri::command]
pub fn backup_password_set(window: WebviewWindow, app: State<'_, App>, mut password: String) -> Result<(), String> {
    main_only(&window)?;
    let r = app.save_backup_password(password.as_bytes());
    password.zeroize();
    r
}

#[tauri::command]
pub fn backup_password_get(window: WebviewWindow, app: State<'_, App>) -> Result<Option<String>, String> {
    main_only(&window)?;
    Ok(app.backup_password().and_then(|p| String::from_utf8(p.to_vec()).ok()))
}

// ---- Native messaging host ----

#[derive(Serialize)]
pub struct NativeHostStatus {
    extension_ids: Vec<String>,
    firefox_id: &'static str,
}

#[tauri::command]
pub fn native_host_status(window: WebviewWindow, app: State<'_, App>) -> Result<NativeHostStatus, String> {
    main_only(&window)?;
    Ok(NativeHostStatus { extension_ids: app.settings.lock().unwrap().extension_ids.clone(), firefox_id: nmhost::FIREFOX_ID })
}

/// Off removes every registration. On writes the manifests with exactly these ids.
#[tauri::command]
pub fn native_host_set(window: WebviewWindow, app: State<'_, App>, on: bool, extension_ids: Vec<String>) -> Result<(), String> {
    main_only(&window)?;
    if !on {
        nmhost::unregister()?;
        app.settings.lock().unwrap().extension_ids.clear();
        return app.save_settings();
    }
    if let Some(bad) = extension_ids.iter().find(|i| !nmhost::valid_extension_id(i)) {
        return Err(format!("{bad} isn't a browser extension id"));
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let host = exe.with_file_name("promptly-native-host.exe");
    if !host.exists() {
        return Err("The browser helper isn't installed next to the app".to_string());
    }
    #[cfg(feature = "e2e")]
    if std::env::var_os("PROMPTLY_PW_NO_REGISTRY").is_some() {
        app.settings.lock().unwrap().extension_ids = extension_ids;
        return app.save_settings();
    }
    nmhost::register(&app.data_dir, &host.to_string_lossy(), &extension_ids)?;
    app.settings.lock().unwrap().extension_ids = extension_ids;
    app.save_settings()
}

#[tauri::command]
pub fn updater_status(window: WebviewWindow, app: AppHandle) -> Result<bool, String> {
    main_only(&window)?;
    Ok(updater::enabled(&app))
}

#[tauri::command]
pub fn main_show(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    main_only(&window)?;
    windows_ui::show_main(&app);
    Ok(())
}

/// A new device is waiting, or no longer is. Nothing secret: a name the device gave itself.
#[tauri::command]
pub fn device_notice(window: WebviewWindow, app: AppHandle, count: u32, name: Option<String>, is_new: bool) -> Result<(), String> {
    main_only(&window)?;
    windows_ui::show_device_notice(&app, count, name.as_deref(), is_new);
    Ok(())
}

// ---- Quick search ----
//
// Overlay -> Rust -> main page and back. A secret only moves main page -> Rust. The gesture
// token is made in the shortcut handler and is the only thing that opens auto-type.

#[derive(Serialize, Clone)]
pub struct OverlayState {
    pub token: String,
    pub target_title: Option<String>,
}

#[derive(Deserialize, Serialize, Clone)]
pub struct QuickResult {
    id: String,
    title: String,
    subtitle: String,
    kind: String,
    has_totp: bool,
    can_type: bool,
    reprompt: bool,
}

#[derive(Serialize, Clone)]
struct SearchAsk {
    req: u64,
    q: String,
}

#[derive(Serialize, Clone)]
struct ActAsk {
    token: String,
    id: String,
    action: String,
    confirmed: bool,
}

#[tauri::command]
pub fn overlay_search(window: WebviewWindow, app: AppHandle, req: u64, q: String) -> Result<(), String> {
    overlay_only(&window)?;
    app.emit_to("main", "quick:search", SearchAsk { req, q }).map_err(|e| e.to_string())
}

/// `action`: copy, copy-user, totp or type. Needs a live gesture, so nothing else can drive it.
#[tauri::command]
pub fn overlay_act(window: WebviewWindow, app: AppHandle, token: String, id: String, action: String, confirmed: bool) -> Result<(), String> {
    overlay_only(&window)?;
    let state = app.state::<App>();
    state.gestures.lock().unwrap().target(&token, Instant::now()).map_err(|e| e.to_string())?;
    if !matches!(action.as_str(), "copy" | "copy-user" | "totp" | "type" | "type-code") {
        return Err("Unknown action".to_string());
    }
    app.emit_to("main", "quick:act", ActAsk { token, id, action, confirmed }).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn overlay_close(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    overlay_only(&window)?;
    windows_ui::hide_overlay(&app);
    Ok(())
}

#[tauri::command]
pub fn overlay_open_main(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    overlay_only(&window)?;
    windows_ui::hide_overlay(&app);
    windows_ui::show_main(&app);
    Ok(())
}

#[tauri::command]
pub fn quick_results(window: WebviewWindow, app: AppHandle, req: u64, results: Vec<QuickResult>, locked: bool) -> Result<(), String> {
    main_only(&window)?;
    app.emit_to("overlay", "quick:results", serde_json::json!({ "req": req, "results": results, "locked": locked })).map_err(|e| e.to_string())
}

/// The main page finished an action. `close` hides the overlay; `message` shows in it.
#[tauri::command]
pub fn quick_feedback(window: WebviewWindow, app: AppHandle, close: bool, message: Option<String>, mismatch: Option<serde_json::Value>) -> Result<(), String> {
    main_only(&window)?;
    if close {
        windows_ui::hide_overlay(&app);
    } else {
        app.emit_to("overlay", "quick:feedback", serde_json::json!({ "message": message, "mismatch": mismatch })).map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(tag = "outcome", rename_all = "snake_case")]
pub enum TypeOutcome {
    Typed { keys: usize },
    Mismatch { window: String, item: String },
    Failed { message: String },
}

/// Checks that don't use the gesture up happen first, so a title mismatch can be confirmed
/// with a second key press. After that it's single use, whatever happens.
#[tauri::command]
pub async fn autotype_perform(window: WebviewWindow, app: AppHandle, token: String, titles: Vec<String>, mut username: String, mut password: String, confirmed: bool) -> Result<TypeOutcome, String> {
    main_only(&window)?;
    let mut keys = autotype::plan_keys(&username, &password);
    username.zeroize();
    password.zeroize();
    let outcome = tauri::async_runtime::spawn_blocking(move || run_autotype(&app, &token, &titles, &mut keys, confirmed)).await.map_err(|e| e.to_string())?;
    Ok(outcome)
}

fn wipe_keys(keys: &mut [Key]) {
    for k in keys.iter_mut() {
        if let Key::Unit(u) = k {
            *u = 0;
        }
    }
}

fn run_autotype(app: &AppHandle, token: &str, titles: &[String], keys: &mut [Key], confirmed: bool) -> TypeOutcome {
    let state = app.state::<App>();
    let now = Instant::now();
    let peeked: Result<Option<Target>, AutoTypeError> = state.gestures.lock().unwrap().target(token, now).map(|t| t.cloned());
    let desktop = Win32Desktop;
    match peeked {
        Err(e) => {
            wipe_keys(keys);
            return TypeOutcome::Failed { message: e.to_string() };
        }
        Ok(None) => {
            wipe_keys(keys);
            return TypeOutcome::Failed { message: AutoTypeError::NoTarget.to_string() };
        }
        Ok(Some(target)) => {
            use promptly_native::autotype::Desktop;
            let title = desktop.title(target.window);
            if !confirmed && !autotype::any_title_matches(&title, titles) {
                wipe_keys(keys);
                return TypeOutcome::Mismatch { window: title, item: titles.first().cloned().unwrap_or_default() };
            }
        }
    }
    // From here the gesture is spent.
    let target = match state.gestures.lock().unwrap().take(token, now) {
        Ok(t) => t,
        Err(e) => {
            wipe_keys(keys);
            return TypeOutcome::Failed { message: e.to_string() };
        }
    };
    windows_ui::hide_overlay_keep_gesture_cleared(app);
    match autotype::perform(&desktop, &TypeRequest { target: &target, item_titles: titles, confirmed_mismatch: confirmed }, keys) {
        Ok(n) => TypeOutcome::Typed { keys: n },
        Err(e) => TypeOutcome::Failed { message: e.to_string() },
    }
}

// ---- Test build only ----

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_open_overlay(window: WebviewWindow, app: AppHandle) -> Result<String, String> {
    main_only(&window)?;
    Ok(windows_ui::open_overlay(&app, None))
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_clipboard(window: WebviewWindow, app: State<'_, App>) -> Result<serde_json::Value, String> {
    main_only(&window)?;
    let clip = app.clip.lock().unwrap();
    Ok(serde_json::json!({ "text": clip.os().text, "secret": clip.os().secret }))
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_hello_answer(window: WebviewWindow, app: State<'_, App>, approve: bool) -> Result<(), String> {
    main_only(&window)?;
    use promptly_native::hello::Verdict;
    *app.hello.gate.answer.lock().unwrap() = if approve { Verdict::Approved } else { Verdict::Cancelled };
    Ok(())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_device_notice(window: WebviewWindow, app: State<'_, App>) -> Result<Option<String>, String> {
    main_only(&window)?;
    Ok(app.device_notice.lock().unwrap().clone())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_open_settings(window: WebviewWindow, app: AppHandle) -> Result<(), String> {
    main_only(&window)?;
    app.emit_to("main", "app:settings", ()).map_err(|e| e.to_string())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_hide_main(window: WebviewWindow) -> Result<(), String> {
    main_only(&window)?;
    window.hide().map_err(|e| e.to_string())
}

#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_ssh_approve(window: WebviewWindow, approve: bool) -> Result<(), String> {
    main_only(&window)?;
    crate::ssh::E2E_APPROVE.store(approve, std::sync::atomic::Ordering::SeqCst);
    Ok(())
}

/// Stands in for the tray's Lock item and the sleep watcher, which send these.
#[cfg(feature = "e2e")]
#[tauri::command]
pub fn e2e_emit(window: WebviewWindow, app: AppHandle, event: String) -> Result<(), String> {
    main_only(&window)?;
    if !matches!(event.as_str(), "app:lock" | "power:resumed") {
        return Err("Not one of the test events".to_string());
    }
    app.emit_to("main", &event, ()).map_err(|e| e.to_string())
}
