//! The SSH agent's link to the app. Off by default. Private keys stay in the page: Rust passes
//! it the bytes to sign, only after the person said yes, and gets back a signature.
use std::future::Future;
use std::sync::atomic::Ordering;
use std::sync::Arc;
use std::time::Duration;

use base64::Engine;
use promptly_native::sshagent::{self, Backend, Identity, StartError};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Emitter, Manager, State, WebviewWindow};
use tokio::sync::{oneshot, watch};

use crate::commands::main_only;
use crate::state::App;

const PAGE_WAIT: Duration = Duration::from_secs(5);

/// The test build answers the approval itself, on a pipe of its own.
#[cfg(feature = "e2e")]
pub static E2E_APPROVE: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(true);

fn pipe_name() -> String {
    #[cfg(feature = "e2e")]
    if let Ok(p) = std::env::var("PROMPTLY_PW_SSH_PIPE") {
        return p;
    }
    sshagent::PIPE_NAME.to_string()
}

#[cfg(feature = "e2e")]
async fn approve(_text: String) -> bool {
    E2E_APPROVE.load(Ordering::SeqCst)
}

// Per use, every use. No "remember", and no is the default button.
#[cfg(not(feature = "e2e"))]
async fn approve(text: String) -> bool {
    tauri::async_runtime::spawn_blocking(move || promptly_native::dialog::ask("Promptly Passwords: SSH", &text, 0)).await.unwrap_or(false)
}

struct AppBackend {
    app: AppHandle,
}

fn b64() -> base64::engine::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

/// The question for the approval box. Pure, so it's testable: it must name who's asking,
/// and which key, because the person is deciding on exactly that.
pub fn approval_text(client: &str, key_comment: &str) -> String {
    format!("{client} wants to use your SSH key \"{key_comment}\".\n\nAllow it, this one time?")
}

impl Backend for AppBackend {
    fn identities(&self) -> impl Future<Output = Vec<Identity>> + Send {
        let app = self.app.clone();
        async move {
            let state = app.state::<App>();
            let req = state.ssh_seq.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel();
            state.ssh_identities.lock().unwrap().insert(req, tx);
            if app.emit_to("main", "ssh:identities", serde_json::json!({ "req": req })).is_err() {
                return vec![];
            }
            let got = tokio::time::timeout(PAGE_WAIT, rx).await.ok().and_then(|r| r.ok()).unwrap_or_default();
            state.ssh_identities.lock().unwrap().remove(&req);
            got
        }
    }

    fn sign(&self, client: &str, key: &Identity, data: Vec<u8>) -> impl Future<Output = Option<[u8; 64]>> + Send {
        let app = self.app.clone();
        let text = approval_text(client, &key.comment);
        let blob = key.blob.clone();
        async move {
            if !approve(text).await {
                return None;
            }
            let state = app.state::<App>();
            let req = state.ssh_seq.fetch_add(1, Ordering::SeqCst);
            let (tx, rx) = oneshot::channel();
            state.ssh_signatures.lock().unwrap().insert(req, tx);
            if app.emit_to("main", "ssh:sign", serde_json::json!({ "req": req, "blob": b64().encode(&blob), "data": b64().encode(&data) })).is_err() {
                return None;
            }
            let got = tokio::time::timeout(PAGE_WAIT, rx).await.ok().and_then(|r| r.ok()).flatten();
            state.ssh_signatures.lock().unwrap().remove(&req);
            got
        }
    }
}

async fn start(app: AppHandle) -> Result<(), StartError> {
    let name = pipe_name();
    let server = sshagent::create_pipe(&name, true)?;
    let (tx, rx) = watch::channel(false);
    let backend = Arc::new(AppBackend { app: app.clone() });
    tauri::async_runtime::spawn(sshagent::run(name, server, backend, rx));
    *app.state::<App>().ssh_stop.lock().unwrap() = Some(tx);
    Ok(())
}

pub fn start_if_enabled(app: AppHandle) {
    if !app.state::<App>().settings.lock().unwrap().ssh_agent {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let result = start(app.clone()).await;
        *app.state::<App>().ssh_error.lock().unwrap() = result.err().map(|e| e.to_string());
    });
}

#[derive(Serialize)]
pub struct SshStatus {
    enabled: bool,
    running: bool,
    error: Option<String>,
}

#[tauri::command]
pub fn ssh_status(window: WebviewWindow, app: State<'_, App>) -> Result<SshStatus, String> {
    main_only(&window)?;
    Ok(SshStatus { enabled: app.settings.lock().unwrap().ssh_agent, running: app.ssh_stop.lock().unwrap().is_some(), error: app.ssh_error.lock().unwrap().clone() })
}

#[tauri::command]
pub async fn ssh_set(window: WebviewWindow, app: AppHandle, on: bool) -> Result<SshStatus, String> {
    main_only(&window)?;
    let state = app.state::<App>();
    let stop = state.ssh_stop.lock().unwrap().take();
    if let Some(stop) = stop {
        let _ = stop.send(true);
    }
    *state.ssh_error.lock().unwrap() = None;
    state.settings.lock().unwrap().ssh_agent = on;
    state.save_settings()?;
    if on {
        if let Err(e) = start(app.clone()).await {
            *state.ssh_error.lock().unwrap() = Some(e.to_string());
        }
    }
    let running = state.ssh_stop.lock().unwrap().is_some();
    let error = state.ssh_error.lock().unwrap().clone();
    Ok(SshStatus { enabled: on, running, error })
}

#[derive(Deserialize)]
pub struct IdentityOut {
    blob: String,
    comment: String,
}

#[tauri::command]
pub fn ssh_identities_reply(window: WebviewWindow, app: State<'_, App>, req: u64, identities: Vec<IdentityOut>) -> Result<(), String> {
    main_only(&window)?;
    let list = identities.into_iter().filter_map(|i| Some(Identity { blob: b64().decode(i.blob).ok()?, comment: i.comment })).collect();
    if let Some(tx) = app.ssh_identities.lock().unwrap().remove(&req) {
        let _ = tx.send(list);
    }
    Ok(())
}

#[tauri::command]
pub fn ssh_sign_reply(window: WebviewWindow, app: State<'_, App>, req: u64, signature: Option<String>) -> Result<(), String> {
    main_only(&window)?;
    let sig: Option<[u8; 64]> = signature.and_then(|s| b64().decode(s).ok()).and_then(|v| v.try_into().ok());
    if let Some(tx) = app.ssh_signatures.lock().unwrap().remove(&req) {
        let _ = tx.send(sig);
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_question_names_who_and_which_key() {
        let t = approval_text("ssh.exe", "work laptop");
        assert!(t.contains("ssh.exe"));
        assert!(t.contains("work laptop"));
        assert!(t.contains("this one time"));
    }
}
