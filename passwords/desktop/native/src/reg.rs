//! HKCU only: the start-with-Windows value and native messaging registrations. The app is
//! per-user and never asks for elevation.
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{ERROR_FILE_NOT_FOUND, ERROR_SUCCESS};
use windows::Win32::System::Registry::{RegDeleteKeyValueW, RegDeleteTreeW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ};

fn wide(s: &str) -> Vec<u16> {
    s.encode_utf16().chain(std::iter::once(0)).collect()
}

/// `name` of None sets the key's default value.
pub fn set_string(subkey: &str, name: Option<&str>, value: &str) -> Result<(), String> {
    let data = wide(value);
    let name = name.map(HSTRING::from);
    let name_ptr = name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
    // SAFETY: the strings outlive the call, and the length is in bytes including the null.
    let r = unsafe { RegSetKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(subkey), name_ptr, REG_SZ.0, Some(data.as_ptr() as *const _), (data.len() * 2) as u32) };
    if r == ERROR_SUCCESS {
        Ok(())
    } else {
        Err(format!("registry write failed: {}", r.0))
    }
}

pub fn get_string(subkey: &str, name: Option<&str>) -> Option<String> {
    let name = name.map(HSTRING::from);
    let name_ptr = name.as_ref().map_or(PCWSTR::null(), |n| PCWSTR(n.as_ptr()));
    let sub = HSTRING::from(subkey);
    let mut size = 0u32;
    // SAFETY: first call with no buffer gets the size.
    let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, &sub, name_ptr, RRF_RT_REG_SZ, None, None, Some(&mut size)) };
    if r != ERROR_SUCCESS || size == 0 {
        return None;
    }
    let mut buf = vec![0u16; (size as usize).div_ceil(2)];
    // SAFETY: the buffer is at least `size` bytes.
    let r = unsafe { RegGetValueW(HKEY_CURRENT_USER, &sub, name_ptr, RRF_RT_REG_SZ, None, Some(buf.as_mut_ptr() as *mut _), Some(&mut size)) };
    if r != ERROR_SUCCESS {
        return None;
    }
    let chars = (size as usize / 2).saturating_sub(1).min(buf.len());
    Some(String::from_utf16_lossy(&buf[..chars]))
}

pub fn delete_value(subkey: &str, name: &str) -> Result<(), String> {
    // SAFETY: both strings outlive the call.
    let r = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, &HSTRING::from(subkey), &HSTRING::from(name)) };
    if r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND || r.0 == 3 {
        Ok(())
    } else {
        Err(format!("registry delete failed: {}", r.0))
    }
}

pub fn delete_key(subkey: &str) -> Result<(), String> {
    // SAFETY: the string outlives the call.
    let r = unsafe { RegDeleteTreeW(HKEY_CURRENT_USER, &HSTRING::from(subkey)) };
    if r == ERROR_SUCCESS || r == ERROR_FILE_NOT_FOUND || r.0 == 3 {
        Ok(())
    } else {
        Err(format!("registry delete failed: {}", r.0))
    }
}

pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
pub const RUN_NAME: &str = "Promptly Passwords";

/// The value for the Run key: starts in the tray, with the window hidden.
pub fn run_command(exe: &str) -> String {
    format!("\"{exe}\" --hidden")
}

pub fn set_autostart(exe: &str, on: bool) -> Result<(), String> {
    if on {
        set_string(RUN_KEY, Some(RUN_NAME), &run_command(exe))
    } else {
        delete_value(RUN_KEY, RUN_NAME)
    }
}

pub fn autostart_enabled() -> bool {
    get_string(RUN_KEY, Some(RUN_NAME)).is_some()
}

#[cfg(test)]
mod tests {
    use super::*;

    // A key of our own under Software, removed at the end. Nothing of anyone else's.
    #[test]
    fn set_get_and_delete_a_test_key() {
        let key = format!(r"Software\PromptlyPasswordsTest\{}", crate::random_token());
        assert_eq!(get_string(&key, Some("v")), None);
        set_string(&key, Some("v"), "héllo 🔑").unwrap();
        assert_eq!(get_string(&key, Some("v")).as_deref(), Some("héllo 🔑"));
        set_string(&key, None, "default").unwrap();
        assert_eq!(get_string(&key, None).as_deref(), Some("default"));
        delete_value(&key, "v").unwrap();
        assert_eq!(get_string(&key, Some("v")), None);
        delete_value(&key, "v").unwrap();
        delete_key(r"Software\PromptlyPasswordsTest").unwrap();
        delete_key(r"Software\PromptlyPasswordsTest").unwrap();
    }

    #[test]
    fn run_command_starts_hidden_and_quotes_the_path() {
        assert_eq!(run_command(r"C:\Users\A B\app.exe"), r#""C:\Users\A B\app.exe" --hidden"#);
    }
}
