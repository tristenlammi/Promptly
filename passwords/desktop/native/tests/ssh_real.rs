//! The agent against the real Windows OpenSSH tools, on a test pipe of its own via
//! SSH_AUTH_SOCK. `ssh-keygen -Y` then verifies the signature independently of our code.
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;

use base64::Engine;
use ed25519_dalek::{Signer, SigningKey};
use promptly_native::sshagent::{create_pipe, run, Backend, Identity};

const OPENSSH: &str = r"C:\Windows\System32\OpenSSH";

struct Real {
    key: SigningKey,
    blob: Vec<u8>,
    approve: AtomicBool,
    asked: AtomicU32,
}

impl Backend for Real {
    async fn identities(&self) -> Vec<Identity> {
        vec![Identity { blob: self.blob.clone(), comment: "test key".into() }]
    }
    async fn sign(&self, _client: &str, _key: &Identity, data: Vec<u8>) -> Option<[u8; 64]> {
        self.asked.fetch_add(1, Ordering::SeqCst);
        self.approve.load(Ordering::SeqCst).then(|| self.key.sign(&data).to_bytes())
    }
}

fn put(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

fn tool(name: &str, pipe: &str) -> Command {
    let mut c = Command::new(Path::new(OPENSSH).join(name));
    c.env("SSH_AUTH_SOCK", pipe);
    c
}

#[tokio::test(flavor = "multi_thread")]
async fn real_ssh_add_and_ssh_keygen_use_the_agent() {
    if !Path::new(OPENSSH).join("ssh-keygen.exe").exists() {
        panic!("Windows OpenSSH isn't installed here, so this test can't run");
    }
    let key = SigningKey::from_bytes(&promptly_native::random_bytes::<32>());
    let mut blob = vec![];
    put(&mut blob, b"ssh-ed25519");
    put(&mut blob, key.verifying_key().as_bytes());
    let line = format!("ssh-ed25519 {} test key", base64::engine::general_purpose::STANDARD.encode(&blob));

    let dir: PathBuf = std::env::temp_dir().join(format!("promptly-ssh-real-{}", promptly_native::random_token()));
    std::fs::create_dir_all(&dir).unwrap();
    let pub_file = dir.join("key.pub");
    std::fs::write(&pub_file, format!("{line}\n")).unwrap();
    let msg = dir.join("msg.txt");
    std::fs::write(&msg, b"signed by the agent").unwrap();
    let allowed = dir.join("allowed");
    std::fs::write(&allowed, format!("me@test {line}\n")).unwrap();

    let name = format!(r"\\.\pipe\promptly-test-agent-{}", promptly_native::random_token());
    let backend = Arc::new(Real { key, blob, approve: AtomicBool::new(true), asked: AtomicU32::new(0) });
    let server = create_pipe(&name, true).unwrap();
    let (stop, stop_rx) = tokio::sync::watch::channel(false);
    let runner = tokio::spawn(run(name.clone(), server, backend.clone(), stop_rx));

    let name2 = name.clone();
    let listed = tokio::task::spawn_blocking(move || tool("ssh-add.exe", &name2).arg("-L").output().unwrap()).await.unwrap();
    assert!(listed.status.success(), "{}", String::from_utf8_lossy(&listed.stderr));
    assert!(String::from_utf8_lossy(&listed.stdout).contains(line.split(' ').nth(1).unwrap()), "ssh-add -L lists the key");

    // A real signature, checked by ssh-keygen itself.
    let (name3, pub3, msg3) = (name.clone(), pub_file.clone(), msg.clone());
    let signed = tokio::task::spawn_blocking(move || tool("ssh-keygen.exe", &name3).args(["-Y", "sign", "-n", "file", "-U", "-f"]).arg(&pub3).arg(&msg3).output().unwrap()).await.unwrap();
    assert!(signed.status.success(), "{}", String::from_utf8_lossy(&signed.stderr));
    assert_eq!(backend.asked.load(Ordering::SeqCst), 1, "it asked");

    let sig = dir.join("msg.txt.sig");
    let verify = std::process::Command::new(Path::new(OPENSSH).join("ssh-keygen.exe"))
        .args(["-Y", "verify", "-n", "file", "-I", "me@test", "-f"])
        .arg(&allowed)
        .arg("-s")
        .arg(&sig)
        .stdin(std::fs::File::open(&msg).unwrap())
        .output()
        .unwrap();
    assert!(verify.status.success(), "{}", String::from_utf8_lossy(&verify.stderr));

    // Refused: the client gets a failure and no signature file.
    backend.approve.store(false, Ordering::SeqCst);
    std::fs::remove_file(&sig).unwrap();
    let (name4, pub4, msg4) = (name.clone(), pub_file.clone(), msg.clone());
    let refused = tokio::task::spawn_blocking(move || tool("ssh-keygen.exe", &name4).args(["-Y", "sign", "-n", "file", "-U", "-f"]).arg(&pub4).arg(&msg4).output().unwrap()).await.unwrap();
    assert!(!refused.status.success());
    assert!(!sig.exists());
    assert_eq!(backend.asked.load(Ordering::SeqCst), 2, "asked again: nothing was remembered");

    stop.send(true).unwrap();
    runner.await.unwrap();
    let _ = std::fs::remove_dir_all(&dir);
}
