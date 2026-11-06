//! What the app holds natively. Never the vault's keys or items: those stay in the page's
//! memory. The device token is here, wrapped on disk, and the page never reads it back.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::AtomicU64;
use std::sync::Mutex;

use promptly_native::autotype::Gestures;
use promptly_native::clipboard::Clip;
use promptly_native::dpapi;
use promptly_native::hello::{HelloStore, RealProtector};
use promptly_native::settings::{self, Settings};
use promptly_native::sshagent::Identity;
use tokio::sync::{oneshot, watch};
use zeroize::Zeroizing;

#[cfg(feature = "e2e")]
pub type ClipOs = promptly_native::clipboard::FakeClipboard;
#[cfg(not(feature = "e2e"))]
pub type ClipOs = promptly_native::clipboard::Win32Clipboard;

#[cfg(feature = "e2e")]
pub type Gate = promptly_native::hello::MockGate;
#[cfg(not(feature = "e2e"))]
pub type Gate = promptly_native::hello::RealGate;

const TOKEN_PURPOSE: &str = "promptly-pw/device-token/v1";
const BACKUP_PURPOSE: &str = "promptly-pw/backup-password/v1";
const HELLO_PURPOSE: &str = "promptly-pw/hello/v1";

pub struct App {
    pub data_dir: PathBuf,
    pub settings: Mutex<Settings>,
    /// The server someone's connecting to, before there's a token to go with it.
    pub pending_server: Mutex<Option<String>>,
    pub token: Mutex<Option<Zeroizing<String>>>,
    pub http: reqwest::Client,
    pub clip: Mutex<Clip<ClipOs>>,
    pub gestures: Mutex<Gestures>,
    pub hello: HelloStore<Gate, RealProtector>,
    pub device_notice: Mutex<Option<String>>,
    pub ssh_stop: Mutex<Option<watch::Sender<bool>>>,
    pub ssh_error: Mutex<Option<String>>,
    pub ssh_seq: AtomicU64,
    pub ssh_identities: Mutex<HashMap<u64, oneshot::Sender<Vec<Identity>>>>,
    pub ssh_signatures: Mutex<HashMap<u64, oneshot::Sender<Option<[u8; 64]>>>>,
}

fn data_dir() -> PathBuf {
    #[cfg(feature = "e2e")]
    if let Some(d) = std::env::var_os("PROMPTLY_PW_DATA_DIR") {
        return PathBuf::from(d);
    }
    settings::data_dir()
}

#[cfg(feature = "e2e")]
fn gate() -> Gate {
    promptly_native::hello::MockGate::new(true, promptly_native::hello::Verdict::Approved)
}
#[cfg(not(feature = "e2e"))]
fn gate() -> Gate {
    promptly_native::hello::RealGate
}

#[cfg(feature = "e2e")]
fn clip_os() -> ClipOs {
    ClipOs::default()
}
#[cfg(not(feature = "e2e"))]
fn clip_os() -> ClipOs {
    promptly_native::clipboard::Win32Clipboard
}

impl App {
    pub fn load() -> Self {
        let data_dir = data_dir();
        let _ = std::fs::create_dir_all(&data_dir);
        let settings = settings::load(&data_dir.join("desktop.json"));
        let token = std::fs::read(data_dir.join("device-token.bin"))
            .ok()
            .and_then(|w| dpapi::unprotect(&w, TOKEN_PURPOSE).ok())
            .and_then(|plain| String::from_utf8(plain.to_vec()).ok())
            .map(Zeroizing::new);
        let http = reqwest::Client::builder()
            // A redirect could carry the device token somewhere else.
            .redirect(reqwest::redirect::Policy::none())
            .connect_timeout(std::time::Duration::from_secs(10))
            .timeout(std::time::Duration::from_secs(120))
            .user_agent(concat!("PromptlyPasswords-Windows/", env!("CARGO_PKG_VERSION")))
            .build()
            .expect("the HTTP client failed to start");
        Self {
            hello: HelloStore { path: data_dir.join("hello.bin"), gate: gate(), protector: RealProtector(HELLO_PURPOSE) },
            data_dir,
            settings: Mutex::new(settings),
            pending_server: Mutex::new(None),
            token: Mutex::new(token),
            http,
            clip: Mutex::new(Clip::new(clip_os())),
            gestures: Mutex::new(Gestures::default()),
            device_notice: Mutex::new(None),
            ssh_stop: Mutex::new(None),
            ssh_error: Mutex::new(None),
            ssh_seq: AtomicU64::new(1),
            ssh_identities: Mutex::new(HashMap::new()),
            ssh_signatures: Mutex::new(HashMap::new()),
        }
    }

    pub fn save_settings(&self) -> Result<(), String> {
        let s = self.settings.lock().unwrap().clone();
        settings::save(&self.data_dir.join("desktop.json"), &s)
    }

    pub fn save_token(&self, token: Zeroizing<String>) -> Result<(), String> {
        let wrapped = dpapi::protect(token.as_bytes(), TOKEN_PURPOSE)?;
        std::fs::write(self.data_dir.join("device-token.bin"), wrapped).map_err(|e| e.to_string())?;
        *self.token.lock().unwrap() = Some(token);
        Ok(())
    }

    pub fn clear_token(&self) {
        let _ = std::fs::remove_file(self.data_dir.join("device-token.bin"));
        *self.token.lock().unwrap() = None;
    }

    pub fn save_backup_password(&self, password: &[u8]) -> Result<(), String> {
        let wrapped = dpapi::protect(password, BACKUP_PURPOSE)?;
        std::fs::write(self.data_dir.join("backup-password.bin"), wrapped).map_err(|e| e.to_string())
    }

    pub fn backup_password(&self) -> Option<Zeroizing<Vec<u8>>> {
        std::fs::read(self.data_dir.join("backup-password.bin")).ok().and_then(|w| dpapi::unprotect(&w, BACKUP_PURPOSE).ok())
    }
}
