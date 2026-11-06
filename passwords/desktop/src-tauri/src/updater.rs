//! The updater needs a key only the owner holds, so it stays off until
//! `plugins.updater.pubkey` and an endpoint are set in tauri.conf.json. Until then the plugin
//! isn't even registered. README.md has the steps. Its signature check can't be turned off,
//! which is why there's no way to run it without a key.
use tauri::AppHandle;

pub fn configured(config: Option<&serde_json::Value>) -> bool {
    let Some(c) = config else {
        return false;
    };
    let has_key = c["pubkey"].as_str().is_some_and(|k| !k.trim().is_empty());
    let has_endpoint = c["endpoints"].as_array().is_some_and(|e| !e.is_empty());
    has_key && has_endpoint
}

pub fn enabled(app: &AppHandle) -> bool {
    configured(app.config().plugins.0.get("updater"))
}

pub fn setup(app: &AppHandle) {
    if enabled(app) {
        if let Err(e) = app.plugin(tauri_plugin_updater::Builder::new().build()) {
            eprintln!("updater failed to start: {e}");
        }
    }
}

/// From the tray menu, only there when configured. Asks before installing.
pub fn check_now(app: AppHandle) {
    use tauri_plugin_updater::UpdaterExt;
    if !enabled(&app) {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let Ok(updater) = app.updater() else {
            return;
        };
        match updater.check().await {
            Ok(Some(update)) => {
                let question = format!("Version {} is ready. Install it now? The app will restart.", update.version);
                let yes = tauri::async_runtime::spawn_blocking(move || promptly_native::dialog::ask("Promptly Passwords", &question, 0)).await.unwrap_or(false);
                if yes && update.download_and_install(|_, _| {}, || {}).await.is_ok() {
                    app.restart();
                }
            }
            Ok(None) => {
                let _ = tauri::async_runtime::spawn_blocking(|| promptly_native::dialog::tell("Promptly Passwords", "You're on the latest version.")).await;
            }
            Err(e) => {
                let message = format!("Couldn't check for updates: {e}");
                let _ = tauri::async_runtime::spawn_blocking(move || promptly_native::dialog::tell("Promptly Passwords", &message)).await;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn off_until_there_is_a_key_and_an_endpoint() {
        assert!(!configured(None));
        assert!(!configured(Some(&json!({}))));
        assert!(!configured(Some(&json!({"pubkey": "", "endpoints": []}))));
        assert!(!configured(Some(&json!({"pubkey": "  ", "endpoints": ["https://x"]}))));
        assert!(!configured(Some(&json!({"pubkey": "abc", "endpoints": []}))));
        assert!(configured(Some(&json!({"pubkey": "abc", "endpoints": ["https://x"]}))));
    }

    /// The real config file ships with it off. A key added by accident would show here.
    #[test]
    fn the_checked_in_config_leaves_it_off() {
        let conf: serde_json::Value = serde_json::from_str(include_str!("../tauri.conf.json")).unwrap();
        assert!(!configured(conf["plugins"].get("updater")));
        assert_eq!(conf["bundle"]["createUpdaterArtifacts"], false);
    }
}
