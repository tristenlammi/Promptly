//! Native parts of Promptly Passwords on Windows. See ../README.md and SECURITY.md.
pub mod autotype;
pub mod backup;
pub mod clipboard;
pub mod dialog;
pub mod dpapi;
pub mod hello;
pub mod net;
pub mod nmhost;
pub mod reg;
pub mod settings;
pub mod sshagent;

/// Random bytes from the OS. A failure here means nothing safe can happen next.
pub fn random_bytes<const N: usize>() -> [u8; N] {
    let mut out = [0u8; N];
    getrandom::fill(&mut out).expect("the OS random source failed");
    out
}

pub fn random_token() -> String {
    use base64::Engine;
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(random_bytes::<24>())
}
