//! The real Win32 clipboard code, in a window station of its own. Clipboards belong to window
//! stations, so this can run on someone's desktop without touching what they've copied. It
//! checks that at the end by comparing the real station's sequence number.
use promptly_native::clipboard::{Clip, ClipboardOs, Win32Clipboard, CAN_INCLUDE_HISTORY, CAN_UPLOAD_CLOUD, EXCLUDE_MONITOR};
use windows::core::{HSTRING, PCWSTR};
use windows::Win32::Foundation::{GENERIC_ALL, HGLOBAL};
use windows::Win32::System::DataExchange::{CloseClipboard, GetClipboardData, GetClipboardSequenceNumber, IsClipboardFormatAvailable, OpenClipboard, RegisterClipboardFormatW};
use windows::Win32::System::Memory::{GlobalLock, GlobalSize, GlobalUnlock};
use windows::Win32::System::Ole::CF_UNICODETEXT;
use windows::Win32::System::StationsAndDesktops::{CreateDesktopW, CreateWindowStationW, GetProcessWindowStation, GetThreadDesktop, SetProcessWindowStation, SetThreadDesktop, DESKTOP_CONTROL_FLAGS};
use windows::Win32::System::Threading::GetCurrentThreadId;

fn format_id(name: &str) -> u32 {
    // SAFETY: a valid string for the call's duration.
    unsafe { RegisterClipboardFormatW(PCWSTR(HSTRING::from(name).as_ptr())) }
}

fn has(format: u32) -> bool {
    // SAFETY: plain query.
    unsafe { IsClipboardFormatAvailable(format) }.is_ok()
}

fn read_bytes(format: u32) -> Option<Vec<u8>> {
    // SAFETY: open and close are paired, and the handle is only read while it's locked.
    unsafe {
        OpenClipboard(None).ok()?;
        let out = (|| {
            let h = GetClipboardData(format).ok()?;
            let mem = HGLOBAL(h.0);
            let p = GlobalLock(mem) as *const u8;
            if p.is_null() {
                return None;
            }
            let bytes = std::slice::from_raw_parts(p, GlobalSize(mem)).to_vec();
            let _ = GlobalUnlock(mem);
            Some(bytes)
        })();
        let _ = CloseClipboard();
        out
    }
}

fn read_text() -> Option<String> {
    let bytes = read_bytes(CF_UNICODETEXT.0 as u32)?;
    let units: Vec<u16> = bytes.chunks_exact(2).map(|c| u16::from_le_bytes([c[0], c[1]])).take_while(|u| *u != 0).collect();
    Some(String::from_utf16_lossy(&units))
}

#[test]
fn real_clipboard_in_an_isolated_window_station() {
    // SAFETY: all handles are checked, and the originals are restored at the end.
    let (old_station, old_desktop, before) = unsafe {
        let old_station = GetProcessWindowStation().unwrap();
        let old_desktop = GetThreadDesktop(GetCurrentThreadId()).unwrap();
        let before = GetClipboardSequenceNumber();
        // No name: only administrators may choose one. Windows names it after the logon.
        let station = CreateWindowStationW(PCWSTR::null(), 0, GENERIC_ALL.0, None).unwrap();
        SetProcessWindowStation(station).unwrap();
        let desktop = CreateDesktopW(&HSTRING::from("d"), None, None, DESKTOP_CONTROL_FLAGS(0), GENERIC_ALL.0, None).unwrap();
        SetThreadDesktop(desktop).unwrap();
        (old_station, old_desktop, before)
    };

    let mut clip = Clip::new(Win32Clipboard);

    // A secret carries all three formats, with the values Microsoft documents.
    let generation = clip.copy_secret("hunter2 🔑").unwrap();
    assert_eq!(read_text().as_deref(), Some("hunter2 🔑"));
    assert!(has(format_id(EXCLUDE_MONITOR)), "exclude from monitors");
    assert!(has(format_id(CAN_INCLUDE_HISTORY)), "history flag");
    assert!(has(format_id(CAN_UPLOAD_CLOUD)), "cloud flag");
    assert_eq!(read_bytes(format_id(CAN_INCLUDE_HISTORY)).unwrap()[..4], 0u32.to_le_bytes());
    assert_eq!(read_bytes(format_id(CAN_UPLOAD_CLOUD)).unwrap()[..4], 0u32.to_le_bytes());

    // Reading didn't change whose it is, and clearing removes it.
    assert!(clip.clear_if_current(generation).unwrap());
    assert_eq!(read_text(), None);
    assert!(!has(format_id(EXCLUDE_MONITOR)));

    // Someone else copies after us: ours is gone, theirs stays.
    clip.copy_secret("secret again").unwrap();
    let mut other_app = Win32Clipboard;
    other_app.write("their text", false).unwrap();
    assert!(!clip.clear_if_ours().unwrap());
    assert_eq!(read_text().as_deref(), Some("their text"));

    // A plain copy has none of the marks.
    assert!(!has(format_id(EXCLUDE_MONITOR)));
    assert!(!has(format_id(CAN_INCLUDE_HISTORY)));
    assert!(!has(format_id(CAN_UPLOAD_CLOUD)));

    // SAFETY: the handles saved above are still valid.
    unsafe {
        SetThreadDesktop(old_desktop).unwrap();
        SetProcessWindowStation(old_station).unwrap();
        assert_eq!(GetClipboardSequenceNumber(), before, "the real clipboard wasn't touched");
    }
}
