//! Native message boxes, and opening a web address in the person's browser.
use windows::core::{w, HSTRING};
use windows::Win32::Foundation::HWND;
use windows::Win32::UI::Shell::ShellExecuteW;
use windows::Win32::UI::WindowsAndMessaging::{MessageBoxW, IDYES, MB_DEFBUTTON2, MB_ICONINFORMATION, MB_ICONQUESTION, MB_OK, MB_SETFOREGROUND, MB_TOPMOST, MB_YESNO, SW_SHOWNORMAL};

/// Yes or no, with No as the default button, so a stray Enter refuses. Blocks.
pub fn ask(title: &str, text: &str, owner: isize) -> bool {
    // SAFETY: the strings outlive the call, and a null owner is allowed.
    let r = unsafe { MessageBoxW(Some(HWND(owner as *mut _)), &HSTRING::from(text), &HSTRING::from(title), MB_YESNO | MB_ICONQUESTION | MB_DEFBUTTON2 | MB_TOPMOST | MB_SETFOREGROUND) };
    r == IDYES
}

pub fn tell(title: &str, text: &str) {
    // SAFETY: as above.
    unsafe {
        MessageBoxW(None, &HSTRING::from(text), &HSTRING::from(title), MB_OK | MB_ICONINFORMATION | MB_TOPMOST);
    }
}

pub fn open_url(url: &str) -> Result<(), String> {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return Err("Only web addresses open from here".to_string());
    }
    // SAFETY: the strings outlive the call. Values over 32 mean it worked.
    let r = unsafe { ShellExecuteW(None, w!("open"), &HSTRING::from(url), None, None, SW_SHOWNORMAL) };
    if r.0 as isize > 32 {
        Ok(())
    } else {
        Err("Couldn't open your browser".to_string())
    }
}
