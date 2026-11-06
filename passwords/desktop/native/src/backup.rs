//! The scheduled backup file (PLAN 5.6): when it's due, what it's called, and keeping the
//! newest few. The encryption happens in the page with `core/exporter.ts`, so what reaches
//! this code is already an encrypted export. This code refuses to write anything else.
use std::path::{Path, PathBuf};

pub const PREFIX: &str = "promptly-vault-backup-";
pub const SUFFIX: &str = ".json";
const HOUR_MS: u64 = 3_600_000;

pub fn is_due(enabled: bool, last_run_ms: u64, every_hours: u32, now_ms: u64) -> bool {
    enabled && now_ms.saturating_sub(last_run_ms) >= (every_hours.max(1) as u64) * HOUR_MS
}

/// Only a real encrypted export, by its format header and payload field. A bug or a bad call
/// can't quietly put plain text on disk under a backup's name.
pub fn looks_encrypted(data: &str) -> bool {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(data) else {
        return false;
    };
    v["format"] == "promptly-pw-export" && v["version"] == 1 && v["data"].is_string() && v["salt"].is_string() && v.get("items").is_none()
}

/// A timestamped name inside `dir`, with no way to steer it elsewhere.
pub fn file_name(stamp: &str) -> Option<String> {
    let ok = !stamp.is_empty() && stamp.len() <= 32 && stamp.chars().all(|c| c.is_ascii_alphanumeric() || c == '-');
    ok.then(|| format!("{PREFIX}{stamp}{SUFFIX}"))
}

pub fn save(dir: &Path, stamp: &str, data: &str, keep: u32) -> Result<PathBuf, String> {
    if !looks_encrypted(data) {
        return Err("That isn't an encrypted export, so it wasn't written.".to_string());
    }
    let name = file_name(stamp).ok_or("Bad backup name")?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let path = dir.join(name);
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, data).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    prune(dir, keep)?;
    Ok(path)
}

/// Removes the oldest of *our* files beyond `keep`, judged by name, which has the date in it.
/// Nothing else in the folder is touched.
pub fn prune(dir: &Path, keep: u32) -> Result<(), String> {
    let mut ours: Vec<String> = std::fs::read_dir(dir)
        .map_err(|e| e.to_string())?
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .filter_map(|e| e.file_name().into_string().ok())
        .filter(|n| n.starts_with(PREFIX) && n.ends_with(SUFFIX))
        .collect();
    ours.sort();
    let keep = keep.max(1) as usize;
    if ours.len() > keep {
        for name in &ours[..ours.len() - keep] {
            std::fs::remove_file(dir.join(name)).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Dir(PathBuf);
    impl Dir {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!("promptly-backup-test-{}", crate::random_token()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    const EXPORT: &str = r#"{"format":"promptly-pw-export","version":1,"kdf":{},"salt":"AA","data":"AAAA"}"#;

    #[test]
    fn due_times() {
        let h = HOUR_MS;
        assert!(!is_due(false, 0, 24, 100 * h));
        assert!(is_due(true, 0, 24, 100 * h), "never run");
        assert!(!is_due(true, 90 * h, 24, 100 * h));
        assert!(is_due(true, 76 * h, 24, 100 * h));
        assert!(!is_due(true, 100 * h, 24, 99 * h), "a clock moved back isn't due");
        assert!(is_due(true, 99 * h, 0, 100 * h), "zero hours is treated as one");
    }

    #[test]
    fn refuses_anything_that_is_not_an_encrypted_export() {
        assert!(looks_encrypted(EXPORT));
        for bad in [
            "",
            "plain text",
            r#"{"format":"promptly-pw-plain","version":1,"items":[]}"#,
            r#"{"format":"promptly-pw-export","version":2,"salt":"A","data":"A"}"#,
            r#"{"format":"promptly-pw-export","version":1,"data":"A"}"#,
            r#"{"format":"promptly-pw-export","version":1,"salt":"A","data":"A","items":[{"password":"x"}]}"#,
        ] {
            assert!(!looks_encrypted(bad), "{bad}");
        }
        let d = Dir::new();
        assert!(save(&d.0, "2026-01-01", r#"{"format":"promptly-pw-plain","version":1,"items":[]}"#, 3).is_err());
        assert_eq!(std::fs::read_dir(&d.0).unwrap().count(), 0);
    }

    #[test]
    fn name_cannot_escape_the_folder() {
        assert_eq!(file_name("2026-11-06-1200").as_deref(), Some("promptly-vault-backup-2026-11-06-1200.json"));
        for bad in ["..\\evil", "../evil", "a/b", "a\\b", "a:b", "", "x.exe"] {
            assert_eq!(file_name(bad), None, "{bad}");
        }
    }

    #[test]
    fn keeps_the_newest_and_touches_nothing_else() {
        let d = Dir::new();
        std::fs::write(d.0.join("my-holiday-photo.jpg"), b"x").unwrap();
        std::fs::write(d.0.join("promptly-vault-backup-notes.txt"), b"x").unwrap();
        for stamp in ["2026-01-01", "2026-01-02", "2026-01-03", "2026-01-04"] {
            save(&d.0, stamp, EXPORT, 2).unwrap();
        }
        let mut names: Vec<String> = std::fs::read_dir(&d.0).unwrap().map(|e| e.unwrap().file_name().into_string().unwrap()).collect();
        names.sort();
        assert_eq!(names, ["my-holiday-photo.jpg", "promptly-vault-backup-2026-01-03.json", "promptly-vault-backup-2026-01-04.json", "promptly-vault-backup-notes.txt"]);
    }

    #[test]
    fn keep_of_zero_still_keeps_the_one_just_made() {
        let d = Dir::new();
        let path = save(&d.0, "2026-01-01", EXPORT, 0).unwrap();
        assert!(path.exists());
    }

    #[test]
    fn no_temp_file_left_behind() {
        let d = Dir::new();
        save(&d.0, "2026-01-01", EXPORT, 5).unwrap();
        assert!(std::fs::read_dir(&d.0).unwrap().all(|e| !e.unwrap().file_name().to_string_lossy().ends_with(".tmp")));
    }
}
