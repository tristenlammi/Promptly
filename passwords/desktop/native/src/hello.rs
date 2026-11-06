//! Windows Hello unlock (VERIFY_NOTES item 18): the vault's unlock secret wrapped with DPAPI,
//! handed back only after a User Consent check.
//!
//! This is a convenience gate, not a crypto boundary. Hello says yes or no and gives no key
//! material, and Microsoft documents no stable secret from it. Same-user malware can call
//! DPAPI directly and skip the prompt. The master password stays the root of everything.
use std::path::PathBuf;

use windows::core::HSTRING;
use windows::Security::Credentials::UI::{UserConsentVerificationResult, UserConsentVerifier, UserConsentVerifierAvailability};
use windows::Win32::Foundation::HWND;
use windows::Win32::System::WinRT::IUserConsentVerifierInterop;
use windows_future::IAsyncOperation;
use zeroize::Zeroizing;

use crate::dpapi;

#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Verdict {
    Approved,
    Cancelled,
    /// Hello isn't set up, or can't run now.
    Unavailable,
}

pub trait ConsentGate: Send + Sync {
    fn available(&self) -> bool;
    /// `window` is the owner of the prompt. Without a real one the prompt opens behind things.
    fn verify(&self, window: isize, message: &str) -> Verdict;
}

pub trait Protector: Send + Sync {
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String>;
    fn unprotect(&self, wrapped: &[u8]) -> Result<Zeroizing<Vec<u8>>, String>;
}

pub struct RealGate;

impl ConsentGate for RealGate {
    fn available(&self) -> bool {
        let check = || -> windows::core::Result<UserConsentVerifierAvailability> { UserConsentVerifier::CheckAvailabilityAsync()?.join() };
        matches!(check(), Ok(UserConsentVerifierAvailability::Available))
    }

    fn verify(&self, window: isize, message: &str) -> Verdict {
        let run = || -> windows::core::Result<UserConsentVerificationResult> {
            let interop = windows::core::factory::<UserConsentVerifier, IUserConsentVerifierInterop>()?;
            let hwnd = HWND(window as *mut _);
            // SAFETY: the interop call needs a real top-level window handle, which every
            // caller passes, and it takes the message by reference for the call only.
            let op: IAsyncOperation<UserConsentVerificationResult> = unsafe { interop.RequestVerificationForWindowAsync(hwnd, &HSTRING::from(message)) }?;
            op.join()
        };
        match run() {
            Ok(UserConsentVerificationResult::Verified) => Verdict::Approved,
            Ok(UserConsentVerificationResult::Canceled) => Verdict::Cancelled,
            Ok(UserConsentVerificationResult::RetriesExhausted) => Verdict::Cancelled,
            _ => Verdict::Unavailable,
        }
    }
}

pub struct RealProtector(pub &'static str);

impl Protector for RealProtector {
    fn protect(&self, plain: &[u8]) -> Result<Vec<u8>, String> {
        dpapi::protect(plain, self.0)
    }
    fn unprotect(&self, wrapped: &[u8]) -> Result<Zeroizing<Vec<u8>>, String> {
        dpapi::unprotect(wrapped, self.0)
    }
}

pub const SECRET_LEN: usize = 64;

#[derive(Debug, PartialEq, Eq)]
pub enum HelloError {
    NotEnabled,
    Cancelled,
    Unavailable,
    BadSecret,
    Store(String),
}

impl std::fmt::Display for HelloError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEnabled => write!(f, "Windows Hello isn't turned on for this vault."),
            Self::Cancelled => write!(f, "Windows Hello didn't confirm it's you."),
            Self::Unavailable => write!(f, "Windows Hello isn't available right now. Use your master password."),
            Self::BadSecret => write!(f, "That isn't a valid unlock secret."),
            Self::Store(e) => write!(f, "Couldn't read the saved unlock: {e}"),
        }
    }
}

pub struct HelloStore<G: ConsentGate, P: Protector> {
    pub path: PathBuf,
    pub gate: G,
    pub protector: P,
}

impl<G: ConsentGate, P: Protector> HelloStore<G, P> {
    pub fn is_enabled(&self) -> bool {
        self.path.exists()
    }

    pub fn available(&self) -> bool {
        self.gate.available()
    }

    fn gate(&self, window: isize, message: &str) -> Result<(), HelloError> {
        match self.gate.verify(window, message) {
            Verdict::Approved => Ok(()),
            Verdict::Cancelled => Err(HelloError::Cancelled),
            Verdict::Unavailable => Err(HelloError::Unavailable),
        }
    }

    /// Asks first, so it can't be turned on by someone who only has an unlocked screen and
    /// no Hello, and so a machine where Hello doesn't work finds out now, not at next unlock.
    pub fn enable(&self, window: isize, secret: &[u8], message: &str) -> Result<(), HelloError> {
        if secret.len() != SECRET_LEN {
            return Err(HelloError::BadSecret);
        }
        self.gate(window, message)?;
        let wrapped = self.protector.protect(secret).map_err(HelloError::Store)?;
        if let Some(dir) = self.path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| HelloError::Store(e.to_string()))?;
        }
        std::fs::write(&self.path, wrapped).map_err(|e| HelloError::Store(e.to_string()))
    }

    /// The secret only comes off disk after the gate says yes.
    pub fn unlock(&self, window: isize, message: &str) -> Result<Zeroizing<Vec<u8>>, HelloError> {
        if !self.is_enabled() {
            return Err(HelloError::NotEnabled);
        }
        self.gate(window, message)?;
        let wrapped = std::fs::read(&self.path).map_err(|e| HelloError::Store(e.to_string()))?;
        let secret = self.protector.unprotect(&wrapped).map_err(HelloError::Store)?;
        if secret.len() != SECRET_LEN {
            return Err(HelloError::BadSecret);
        }
        Ok(secret)
    }

    pub fn disable(&self) -> Result<(), HelloError> {
        match std::fs::remove_file(&self.path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(HelloError::Store(e.to_string())),
        }
    }
}

/// For the e2e build and these tests: says what it's told. Never compiled into a release,
/// because the app's `e2e` feature is off there.
pub struct MockGate {
    pub available: bool,
    pub answer: std::sync::Mutex<Verdict>,
    pub calls: std::sync::atomic::AtomicU32,
}

impl MockGate {
    pub fn new(available: bool, answer: Verdict) -> Self {
        Self { available, answer: std::sync::Mutex::new(answer), calls: Default::default() }
    }
}

impl ConsentGate for MockGate {
    fn available(&self) -> bool {
        self.available
    }
    fn verify(&self, _window: isize, _message: &str) -> Verdict {
        self.calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        *self.answer.lock().unwrap()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::Ordering;

    struct TestDir(PathBuf);
    impl TestDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!("promptly-hello-test-{tag}-{}", crate::random_token()));
            std::fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for TestDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn store(dir: &TestDir, answer: Verdict) -> HelloStore<MockGate, RealProtector> {
        HelloStore { path: dir.0.join("hello.bin"), gate: MockGate::new(true, answer), protector: RealProtector("promptly-test/hello") }
    }

    #[test]
    fn enable_then_unlock_returns_the_secret() {
        let dir = TestDir::new("rt");
        let s = store(&dir, Verdict::Approved);
        assert!(!s.is_enabled());
        s.enable(1, &[7u8; SECRET_LEN], "m").unwrap();
        assert!(s.is_enabled());
        assert_eq!(&**s.unlock(1, "m").unwrap(), &[7u8; SECRET_LEN]);
        assert_eq!(s.gate.calls.load(Ordering::SeqCst), 2, "asked on enable and on unlock");
    }

    #[test]
    fn the_file_on_disk_is_not_the_secret() {
        let dir = TestDir::new("disk");
        let s = store(&dir, Verdict::Approved);
        s.enable(1, &[0x41u8; SECRET_LEN], "m").unwrap();
        let on_disk = std::fs::read(&s.path).unwrap();
        assert!(!on_disk.windows(16).any(|w| w == [0x41u8; 16]));
    }

    #[test]
    fn refused_or_unavailable_gate_gives_nothing() {
        let dir = TestDir::new("deny");
        let s = store(&dir, Verdict::Approved);
        s.enable(1, &[7u8; SECRET_LEN], "m").unwrap();
        *s.gate.answer.lock().unwrap() = Verdict::Cancelled;
        assert_eq!(s.unlock(1, "m").unwrap_err(), HelloError::Cancelled);
        *s.gate.answer.lock().unwrap() = Verdict::Unavailable;
        assert_eq!(s.unlock(1, "m").unwrap_err(), HelloError::Unavailable);
    }

    #[test]
    fn enable_needs_the_gate_too_and_writes_nothing_without_it() {
        let dir = TestDir::new("enable");
        let s = store(&dir, Verdict::Cancelled);
        assert_eq!(s.enable(1, &[7u8; SECRET_LEN], "m").unwrap_err(), HelloError::Cancelled);
        assert!(!s.is_enabled());
    }

    #[test]
    fn wrong_length_secret_is_refused_before_asking() {
        let dir = TestDir::new("len");
        let s = store(&dir, Verdict::Approved);
        assert_eq!(s.enable(1, &[7u8; 32], "m").unwrap_err(), HelloError::BadSecret);
        assert_eq!(s.gate.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn unlock_when_off_does_not_prompt() {
        let dir = TestDir::new("off");
        let s = store(&dir, Verdict::Approved);
        assert_eq!(s.unlock(1, "m").unwrap_err(), HelloError::NotEnabled);
        assert_eq!(s.gate.calls.load(Ordering::SeqCst), 0);
    }

    #[test]
    fn disable_removes_it_and_is_idempotent() {
        let dir = TestDir::new("disable");
        let s = store(&dir, Verdict::Approved);
        s.enable(1, &[7u8; SECRET_LEN], "m").unwrap();
        s.disable().unwrap();
        assert!(!s.is_enabled());
        s.disable().unwrap();
        assert_eq!(s.unlock(1, "m").unwrap_err(), HelloError::NotEnabled);
    }

    #[test]
    fn a_file_copied_from_elsewhere_or_damaged_does_not_open() {
        let dir = TestDir::new("damage");
        let s = store(&dir, Verdict::Approved);
        std::fs::write(&s.path, b"not a dpapi blob").unwrap();
        assert!(matches!(s.unlock(1, "m").unwrap_err(), HelloError::Store(_)));
    }

    /// Asks the real API only whether Hello is set up, which shows no prompt. The answer
    /// depends on the machine, so this only checks the call completes.
    #[test]
    fn real_availability_check_returns() {
        let _ = RealGate.available();
    }
}
