//! The clipboard, with the three registered formats that keep a secret out of Windows's
//! history and cloud sync (VERIFY_NOTES item 19). A secret is cleared later only if the
//! clipboard's sequence number shows nobody has copied anything since.

pub const EXCLUDE_MONITOR: &str = "ExcludeClipboardContentFromMonitorProcessing";
pub const CAN_INCLUDE_HISTORY: &str = "CanIncludeInClipboardHistory";
pub const CAN_UPLOAD_CLOUD: &str = "CanUploadToCloudClipboard";

pub trait ClipboardOs {
    /// Puts text on the clipboard, returning the sequence number afterwards.
    fn write(&mut self, text: &str, secret: bool) -> Result<u32, String>;
    fn sequence(&self) -> u32;
    fn empty(&mut self) -> Result<(), String>;
}

pub struct Clip<O: ClipboardOs> {
    os: O,
    /// The sequence number right after our last secret went on.
    ours: Option<u32>,
    /// Bumped on every secret copy, so a timer from an older copy does nothing.
    generation: u64,
}

impl<O: ClipboardOs> Clip<O> {
    pub fn new(os: O) -> Self {
        Self { os, ours: None, generation: 0 }
    }

    /// Returns the generation to hand to `clear_if_current` later.
    pub fn copy_secret(&mut self, text: &str) -> Result<u64, String> {
        let seq = self.os.write(text, true)?;
        self.ours = Some(seq);
        self.generation += 1;
        Ok(self.generation)
    }

    pub fn copy_plain(&mut self, text: &str) -> Result<(), String> {
        self.os.write(text, false)?;
        self.ours = None;
        Ok(())
    }

    /// True if it cleared. Anything copied since then is the person's, and stays.
    pub fn clear_if_ours(&mut self) -> Result<bool, String> {
        match self.ours {
            Some(seq) if self.os.sequence() == seq => {
                self.os.empty()?;
                self.ours = None;
                Ok(true)
            }
            _ => {
                self.ours = None;
                Ok(false)
            }
        }
    }

    /// For a timer: does nothing if a newer copy has happened since this timer started.
    pub fn clear_if_current(&mut self, generation: u64) -> Result<bool, String> {
        if generation != self.generation {
            return Ok(false);
        }
        self.clear_if_ours()
    }

    pub fn os(&self) -> &O {
        &self.os
    }
}

// ---- The real clipboard ----

pub struct Win32Clipboard;

mod win32 {
    use super::*;
    use windows::core::{w, HSTRING, PCWSTR};
    use windows::Win32::Foundation::{GlobalFree, HANDLE, HGLOBAL, HWND};
    use windows::Win32::System::DataExchange::{CloseClipboard, EmptyClipboard, GetClipboardSequenceNumber, OpenClipboard, RegisterClipboardFormatW, SetClipboardData};
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Memory::{GlobalAlloc, GlobalLock, GlobalUnlock, GMEM_MOVEABLE};
    use windows::Win32::System::Ole::CF_UNICODETEXT;
    use windows::Win32::UI::WindowsAndMessaging::{CreateWindowExW, DestroyWindow, HWND_MESSAGE, WINDOW_EX_STYLE, WINDOW_STYLE};

    /// SetClipboardData fails if the clipboard has no owner, so it needs some window.
    /// A message-only one for just this call.
    struct OwnerWindow(HWND);

    impl OwnerWindow {
        fn new() -> Result<Self, String> {
            // SAFETY: STATIC is a built-in class; the window's destroyed on drop.
            let hwnd = unsafe {
                let module = GetModuleHandleW(PCWSTR::null()).map_err(|e| e.to_string())?;
                CreateWindowExW(WINDOW_EX_STYLE(0), w!("STATIC"), PCWSTR::null(), WINDOW_STYLE(0), 0, 0, 0, 0, Some(HWND_MESSAGE), None, Some(module.into()), None)
            }
            .map_err(|e| e.to_string())?;
            Ok(Self(hwnd))
        }
    }

    impl Drop for OwnerWindow {
        fn drop(&mut self) {
            // SAFETY: from CreateWindowExW on this thread.
            unsafe {
                let _ = DestroyWindow(self.0);
            }
        }
    }

    /// Other apps hold the clipboard for moments at a time.
    struct Open;

    impl Open {
        fn new(owner: HWND) -> Result<Self, String> {
            for _ in 0..25 {
                // SAFETY: owner is a live window.
                if unsafe { OpenClipboard(Some(owner)) }.is_ok() {
                    return Ok(Self);
                }
                std::thread::sleep(std::time::Duration::from_millis(20));
            }
            Err("Another app is holding the clipboard".to_string())
        }
    }

    impl Drop for Open {
        fn drop(&mut self) {
            // SAFETY: only exists while open.
            unsafe {
                let _ = CloseClipboard();
            }
        }
    }

    fn global_copy(bytes: &[u8]) -> Result<HGLOBAL, String> {
        // SAFETY: the allocation is at least bytes.len(), and on failure it's freed. On
        // success the clipboard owns it.
        unsafe {
            let mem = GlobalAlloc(GMEM_MOVEABLE, bytes.len().max(1)).map_err(|e| e.to_string())?;
            let p = GlobalLock(mem) as *mut u8;
            if p.is_null() {
                let _ = GlobalFree(Some(mem));
                return Err("GlobalLock failed".to_string());
            }
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), p, bytes.len());
            let _ = GlobalUnlock(mem);
            Ok(mem)
        }
    }

    fn set_format(format: u32, bytes: &[u8]) -> Result<(), String> {
        let mem = global_copy(bytes)?;
        // SAFETY: the clipboard is open and owned by us, and takes the memory on success.
        unsafe { SetClipboardData(format, Some(HANDLE(mem.0))) }.map_err(|e| {
            // SAFETY: not taken on failure.
            unsafe {
                let _ = GlobalFree(Some(mem));
            }
            e.to_string()
        })?;
        Ok(())
    }

    fn register(name: &str) -> u32 {
        // SAFETY: a valid null-terminated string for the call's duration.
        unsafe { RegisterClipboardFormatW(PCWSTR(HSTRING::from(name).as_ptr())) }
    }

    impl ClipboardOs for Win32Clipboard {
        fn write(&mut self, text: &str, secret: bool) -> Result<u32, String> {
            let owner = OwnerWindow::new()?;
            let mut utf16: Vec<u8> = text.encode_utf16().flat_map(u16::to_le_bytes).collect();
            utf16.extend_from_slice(&[0, 0]);
            let result = (|| {
                let _open = Open::new(owner.0)?;
                // SAFETY: open, and we own it from here.
                unsafe { EmptyClipboard() }.map_err(|e| e.to_string())?;
                if secret {
                    // Same open as the text, so no monitor ever sees the text without them.
                    set_format(register(EXCLUDE_MONITOR), &[0])?;
                    set_format(register(CAN_INCLUDE_HISTORY), &0u32.to_le_bytes())?;
                    set_format(register(CAN_UPLOAD_CLOUD), &0u32.to_le_bytes())?;
                }
                set_format(CF_UNICODETEXT.0 as u32, &utf16)
            })();
            zeroize::Zeroize::zeroize(&mut utf16);
            result?;
            Ok(self.sequence())
        }

        fn sequence(&self) -> u32 {
            // SAFETY: no arguments.
            unsafe { GetClipboardSequenceNumber() }
        }

        fn empty(&mut self) -> Result<(), String> {
            let owner = OwnerWindow::new()?;
            let _open = Open::new(owner.0)?;
            // SAFETY: open.
            unsafe { EmptyClipboard() }.map_err(|e| e.to_string())
        }
    }
}

/// An in-memory clipboard for tests, including the app's e2e build, which mustn't overwrite
/// whatever the person running the tests has on their real clipboard.
#[derive(Default)]
pub struct FakeClipboard {
    pub text: Option<String>,
    pub secret: bool,
    pub seq: u32,
}

impl ClipboardOs for FakeClipboard {
    fn write(&mut self, text: &str, secret: bool) -> Result<u32, String> {
        self.text = Some(text.to_string());
        self.secret = secret;
        self.seq += 4;
        Ok(self.seq)
    }
    fn sequence(&self) -> u32 {
        self.seq
    }
    fn empty(&mut self) -> Result<(), String> {
        self.text = None;
        self.seq += 1;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clears_only_if_still_ours() {
        let mut c = Clip::new(FakeClipboard::default());
        c.copy_secret("hunter2").unwrap();
        assert!(c.os().secret, "marked as a secret");
        assert!(c.clear_if_ours().unwrap());
        assert_eq!(c.os().text, None);
    }

    #[test]
    fn leaves_what_the_person_copied_since() {
        let mut c = Clip::new(FakeClipboard::default());
        c.copy_secret("hunter2").unwrap();
        // Another app copies something.
        c.os.text = Some("their text".into());
        c.os.seq += 1;
        assert!(!c.clear_if_ours().unwrap());
        assert_eq!(c.os().text.as_deref(), Some("their text"));
        // And a later clear doesn't either: it's no longer ours.
        assert!(!c.clear_if_ours().unwrap());
        assert_eq!(c.os().text.as_deref(), Some("their text"));
    }

    #[test]
    fn an_old_timer_does_not_clear_a_newer_copy_early() {
        let mut c = Clip::new(FakeClipboard::default());
        let first = c.copy_secret("one").unwrap();
        let second = c.copy_secret("two").unwrap();
        assert!(!c.clear_if_current(first).unwrap());
        assert_eq!(c.os().text.as_deref(), Some("two"));
        assert!(c.clear_if_current(second).unwrap());
        assert_eq!(c.os().text, None);
    }

    #[test]
    fn plain_copies_are_never_marked_or_cleared() {
        let mut c = Clip::new(FakeClipboard::default());
        c.copy_plain("a username").unwrap();
        assert!(!c.os().secret);
        assert!(!c.clear_if_ours().unwrap());
        assert_eq!(c.os().text.as_deref(), Some("a username"));
    }

    #[test]
    fn a_plain_copy_after_a_secret_keeps_the_plain_one() {
        let mut c = Clip::new(FakeClipboard::default());
        let g = c.copy_secret("secret").unwrap();
        c.copy_plain("name").unwrap();
        assert!(!c.clear_if_current(g).unwrap());
        assert_eq!(c.os().text.as_deref(), Some("name"));
    }
}
