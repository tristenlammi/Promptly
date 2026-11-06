//! Where things live on disk, and the small settings file. No secrets in `desktop.json`: the
//! device token and backup password are separate DPAPI-wrapped files.
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

pub const APP_DIR: &str = "org.promptly.passwords";

/// `%LOCALAPPDATA%\org.promptly.passwords`. Per machine, not roaming: DPAPI blobs and the
/// offline copy shouldn't follow a roaming profile around.
pub fn data_dir() -> PathBuf {
    let base = std::env::var_os("LOCALAPPDATA").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
    base.join(APP_DIR)
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct BackupSettings {
    pub enabled: bool,
    pub dir: String,
    pub every_hours: u32,
    pub keep: u32,
    pub last_run_ms: u64,
    pub last_error: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(default)]
pub struct Settings {
    pub server: Option<String>,
    pub device_id: Option<String>,
    pub user_id: Option<String>,
    pub ssh_agent: bool,
    pub backup: BackupSettings,
    /// Chrome-family extension ids this machine trusts for the native host.
    pub extension_ids: Vec<String>,
}

pub fn load(path: &Path) -> Settings {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

/// Written to a temp file and moved into place, so a crash can't leave half a file.
pub fn save(path: &Path, s: &Settings) -> Result<(), String> {
    if let Some(dir) = path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    }
    let tmp = path.with_extension("tmp");
    let data = serde_json::to_vec_pretty(s).map_err(|e| e.to_string())?;
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trip_and_safe_defaults() {
        let dir = std::env::temp_dir().join(format!("promptly-settings-{}", crate::random_token()));
        let path = dir.join("desktop.json");
        assert_eq!(load(&path), Settings::default());
        let s = Settings { server: Some("https://a.example".into()), ssh_agent: true, ..Default::default() };
        save(&path, &s).unwrap();
        assert_eq!(load(&path), s);
        // A damaged file gives defaults instead of a crash, and unknown fields are ignored.
        std::fs::write(&path, b"{not json").unwrap();
        assert_eq!(load(&path), Settings::default());
        std::fs::write(&path, br#"{"ssh_agent":true,"from_the_future":1}"#).unwrap();
        assert!(load(&path).ssh_agent);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_defaults_leave_the_optional_features_off() {
        let s = Settings::default();
        assert!(!s.ssh_agent);
        assert!(!s.backup.enabled);
        assert!(s.extension_ids.is_empty());
    }
}
