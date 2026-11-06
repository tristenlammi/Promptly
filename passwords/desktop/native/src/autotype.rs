//! Auto-type into native apps with `SendInput`: the only autofill path outside a browser.
//!
//! Three things have to be true before a key goes out:
//! 1. A gesture: the global shortcut, seen by Rust and turned into a single-use token that
//!    expires. The webview can't make one up, so nothing can type on its own.
//! 2. The window the person was in when they pressed the shortcut is the one in front.
//! 3. Its title matches the item's saved title, or the person looked at both and confirmed.
//!
//! Focus is checked again before every key, so typing stops if a window takes focus. There's
//! still a gap between that check and the key landing, and SECURITY.md says so.
use std::time::{Duration, Instant};

use zeroize::Zeroize;

pub const GESTURE_TTL: Duration = Duration::from_secs(60);
/// A shorter saved title would match almost any window.
pub const MIN_TITLE_LEN: usize = 3;
const MODIFIER_WAIT_TRIES: u32 = 150;
const MODIFIER_WAIT_MS: u64 = 20;
const FOCUS_TRIES: u32 = 40;
const FOCUS_WAIT_MS: u64 = 25;
const KEY_DELAY_MS: u64 = 4;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct WindowId(pub isize);

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub window: WindowId,
    pub title: String,
}

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum AutoTypeError {
    /// No gesture, or it's been used.
    NoGesture,
    GestureExpired,
    /// The shortcut was pressed with no usable window in front.
    NoTarget,
    /// Our own windows are never typed into.
    OwnWindow,
    /// The target runs elevated and this app doesn't, so Windows would silently drop the keys.
    Elevated,
    FocusLost,
    TitleMismatch { window: String, item: String },
    ModifiersHeld,
    NothingToType,
    SendFailed,
}

impl std::fmt::Display for AutoTypeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NoGesture => write!(f, "Auto-type needs the quick search shortcut first."),
            Self::GestureExpired => write!(f, "That took too long. Press the shortcut again."),
            Self::NoTarget => write!(f, "There was no window to type into."),
            Self::OwnWindow => write!(f, "Auto-type won't type into Promptly's own windows."),
            Self::Elevated => write!(f, "That window runs as administrator, so Windows blocks typing into it. Copy instead."),
            Self::FocusLost => write!(f, "The window lost focus, so typing stopped."),
            Self::TitleMismatch { window, item } => write!(f, "This window is \"{window}\", but the item is \"{item}\"."),
            Self::ModifiersHeld => write!(f, "Let go of Ctrl, Shift and Alt, then try again."),
            Self::NothingToType => write!(f, "This item has nothing to type."),
            Self::SendFailed => write!(f, "Windows refused the keystrokes."),
        }
    }
}

// ---- Gestures ----

struct Live {
    token: String,
    target: Option<Target>,
    issued: Instant,
}

/// At most one live gesture: pressing the shortcut again replaces the last.
#[derive(Default)]
pub struct Gestures {
    live: Option<Live>,
}

impl Gestures {
    /// Called only from the shortcut handler.
    pub fn issue(&mut self, token: String, target: Option<Target>, now: Instant) -> String {
        self.live = Some(Live { token: token.clone(), target, issued: now });
        token
    }

    /// The overlay asks what the gesture pointed at (to show it), without using it up.
    pub fn target(&self, token: &str, now: Instant) -> Result<Option<&Target>, AutoTypeError> {
        let live = self.live.as_ref().filter(|l| l.token == token).ok_or(AutoTypeError::NoGesture)?;
        if now.duration_since(live.issued) > GESTURE_TTL {
            return Err(AutoTypeError::GestureExpired);
        }
        Ok(live.target.as_ref())
    }

    /// The gesture is used up here, success or failure.
    pub fn take(&mut self, token: &str, now: Instant) -> Result<Target, AutoTypeError> {
        let live = self.live.take().ok_or(AutoTypeError::NoGesture)?;
        if live.token != token {
            // A wrong token doesn't burn the real one: it would let anything cancel a gesture.
            self.live = Some(live);
            return Err(AutoTypeError::NoGesture);
        }
        if now.duration_since(live.issued) > GESTURE_TTL {
            return Err(AutoTypeError::GestureExpired);
        }
        live.target.ok_or(AutoTypeError::NoTarget)
    }

    pub fn clear(&mut self) {
        self.live = None;
    }

    pub fn is_live(&self) -> bool {
        self.live.is_some()
    }
}

// ---- Title matching ----

fn normalise(s: &str) -> Vec<String> {
    s.chars()
        .map(|c| if c.is_alphanumeric() { c.to_lowercase().next().unwrap_or(c) } else { ' ' })
        .collect::<String>()
        .split_whitespace()
        .map(str::to_string)
        .collect()
}

/// The saved title's words appear in the window's title, in order and next to each other,
/// on word boundaries. So "Git" doesn't match "Digital Ocean", and "GitHub" does match
/// "Sign in to GitHub - Google Chrome".
pub fn title_matches(window_title: &str, item_title: &str) -> bool {
    let item = normalise(item_title);
    let joined_len: usize = item.iter().map(|w| w.chars().count()).sum();
    if item.is_empty() || joined_len < MIN_TITLE_LEN {
        return false;
    }
    let window = normalise(window_title);
    window.windows(item.len()).any(|w| w == item.as_slice())
}

pub fn any_title_matches(window_title: &str, item_titles: &[String]) -> bool {
    item_titles.iter().any(|t| title_matches(window_title, t))
}

// ---- Keys ----

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Key {
    Unit(u16),
    Tab,
}

/// Username, Tab, password. Never Enter: submitting is left to the person.
pub fn plan_keys(username: &str, password: &str) -> Vec<Key> {
    let mut out = Vec::with_capacity(username.len() + password.len() + 1);
    out.extend(username.encode_utf16().map(Key::Unit));
    if !username.is_empty() && !password.is_empty() {
        out.push(Key::Tab);
    }
    out.extend(password.encode_utf16().map(Key::Unit));
    out
}

fn wipe(keys: &mut [Key]) {
    for k in keys.iter_mut() {
        if let Key::Unit(u) = k {
            u.zeroize();
        }
    }
}

// ---- Doing it ----

pub trait Desktop {
    fn foreground(&self) -> WindowId;
    fn title(&self, w: WindowId) -> String;
    fn activate(&self, w: WindowId) -> bool;
    fn modifiers_down(&self) -> bool;
    fn is_own(&self, w: WindowId) -> bool;
    fn is_blocked_by_elevation(&self, w: WindowId) -> bool;
    fn send(&self, key: Key) -> bool;
    fn sleep_ms(&self, ms: u64);
}

pub struct Request<'a> {
    pub target: &'a Target,
    pub item_titles: &'a [String],
    /// The person saw both titles and chose to type anyway.
    pub confirmed_mismatch: bool,
}

/// Runs the checks, then types. `keys` is wiped whatever happens.
pub fn perform(d: &dyn Desktop, req: &Request, keys: &mut [Key]) -> Result<usize, AutoTypeError> {
    let result = perform_inner(d, req, keys);
    wipe(keys);
    result
}

fn perform_inner(d: &dyn Desktop, req: &Request, keys: &[Key]) -> Result<usize, AutoTypeError> {
    if keys.is_empty() {
        return Err(AutoTypeError::NothingToType);
    }
    let w = req.target.window;
    if d.is_own(w) {
        return Err(AutoTypeError::OwnWindow);
    }
    if d.is_blocked_by_elevation(w) {
        return Err(AutoTypeError::Elevated);
    }
    // The title can change between the shortcut and now. It's today's title that counts.
    let title = d.title(w);
    if !req.confirmed_mismatch && !any_title_matches(&title, req.item_titles) {
        return Err(AutoTypeError::TitleMismatch { window: title, item: req.item_titles.first().cloned().unwrap_or_default() });
    }
    // Ctrl from Ctrl+Enter would turn a typed "a" into select-all.
    let mut held = d.modifiers_down();
    let mut tries = 0;
    while held && tries < MODIFIER_WAIT_TRIES {
        d.sleep_ms(MODIFIER_WAIT_MS);
        held = d.modifiers_down();
        tries += 1;
    }
    if held {
        return Err(AutoTypeError::ModifiersHeld);
    }
    if !wait_for_focus(d, w) {
        return Err(AutoTypeError::FocusLost);
    }
    let mut sent = 0;
    for key in keys {
        if d.foreground() != w || d.modifiers_down() {
            return Err(AutoTypeError::FocusLost);
        }
        if !d.send(*key) {
            return Err(AutoTypeError::SendFailed);
        }
        sent += 1;
        d.sleep_ms(KEY_DELAY_MS);
    }
    Ok(sent)
}

fn wait_for_focus(d: &dyn Desktop, w: WindowId) -> bool {
    for _ in 0..FOCUS_TRIES {
        if d.foreground() == w {
            return true;
        }
        d.activate(w);
        d.sleep_ms(FOCUS_WAIT_MS);
    }
    d.foreground() == w
}

// ---- The real desktop ----

pub struct Win32Desktop;

mod win32 {
    use super::*;
    use windows::Win32::Foundation::{CloseHandle, HANDLE, HWND};
    use windows::Win32::Security::{GetTokenInformation, TokenElevation, TOKEN_ELEVATION, TOKEN_QUERY};
    use windows::Win32::System::Threading::{GetCurrentProcess, GetCurrentProcessId, OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION};
    use windows::Win32::UI::Input::KeyboardAndMouse::{
        GetAsyncKeyState, SendInput, INPUT, INPUT_0, INPUT_KEYBOARD, KEYBDINPUT, KEYBD_EVENT_FLAGS, KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VIRTUAL_KEY, VK_CONTROL, VK_LWIN, VK_MENU, VK_RWIN, VK_SHIFT, VK_TAB,
    };
    use windows::Win32::UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowTextLengthW, GetWindowTextW, GetWindowThreadProcessId, IsWindow, SetForegroundWindow};

    fn hwnd(w: WindowId) -> HWND {
        HWND(w.0 as *mut _)
    }

    fn pid_of(w: WindowId) -> u32 {
        let mut pid = 0u32;
        // SAFETY: a stale or null handle makes this return 0, and pid stays 0.
        unsafe { GetWindowThreadProcessId(hwnd(w), Some(&mut pid)) };
        pid
    }

    fn token_elevated(process: HANDLE) -> Option<bool> {
        let mut token = HANDLE::default();
        // SAFETY: process is a valid handle, token is an out parameter we close below.
        unsafe { OpenProcessToken(process, TOKEN_QUERY, &mut token) }.ok()?;
        let mut info = TOKEN_ELEVATION::default();
        let mut len = 0u32;
        // SAFETY: the buffer is a TOKEN_ELEVATION and the size says so.
        let got = unsafe { GetTokenInformation(token, TokenElevation, Some(&mut info as *mut _ as *mut _), std::mem::size_of::<TOKEN_ELEVATION>() as u32, &mut len) };
        // SAFETY: token came from OpenProcessToken.
        unsafe {
            let _ = CloseHandle(token);
        }
        got.ok()?;
        Some(info.TokenIsElevated != 0)
    }

    fn input(vk: VIRTUAL_KEY, scan: u16, flags: KEYBD_EVENT_FLAGS) -> INPUT {
        INPUT { r#type: INPUT_KEYBOARD, Anonymous: INPUT_0 { ki: KEYBDINPUT { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } } }
    }

    pub(super) fn inputs_for(key: Key) -> [INPUT; 2] {
        match key {
            Key::Unit(u) => [input(VIRTUAL_KEY(0), u, KEYEVENTF_UNICODE), input(VIRTUAL_KEY(0), u, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP)],
            Key::Tab => [input(VK_TAB, 0, KEYBD_EVENT_FLAGS(0)), input(VK_TAB, 0, KEYEVENTF_KEYUP)],
        }
    }

    impl Desktop for Win32Desktop {
        fn foreground(&self) -> WindowId {
            // SAFETY: no arguments.
            WindowId(unsafe { GetForegroundWindow() }.0 as isize)
        }
        fn title(&self, w: WindowId) -> String {
            // SAFETY: the buffer is sized from the call before it, and a stale handle gives 0.
            unsafe {
                let len = GetWindowTextLengthW(hwnd(w));
                if len <= 0 {
                    return String::new();
                }
                let mut buf = vec![0u16; len as usize + 1];
                let n = GetWindowTextW(hwnd(w), &mut buf);
                String::from_utf16_lossy(&buf[..n.max(0) as usize])
            }
        }
        fn activate(&self, w: WindowId) -> bool {
            // SAFETY: a stale handle just fails.
            unsafe { IsWindow(Some(hwnd(w))).as_bool() && SetForegroundWindow(hwnd(w)).as_bool() }
        }
        fn modifiers_down(&self) -> bool {
            [VK_CONTROL, VK_SHIFT, VK_MENU, VK_LWIN, VK_RWIN].iter().any(|vk| {
                // SAFETY: plain key state query. The high bit means held now.
                (unsafe { GetAsyncKeyState(vk.0 as i32) } as u16 & 0x8000) != 0
            })
        }
        fn is_own(&self, w: WindowId) -> bool {
            // SAFETY: no arguments.
            pid_of(w) == unsafe { GetCurrentProcessId() }
        }
        fn is_blocked_by_elevation(&self, w: WindowId) -> bool {
            // SAFETY: the pseudo handle needs no closing.
            let me = token_elevated(unsafe { GetCurrentProcess() }).unwrap_or(false);
            if me {
                return false;
            }
            let pid = pid_of(w);
            // SAFETY: closed below on success. A process we can't even query is treated as
            // elevated, since that's how it fails for a process above our level.
            let Ok(process) = (unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) }) else {
                return true;
            };
            let elevated = token_elevated(process).unwrap_or(true);
            // SAFETY: from OpenProcess.
            unsafe {
                let _ = CloseHandle(process);
            }
            elevated
        }
        fn send(&self, key: Key) -> bool {
            let inputs = inputs_for(key);
            // SAFETY: inputs is a valid slice of the size passed.
            let sent = unsafe { SendInput(&inputs, std::mem::size_of::<INPUT>() as i32) };
            sent == inputs.len() as u32
        }
        fn sleep_ms(&self, ms: u64) {
            std::thread::sleep(Duration::from_millis(ms));
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::cell::{Cell, RefCell};

    struct Fake {
        fg: Cell<isize>,
        titles: RefCell<Vec<(isize, String)>>,
        own: bool,
        elevated: bool,
        modifiers_for: Cell<u32>,
        typed: RefCell<Vec<Key>>,
        steal_focus_after: Cell<Option<u32>>,
        activate_works: bool,
        send_works: bool,
    }

    impl Fake {
        fn new() -> Self {
            Self {
                fg: Cell::new(7),
                titles: RefCell::new(vec![(7, "Sign in to GitHub - Notepad".into())]),
                own: false,
                elevated: false,
                modifiers_for: Cell::new(0),
                typed: RefCell::new(vec![]),
                steal_focus_after: Cell::new(None),
                activate_works: true,
                send_works: true,
            }
        }
    }

    impl Desktop for Fake {
        fn foreground(&self) -> WindowId {
            WindowId(self.fg.get())
        }
        fn title(&self, w: WindowId) -> String {
            self.titles.borrow().iter().find(|(id, _)| *id == w.0).map(|(_, t)| t.clone()).unwrap_or_default()
        }
        fn activate(&self, w: WindowId) -> bool {
            if self.activate_works {
                self.fg.set(w.0);
            }
            self.activate_works
        }
        fn modifiers_down(&self) -> bool {
            let n = self.modifiers_for.get();
            if n == u32::MAX {
                return true;
            }
            if n > 0 {
                self.modifiers_for.set(n - 1);
                return true;
            }
            false
        }
        fn is_own(&self, _: WindowId) -> bool {
            self.own
        }
        fn is_blocked_by_elevation(&self, _: WindowId) -> bool {
            self.elevated
        }
        fn send(&self, key: Key) -> bool {
            if !self.send_works {
                return false;
            }
            self.typed.borrow_mut().push(key);
            if let Some(n) = self.steal_focus_after.get() {
                if self.typed.borrow().len() as u32 >= n {
                    self.fg.set(99);
                }
            }
            true
        }
        fn sleep_ms(&self, _: u64) {}
    }

    fn target() -> Target {
        Target { window: WindowId(7), title: "Sign in to GitHub - Notepad".into() }
    }

    fn titles(t: &str) -> Vec<String> {
        vec![t.to_string()]
    }

    #[test]
    fn title_matching_uses_whole_words() {
        assert!(title_matches("Sign in to GitHub - Google Chrome", "GitHub"));
        assert!(title_matches("PuTTY Configuration", "putty"));
        assert!(title_matches("Bank of Example: Login", "Bank of Example"));
        assert!(title_matches("bank-of-example login", "Bank of Example"));
        assert!(title_matches("Café Admin", "CAFÉ"));
        assert!(!title_matches("Digital Ocean", "Git"));
        assert!(!title_matches("Example Bank", "Bank of Example"));
        assert!(!title_matches("Anything at all", ""));
        assert!(!title_matches("Anything at all", "   -- "));
        assert!(!title_matches("X Y Z", "X"), "too short to mean anything");
        assert!(!title_matches("", "GitHub"));
        // A word order swap isn't the same name.
        assert!(!title_matches("Example of Bank", "Bank of Example"));
    }

    #[test]
    fn any_of_several_titles_counts() {
        let list = vec!["Nope".to_string(), "GitHub".to_string()];
        assert!(any_title_matches("GitHub", &list));
        assert!(!any_title_matches("GitLab", &list));
        assert!(!any_title_matches("GitLab", &[]));
    }

    #[test]
    fn gesture_is_required_and_single_use() {
        let now = Instant::now();
        let mut g = Gestures::default();
        assert_eq!(g.take("anything", now), Err(AutoTypeError::NoGesture));
        let token = g.issue("tok".into(), Some(target()), now);
        assert_eq!(g.take("wrong", now), Err(AutoTypeError::NoGesture));
        assert!(g.is_live(), "a wrong token mustn't cancel the real one");
        assert_eq!(g.take(&token, now), Ok(target()));
        assert_eq!(g.take(&token, now), Err(AutoTypeError::NoGesture), "single use");
    }

    #[test]
    fn gesture_expires_and_the_expired_one_is_gone() {
        let now = Instant::now();
        let mut g = Gestures::default();
        g.issue("tok".into(), Some(target()), now);
        let later = now + GESTURE_TTL + Duration::from_secs(1);
        assert_eq!(g.target("tok", later).err(), Some(AutoTypeError::GestureExpired));
        assert_eq!(g.take("tok", later), Err(AutoTypeError::GestureExpired));
        assert_eq!(g.take("tok", later), Err(AutoTypeError::NoGesture));
    }

    #[test]
    fn a_new_gesture_replaces_the_old_one() {
        let now = Instant::now();
        let mut g = Gestures::default();
        g.issue("a".into(), Some(target()), now);
        g.issue("b".into(), Some(target()), now);
        assert_eq!(g.take("a", now), Err(AutoTypeError::NoGesture));
        assert!(g.take("b", now).is_ok());
    }

    #[test]
    fn gesture_without_a_target_cannot_type() {
        let now = Instant::now();
        let mut g = Gestures::default();
        g.issue("a".into(), None, now);
        assert_eq!(g.target("a", now).unwrap(), None);
        assert_eq!(g.take("a", now), Err(AutoTypeError::NoTarget));
    }

    #[test]
    fn keys_are_username_tab_password_and_never_enter() {
        assert_eq!(plan_keys("a", "b"), vec![Key::Unit(97), Key::Tab, Key::Unit(98)]);
        assert_eq!(plan_keys("", "b"), vec![Key::Unit(98)]);
        assert_eq!(plan_keys("a", ""), vec![Key::Unit(97)]);
        assert!(plan_keys("", "").is_empty());
        // Outside the BMP goes as a surrogate pair.
        assert_eq!(plan_keys("", "🔑").len(), 2);
    }

    #[test]
    fn inputs_are_unicode_down_and_up() {
        use windows::Win32::UI::Input::KeyboardAndMouse::{KEYEVENTF_KEYUP, KEYEVENTF_UNICODE, VK_TAB};
        let [down, up] = win32::inputs_for(Key::Unit(0x20ac));
        // SAFETY: both were built as keyboard inputs just above.
        unsafe {
            assert_eq!(down.Anonymous.ki.wScan, 0x20ac);
            assert_eq!(down.Anonymous.ki.wVk.0, 0);
            assert_eq!(down.Anonymous.ki.dwFlags, KEYEVENTF_UNICODE);
            assert_eq!(up.Anonymous.ki.dwFlags, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP);
        }
        let [down, up] = win32::inputs_for(Key::Tab);
        // SAFETY: same.
        unsafe {
            assert_eq!(down.Anonymous.ki.wVk, VK_TAB);
            assert_eq!(up.Anonymous.ki.dwFlags, KEYEVENTF_KEYUP);
        }
    }

    #[test]
    fn types_when_everything_lines_up() {
        let d = Fake::new();
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("ana", "pw");
        let n = perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys).unwrap();
        assert_eq!(n, 6);
        assert_eq!(*d.typed.borrow(), plan_keys("ana", "pw"));
        // What was to be typed doesn't stay in memory.
        assert!(keys.iter().all(|k| matches!(k, Key::Unit(0) | Key::Tab)));
    }

    #[test]
    fn title_mismatch_refuses_until_confirmed() {
        let d = Fake::new();
        let t = target();
        let titles = titles("Example Bank");
        let mut keys = plan_keys("ana", "pw");
        let err = perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys).unwrap_err();
        assert!(matches!(err, AutoTypeError::TitleMismatch { .. }));
        assert!(d.typed.borrow().is_empty());
        assert!(keys.iter().all(|k| matches!(k, Key::Unit(0) | Key::Tab)), "wiped on refusal too");

        let mut keys = plan_keys("ana", "pw");
        assert!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: true }, &mut keys).is_ok());
    }

    #[test]
    fn title_is_checked_as_it_is_now_not_as_it_was() {
        let d = Fake::new();
        // The gesture saw a matching title; the window has since changed.
        d.titles.borrow_mut()[0].1 = "Evil prompt".into();
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("ana", "pw");
        let err = perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys).unwrap_err();
        assert!(matches!(err, AutoTypeError::TitleMismatch { .. }));
    }

    #[test]
    fn own_window_is_never_typed_into_even_when_confirmed() {
        let mut d = Fake::new();
        d.own = true;
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("ana", "pw");
        assert_eq!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: true }, &mut keys), Err(AutoTypeError::OwnWindow));
    }

    #[test]
    fn elevated_window_is_refused_rather_than_silently_dropped() {
        let mut d = Fake::new();
        d.elevated = true;
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("ana", "pw");
        assert_eq!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys), Err(AutoTypeError::Elevated));
    }

    #[test]
    fn waits_for_modifiers_then_gives_up() {
        let d = Fake::new();
        d.modifiers_for.set(5);
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("a", "b");
        assert!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys).is_ok());

        let d = Fake::new();
        d.modifiers_for.set(u32::MAX);
        let mut keys = plan_keys("a", "b");
        assert_eq!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys), Err(AutoTypeError::ModifiersHeld));
        assert!(d.typed.borrow().is_empty());
    }

    #[test]
    fn brings_the_target_back_to_the_front() {
        let d = Fake::new();
        d.fg.set(55); // our overlay
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("a", "b");
        assert!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys).is_ok());
        assert_eq!(d.fg.get(), 7);
    }

    #[test]
    fn refuses_when_focus_cannot_be_restored() {
        let mut d = Fake::new();
        d.activate_works = false;
        d.fg.set(55);
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("a", "b");
        assert_eq!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys), Err(AutoTypeError::FocusLost));
        assert!(d.typed.borrow().is_empty());
    }

    #[test]
    fn stops_the_moment_another_window_takes_focus() {
        let d = Fake::new();
        d.steal_focus_after.set(Some(2));
        let t = target();
        let titles = titles("GitHub");
        let mut keys = plan_keys("ana", "secret");
        assert_eq!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys), Err(AutoTypeError::FocusLost));
        assert_eq!(d.typed.borrow().len(), 2, "not one key after focus moved");
    }

    #[test]
    fn nothing_to_type_and_send_failure_are_errors() {
        let d = Fake::new();
        let t = target();
        let titles = titles("GitHub");
        let mut none = plan_keys("", "");
        assert_eq!(perform(&d, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut none), Err(AutoTypeError::NothingToType));
        let mut d2 = Fake::new();
        d2.send_works = false;
        let mut keys = plan_keys("a", "b");
        assert_eq!(perform(&d2, &Request { target: &t, item_titles: &titles, confirmed_mismatch: false }, &mut keys), Err(AutoTypeError::SendFailed));
    }
}
