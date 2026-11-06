//! The native messaging host: lets the browser extension use Windows Hello. Chrome starts it
//! with the extension's origin (`chrome-extension://<id>/`) and `--parent-window=<hwnd>`;
//! Firefox with the manifest path and the add-on id.
//!
//! Two checks: the origin must be in the manifest we wrote (browsers enforce this too, and
//! this is the same list again), and the process that started us must look like an installed
//! browser. Same-user malware can get round both, the same way it can call DPAPI directly, so
//! SECURITY.md calls this a bar, not a boundary.
use std::collections::HashMap;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};

use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use windows::Win32::Foundation::{CloseHandle, FILETIME, HWND};
use windows::Win32::System::Diagnostics::ToolHelp::{CreateToolhelp32Snapshot, Process32FirstW, Process32NextW, PROCESSENTRY32W, TH32CS_SNAPPROCESS};
use windows::Win32::System::Threading::{GetCurrentProcessId, GetProcessTimes, OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::WindowsAndMessaging::GetForegroundWindow;

use crate::hello::{ConsentGate, HelloError, HelloStore, Protector, RealGate, RealProtector, SECRET_LEN};
use crate::reg;

pub const HOST_NAME: &str = "org.promptly.passwords";
pub const FIREFOX_ID: &str = "passwords@promptly.app";
/// Browsers send at most 1 MB to a host. A real message here is well under a kilobyte.
pub const MAX_INCOMING: u32 = 64 * 1024;
const HELLO_PURPOSE: &str = "promptly-pw/extension-hello/v1";

// ---- Framing: a u32 length in native byte order, then UTF-8 JSON ----

pub fn read_frame(r: &mut impl Read) -> Result<Option<Vec<u8>>, String> {
    let mut len = [0u8; 4];
    match r.read_exact(&mut len) {
        Ok(()) => {}
        Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e.to_string()),
    }
    let n = u32::from_le_bytes(len);
    if n > MAX_INCOMING {
        return Err("message too long".to_string());
    }
    let mut buf = vec![0u8; n as usize];
    r.read_exact(&mut buf).map_err(|e| e.to_string())?;
    Ok(Some(buf))
}

pub fn write_frame(w: &mut impl Write, body: &[u8]) -> Result<(), String> {
    let n: u32 = body.len().try_into().map_err(|_| "message too long")?;
    w.write_all(&n.to_le_bytes()).map_err(|e| e.to_string())?;
    w.write_all(body).map_err(|e| e.to_string())?;
    w.flush().map_err(|e| e.to_string())
}

// ---- Who's calling ----

#[derive(Debug, PartialEq, Eq, Clone)]
pub enum Caller {
    Chromium { extension_id: String, parent_window: Option<isize> },
    Firefox { addon_id: String },
}

impl Caller {
    pub fn origin(&self) -> String {
        match self {
            Self::Chromium { extension_id, .. } => format!("chrome-extension://{extension_id}/"),
            Self::Firefox { addon_id } => format!("moz-extension:{addon_id}"),
        }
    }
}

/// A Chrome extension id is exactly 32 letters a to p.
pub fn valid_extension_id(id: &str) -> bool {
    id.len() == 32 && id.bytes().all(|b| (b'a'..=b'p').contains(&b))
}

/// `args` is everything after the program name.
pub fn parse_caller(args: &[String]) -> Result<Caller, String> {
    let first = args.first().ok_or("no caller")?;
    if let Some(rest) = first.strip_prefix("chrome-extension://") {
        let id = rest.strip_suffix('/').ok_or("bad origin")?;
        if !valid_extension_id(id) {
            return Err("bad extension id".to_string());
        }
        let parent_window = args.iter().find_map(|a| a.strip_prefix("--parent-window=")).and_then(|v| v.parse::<isize>().ok());
        return Ok(Caller::Chromium { extension_id: id.to_string(), parent_window });
    }
    // Firefox: manifest path, then add-on id.
    if let Some(addon) = args.get(1) {
        return Ok(Caller::Firefox { addon_id: addon.clone() });
    }
    Err("unknown caller".to_string())
}

pub fn caller_allowed(caller: &Caller, allowed_extension_ids: &[String]) -> bool {
    match caller {
        Caller::Chromium { extension_id, .. } => allowed_extension_ids.iter().any(|id| id == extension_id),
        Caller::Firefox { addon_id } => addon_id == FIREFOX_ID,
    }
}

const BROWSERS: &[&str] = &["chrome.exe", "msedge.exe", "firefox.exe", "brave.exe", "vivaldi.exe", "opera.exe", "chromium.exe"];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProcInfo {
    pub name: String,
    pub path: Option<String>,
    /// Filetime ticks.
    pub started: u64,
}

/// Decides from the chain of processes above us, nearest first. Chrome on Windows starts a
/// host through `cmd.exe /c`, so one cmd.exe is allowed in between, and no more than that.
/// `install_roots` are lower-case prefixes an installed browser's path must start with.
pub fn chain_is_browser(chain: &[ProcInfo], me_started: u64, install_roots: &[String]) -> bool {
    let mut it = chain.iter();
    let Some(first) = it.next() else {
        return false;
    };
    let browser = if first.name.eq_ignore_ascii_case("cmd.exe") {
        match it.next() {
            Some(b) => b,
            None => return false,
        }
    } else {
        first
    };
    if !BROWSERS.iter().any(|b| browser.name.eq_ignore_ascii_case(b)) {
        return false;
    }
    let Some(path) = &browser.path else {
        return false;
    };
    let lower = path.to_ascii_lowercase();
    if !install_roots.iter().any(|r| lower.starts_with(r)) {
        return false;
    }
    // A parent that started after us means its pid was reused.
    browser.started != 0 && browser.started <= me_started && first.started <= me_started
}

pub fn install_roots() -> Vec<String> {
    let mut out = vec![];
    for var in ["ProgramFiles", "ProgramFiles(x86)", "LOCALAPPDATA"] {
        if let Some(v) = std::env::var_os(var) {
            let mut s = v.to_string_lossy().to_ascii_lowercase();
            if !s.ends_with('\\') {
                s.push('\\');
            }
            out.push(s);
        }
    }
    out
}

fn filetime_u64(t: FILETIME) -> u64 {
    ((t.dwHighDateTime as u64) << 32) | t.dwLowDateTime as u64
}

fn process_details(pid: u32) -> (Option<String>, u64) {
    // SAFETY: the handle's checked and closed, and buffers are the size passed.
    unsafe {
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return (None, 0);
        };
        let mut buf = vec![0u16; 2048];
        let mut len = buf.len() as u32;
        let path = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).ok().map(|_| String::from_utf16_lossy(&buf[..len as usize]));
        let (mut a, mut b, mut c, mut d) = (FILETIME::default(), FILETIME::default(), FILETIME::default(), FILETIME::default());
        let started = GetProcessTimes(h, &mut a, &mut b, &mut c, &mut d).ok().map(|_| filetime_u64(a)).unwrap_or(0);
        let _ = CloseHandle(h);
        (path, started)
    }
}

/// Up to `depth` processes above this one.
pub fn process_chain(depth: usize) -> (u64, Vec<ProcInfo>) {
    let mut table: HashMap<u32, (u32, String)> = HashMap::new();
    // SAFETY: the snapshot handle's closed, and the struct's size field is set as required.
    unsafe {
        if let Ok(snap) = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0) {
            let mut e = PROCESSENTRY32W { dwSize: std::mem::size_of::<PROCESSENTRY32W>() as u32, ..Default::default() };
            let mut more = Process32FirstW(snap, &mut e).is_ok();
            while more {
                let n = e.szExeFile.iter().position(|c| *c == 0).unwrap_or(e.szExeFile.len());
                table.insert(e.th32ProcessID, (e.th32ParentProcessID, String::from_utf16_lossy(&e.szExeFile[..n])));
                more = Process32NextW(snap, &mut e).is_ok();
            }
            let _ = CloseHandle(snap);
        }
    }
    // SAFETY: no arguments.
    let me = unsafe { GetCurrentProcessId() };
    let (_, me_started) = process_details(me);
    let mut out = vec![];
    let mut at = me;
    for _ in 0..depth {
        let Some((parent, _)) = table.get(&at) else {
            break;
        };
        let Some((_, name)) = table.get(parent) else {
            break;
        };
        let (path, started) = process_details(*parent);
        out.push(ProcInfo { name: name.clone(), path, started });
        at = *parent;
    }
    (me_started, out)
}

// ---- Messages ----

#[derive(Deserialize)]
#[serde(tag = "t")]
pub enum Request {
    #[serde(rename = "status")]
    Status,
    #[serde(rename = "enable")]
    Enable { secret: String },
    #[serde(rename = "unlock")]
    Unlock,
    #[serde(rename = "disable")]
    Disable,
}

#[derive(Serialize, Default, Debug)]
pub struct Reply {
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub available: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub secret: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
    /// So the page can tell "the person said no" from "it's broken".
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cancelled: Option<bool>,
}

fn fail(e: HelloError) -> Reply {
    let cancelled = (e == HelloError::Cancelled).then_some(true);
    Reply { ok: false, error: Some(e.to_string()), cancelled, ..Default::default() }
}

pub fn handle<G: ConsentGate, P: Protector>(store: &HelloStore<G, P>, window: isize, body: &[u8]) -> Reply {
    let Ok(req) = serde_json::from_slice::<Request>(body) else {
        return Reply { ok: false, error: Some("unknown request".to_string()), ..Default::default() };
    };
    let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;
    match req {
        Request::Status => Reply { ok: true, available: Some(store.available()), enabled: Some(store.is_enabled()), ..Default::default() },
        Request::Enable { mut secret } => {
            let decoded = b64.decode(secret.as_bytes());
            zeroize::Zeroize::zeroize(&mut secret);
            let Ok(raw) = decoded else {
                return fail(HelloError::BadSecret);
            };
            let raw = zeroize::Zeroizing::new(raw);
            if raw.len() != SECRET_LEN {
                return fail(HelloError::BadSecret);
            }
            match store.enable(window, &raw, "Turn on Windows Hello unlock for Promptly Passwords in your browser") {
                Ok(()) => Reply { ok: true, enabled: Some(true), ..Default::default() },
                Err(e) => fail(e),
            }
        }
        Request::Unlock => match store.unlock(window, "Unlock Promptly Passwords in your browser") {
            Ok(secret) => Reply { ok: true, secret: Some(b64.encode(&*secret)), ..Default::default() },
            Err(e) => fail(e),
        },
        Request::Disable => match store.disable() {
            Ok(()) => Reply { ok: true, enabled: Some(false), ..Default::default() },
            Err(e) => fail(e),
        },
    }
}

/// One file per browser and extension, so one extension can't use another's.
pub fn hello_path(data_dir: &Path, caller: &Caller) -> PathBuf {
    let digest = Sha256::digest(caller.origin().as_bytes());
    let hex: String = digest.iter().take(12).map(|b| format!("{b:02x}")).collect();
    data_dir.join(format!("ext-hello-{hex}.bin"))
}

/// The window to own the Hello prompt: what Chrome told us, or whatever's in front, which is
/// the browser the person just clicked in. Firefox doesn't pass a handle.
fn prompt_window(caller: &Caller) -> isize {
    if let Caller::Chromium { parent_window: Some(w), .. } = caller {
        return *w;
    }
    // SAFETY: no arguments, and the handle is only passed back to Windows.
    let w: HWND = unsafe { GetForegroundWindow() };
    w.0 as isize
}

fn run_loop<G: ConsentGate, P: Protector>(store: &HelloStore<G, P>, window: isize, input: &mut impl Read, output: &mut impl Write) -> Result<(), String> {
    while let Some(body) = read_frame(input)? {
        let reply = handle(store, window, &body);
        let bytes = zeroize::Zeroizing::new(serde_json::to_vec(&reply).map_err(|e| e.to_string())?);
        write_frame(output, &bytes)?;
    }
    Ok(())
}

/// The whole host. Returns a process exit code.
pub fn host_main(args: &[String], data_dir: &Path) -> i32 {
    let run = || -> Result<(), String> {
        let caller = parse_caller(args)?;
        let allowed = crate::settings::load(&data_dir.join("desktop.json")).extension_ids;
        if !caller_allowed(&caller, &allowed) {
            return Err("that extension isn't allowed".to_string());
        }
        let (me_started, chain) = process_chain(2);
        if !chain_is_browser(&chain, me_started, &install_roots()) {
            return Err("not started by an installed browser".to_string());
        }
        let store = HelloStore { path: hello_path(data_dir, &caller), gate: RealGate, protector: RealProtector(HELLO_PURPOSE) };
        run_loop(&store, prompt_window(&caller), &mut std::io::stdin().lock(), &mut std::io::stdout().lock())
    };
    match run() {
        Ok(()) => 0,
        Err(e) => {
            // Only ever a fixed message from the checks above, never a secret. stderr goes
            // to the browser's own log.
            eprintln!("promptly-native-host: {e}");
            1
        }
    }
}

// ---- Registration ----

const CHROMIUM_KEYS: &[&str] = &[
    r"Software\Google\Chrome\NativeMessagingHosts",
    r"Software\Microsoft\Edge\NativeMessagingHosts",
    r"Software\Chromium\NativeMessagingHosts",
    r"Software\BraveSoftware\Brave-Browser\NativeMessagingHosts",
    r"Software\Vivaldi\NativeMessagingHosts",
];
const FIREFOX_KEY: &str = r"Software\Mozilla\NativeMessagingHosts";

pub fn chromium_manifest(host_path: &str, extension_ids: &[String]) -> Result<String, String> {
    if extension_ids.is_empty() {
        return Err("no extension ids".to_string());
    }
    if let Some(bad) = extension_ids.iter().find(|i| !valid_extension_id(i)) {
        return Err(format!("{bad} isn't a browser extension id"));
    }
    let origins: Vec<String> = extension_ids.iter().map(|i| format!("chrome-extension://{i}/")).collect();
    serde_json::to_string_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Promptly Passwords: Windows Hello for the browser extension",
        "path": host_path,
        "type": "stdio",
        "allowed_origins": origins,
    }))
    .map_err(|e| e.to_string())
}

pub fn firefox_manifest(host_path: &str) -> Result<String, String> {
    serde_json::to_string_pretty(&serde_json::json!({
        "name": HOST_NAME,
        "description": "Promptly Passwords: Windows Hello for the browser extension",
        "path": host_path,
        "type": "stdio",
        "allowed_extensions": [FIREFOX_ID],
    }))
    .map_err(|e| e.to_string())
}

/// Writes manifests under the app's folder and points the browsers at them, in HKCU only.
/// Firefox's id is fixed. Chrome-family ids come from the person, until a store listing fixes one.
pub fn register(data_dir: &Path, host_path: &str, extension_ids: &[String]) -> Result<(), String> {
    let dir = data_dir.join("native");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let firefox = dir.join(format!("{HOST_NAME}.firefox.json"));
    std::fs::write(&firefox, firefox_manifest(host_path)?).map_err(|e| e.to_string())?;
    reg::set_string(&format!(r"{FIREFOX_KEY}\{HOST_NAME}"), None, &firefox.to_string_lossy())?;
    for key in CHROMIUM_KEYS {
        reg::delete_key(&format!(r"{key}\{HOST_NAME}"))?;
    }
    if !extension_ids.is_empty() {
        let chrome = dir.join(format!("{HOST_NAME}.chromium.json"));
        std::fs::write(&chrome, chromium_manifest(host_path, extension_ids)?).map_err(|e| e.to_string())?;
        for key in CHROMIUM_KEYS {
            reg::set_string(&format!(r"{key}\{HOST_NAME}"), None, &chrome.to_string_lossy())?;
        }
    }
    Ok(())
}

pub fn unregister() -> Result<(), String> {
    for key in CHROMIUM_KEYS.iter().chain(std::iter::once(&FIREFOX_KEY)) {
        reg::delete_key(&format!(r"{key}\{HOST_NAME}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hello::{MockGate, Verdict};
    use std::io::Cursor;

    const CHROME_ID: &str = "abcdefghijklmnopabcdefghijklmnop";

    fn strings(a: &[&str]) -> Vec<String> {
        a.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn frames_round_trip_and_oversize_is_refused() {
        let mut buf = vec![];
        write_frame(&mut buf, b"{\"t\":\"status\"}").unwrap();
        assert_eq!(&buf[..4], &14u32.to_le_bytes());
        let mut r = Cursor::new(buf);
        assert_eq!(read_frame(&mut r).unwrap().unwrap(), b"{\"t\":\"status\"}");
        assert_eq!(read_frame(&mut r).unwrap(), None, "clean end of stream");

        let mut big = (MAX_INCOMING + 1).to_le_bytes().to_vec();
        big.extend_from_slice(b"x");
        assert!(read_frame(&mut Cursor::new(big)).is_err());
        let mut short = 10u32.to_le_bytes().to_vec();
        short.extend_from_slice(b"abc");
        assert!(read_frame(&mut Cursor::new(short)).is_err());
    }

    #[test]
    fn caller_parsing() {
        let c = parse_caller(&strings(&[&format!("chrome-extension://{CHROME_ID}/"), "--parent-window=1234"])).unwrap();
        assert_eq!(c, Caller::Chromium { extension_id: CHROME_ID.into(), parent_window: Some(1234) });
        let c = parse_caller(&strings(&[r"C:\x\org.promptly.passwords.firefox.json", FIREFOX_ID])).unwrap();
        assert_eq!(c, Caller::Firefox { addon_id: FIREFOX_ID.into() });
        for bad in [vec![], strings(&["chrome-extension://short/"]), strings(&["chrome-extension://ABCDEFGHIJKLMNOPABCDEFGHIJKLMNOP/"]), strings(&[&format!("chrome-extension://{CHROME_ID}")]), strings(&["whatever"])] {
            assert!(parse_caller(&bad).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn only_listed_extensions_are_allowed() {
        let ok = Caller::Chromium { extension_id: CHROME_ID.into(), parent_window: None };
        assert!(caller_allowed(&ok, &[CHROME_ID.to_string()]));
        assert!(!caller_allowed(&ok, &[]));
        assert!(!caller_allowed(&ok, &["pppppppppppppppppppppppppppppppp".to_string()]));
        assert!(caller_allowed(&Caller::Firefox { addon_id: FIREFOX_ID.into() }, &[]));
        assert!(!caller_allowed(&Caller::Firefox { addon_id: "evil@example.org".into() }, &[FIREFOX_ID.to_string()]));
    }

    fn proc(name: &str, path: &str, started: u64) -> ProcInfo {
        ProcInfo { name: name.into(), path: Some(path.into()), started }
    }

    #[test]
    fn caller_chain_check() {
        let roots = vec![r"c:\program files\".to_string(), r"c:\users\a\appdata\local\".to_string()];
        let chrome = proc("chrome.exe", r"C:\Program Files\Google\Chrome\Application\chrome.exe", 10);
        let cmd = proc("cmd.exe", r"C:\Windows\System32\cmd.exe", 20);
        let firefox = proc("firefox.exe", r"C:\Program Files\Mozilla Firefox\firefox.exe", 10);
        assert!(chain_is_browser(&[cmd.clone(), chrome.clone()], 30, &roots), "Chrome's usual cmd.exe in between");
        assert!(chain_is_browser(std::slice::from_ref(&firefox), 30, &roots), "Firefox starts it directly");
        assert!(!chain_is_browser(&[], 30, &roots));
        assert!(!chain_is_browser(std::slice::from_ref(&cmd), 30, &roots), "cmd.exe alone");
        assert!(!chain_is_browser(&[proc("powershell.exe", r"C:\Program Files\x\powershell.exe", 1)], 30, &roots));
        assert!(!chain_is_browser(&[cmd.clone(), proc("evil.exe", r"C:\Program Files\evil.exe", 1)], 30, &roots));
        assert!(!chain_is_browser(&[cmd.clone(), cmd.clone(), chrome.clone()], 30, &roots), "only one cmd.exe");
        assert!(!chain_is_browser(&[proc("chrome.exe", r"C:\Temp\chrome.exe", 1)], 30, &roots), "a copy elsewhere");
        assert!(!chain_is_browser(&[ProcInfo { name: "chrome.exe".into(), path: None, started: 1 }], 30, &roots), "unknown path");
        assert!(!chain_is_browser(&[proc("chrome.exe", r"C:\Program Files\Google\Chrome\chrome.exe", 99)], 30, &roots), "started after us: pid reuse");
    }

    fn store(dir: &Path, answer: Verdict) -> HelloStore<MockGate, RealProtector> {
        HelloStore { path: dir.join("h.bin"), gate: MockGate::new(true, answer), protector: RealProtector("promptly-test/nm") }
    }

    fn body(j: serde_json::Value) -> Vec<u8> {
        serde_json::to_vec(&j).unwrap()
    }

    #[test]
    fn host_protocol_with_mocked_hello() {
        let dir = std::env::temp_dir().join(format!("promptly-nm-{}", crate::random_token()));
        let s = store(&dir, Verdict::Approved);
        let b64 = base64::engine::general_purpose::URL_SAFE_NO_PAD;

        let r = handle(&s, 1, &body(serde_json::json!({"t":"status"})));
        assert!(r.ok);
        assert_eq!(r.enabled, Some(false));
        assert_eq!(r.available, Some(true));

        let r = handle(&s, 1, &body(serde_json::json!({"t":"unlock"})));
        assert!(!r.ok);
        assert!(r.secret.is_none());

        let secret = b64.encode([9u8; SECRET_LEN]);
        let r = handle(&s, 1, &body(serde_json::json!({"t":"enable","secret":secret})));
        assert!(r.ok, "{r:?}");

        let r = handle(&s, 1, &body(serde_json::json!({"t":"unlock"})));
        assert_eq!(r.secret.as_deref(), Some(secret.as_str()));

        *s.gate.answer.lock().unwrap() = Verdict::Cancelled;
        let r = handle(&s, 1, &body(serde_json::json!({"t":"unlock"})));
        assert!(!r.ok);
        assert_eq!(r.cancelled, Some(true));
        assert!(r.secret.is_none());

        let r = handle(&s, 1, &body(serde_json::json!({"t":"disable"})));
        assert!(r.ok);
        assert!(!s.is_enabled());

        for bad in [serde_json::json!({"t":"nope"}), serde_json::json!({"t":"enable","secret":"!!!"}), serde_json::json!({"t":"enable","secret":b64.encode([1u8; 8])}), serde_json::json!({})] {
            assert!(!handle(&s, 1, &body(bad)).ok);
        }
        assert!(!handle(&s, 1, b"not json").ok);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn run_loop_answers_every_frame_then_stops_at_end_of_input() {
        let dir = std::env::temp_dir().join(format!("promptly-nm-{}", crate::random_token()));
        let s = store(&dir, Verdict::Approved);
        let mut input = vec![];
        write_frame(&mut input, &body(serde_json::json!({"t":"status"}))).unwrap();
        write_frame(&mut input, &body(serde_json::json!({"t":"bad"}))).unwrap();
        let mut output = vec![];
        run_loop(&s, 1, &mut Cursor::new(input), &mut output).unwrap();
        let mut r = Cursor::new(output);
        let first: serde_json::Value = serde_json::from_slice(&read_frame(&mut r).unwrap().unwrap()).unwrap();
        assert_eq!(first["ok"], true);
        let second: serde_json::Value = serde_json::from_slice(&read_frame(&mut r).unwrap().unwrap()).unwrap();
        assert_eq!(second["ok"], false);
        assert_eq!(read_frame(&mut r).unwrap(), None);
    }

    #[test]
    fn each_extension_has_its_own_file() {
        let d = Path::new("x");
        let a = hello_path(d, &Caller::Chromium { extension_id: CHROME_ID.into(), parent_window: None });
        let b = hello_path(d, &Caller::Firefox { addon_id: FIREFOX_ID.into() });
        let c = hello_path(d, &Caller::Chromium { extension_id: "pppppppppppppppppppppppppppppppp".into(), parent_window: Some(1) });
        assert_ne!(a, b);
        assert_ne!(a, c);
    }

    #[test]
    fn manifests_are_exact_and_refuse_bad_ids() {
        let m: serde_json::Value = serde_json::from_str(&chromium_manifest(r"C:\app\host.exe", &[CHROME_ID.to_string()]).unwrap()).unwrap();
        assert_eq!(m["name"], HOST_NAME);
        assert_eq!(m["type"], "stdio");
        assert_eq!(m["path"], r"C:\app\host.exe");
        assert_eq!(m["allowed_origins"][0], format!("chrome-extension://{CHROME_ID}/"));
        assert_eq!(m["allowed_origins"].as_array().unwrap().len(), 1);
        assert!(chromium_manifest("x", &[]).is_err());
        assert!(chromium_manifest("x", &["*".to_string()]).is_err());
        assert!(chromium_manifest("x", &["chrome-extension://*/".to_string()]).is_err());

        let f: serde_json::Value = serde_json::from_str(&firefox_manifest(r"C:\app\host.exe").unwrap()).unwrap();
        assert_eq!(f["allowed_extensions"][0], FIREFOX_ID);
        assert_eq!(f["allowed_extensions"].as_array().unwrap().len(), 1);
    }

    #[test]
    fn this_test_process_is_not_a_browser() {
        // A real walk of the real process tree: cargo or a shell, not a browser.
        let (me, chain) = process_chain(2);
        assert!(me > 0);
        assert!(!chain.is_empty());
        assert!(!chain_is_browser(&chain, me, &install_roots()));
    }
}
