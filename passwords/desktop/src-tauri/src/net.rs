//! The one way out for vault traffic. The page sends bytes and a little JSON describing the
//! request, and gets back a status, headers and bytes. `promptly_native::net` decides what's
//! allowed; this is only the plumbing.
use base64::Engine;
use promptly_native::net as rules;
use serde::{Deserialize, Serialize};
use tauri::ipc::{InvokeBody, Request, Response};
use tauri::{State, WebviewWindow};

use crate::commands::main_only;
use crate::state::App;

#[derive(Deserialize)]
struct Meta {
    url: String,
    method: String,
    #[serde(default)]
    headers: Vec<(String, String)>,
}

#[derive(Serialize)]
struct RespMeta {
    status: u16,
    headers: Vec<(String, String)>,
}

/// Which response headers the page may see.
fn response_header_allowed(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "content-type" | "retry-after")
}

/// Request: raw body, with `x-meta` holding base64url JSON. Response: a u32 big-endian
/// length, that much JSON, then the body.
#[tauri::command]
pub async fn net_fetch(window: WebviewWindow, app: State<'_, App>, request: Request<'_>) -> Result<Response, String> {
    main_only(&window)?;
    #[cfg(feature = "e2e")]
    if std::env::var_os("PROMPTLY_PW_OFFLINE").is_some() {
        return Err("The server can't be reached".to_string());
    }
    let meta = request.headers().get("x-meta").ok_or("no request details")?.to_str().map_err(|e| e.to_string())?;
    let meta = base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(meta).map_err(|e| e.to_string())?;
    let meta: Meta = serde_json::from_slice(&meta).map_err(|e| e.to_string())?;
    let body = match request.body() {
        InvokeBody::Raw(b) => b.clone(),
        InvokeBody::Json(serde_json::Value::Null) => vec![],
        InvokeBody::Json(_) => return Err("body must be raw bytes".to_string()),
    };

    let connected = app.settings.lock().unwrap().server.clone();
    let token_goes = connected.is_some();
    let server = connected.or_else(|| app.pending_server.lock().unwrap().clone()).ok_or("Not connected to a server")?;
    let path = rules::check_request(&server, &meta.url, &meta.method).map_err(|e| e.to_string())?;

    let method = reqwest::Method::from_bytes(meta.method.as_bytes()).map_err(|e| e.to_string())?;
    let mut out = app.http.request(method, format!("{server}{path}"));
    for (k, v) in &meta.headers {
        if rules::header_allowed(k) {
            out = out.header(k, v);
        }
    }
    // Only ever to the server it was issued for, never one still being connected to.
    if token_goes && rules::wants_device_token(&path) {
        let token = app.token.lock().unwrap().as_ref().map(|t| format!("Bearer {}", t.as_str()));
        if let Some(t) = token {
            out = out.header(reqwest::header::AUTHORIZATION, t);
        }
    }
    if !body.is_empty() {
        out = out.body(body);
    }
    let res = out.send().await.map_err(|_| "The server can't be reached".to_string())?;
    let status = res.status().as_u16();
    let headers: Vec<(String, String)> = res
        .headers()
        .iter()
        .filter(|(k, _)| response_header_allowed(k.as_str()))
        .filter_map(|(k, v)| v.to_str().ok().map(|v| (k.to_string(), v.to_string())))
        .collect();
    let bytes = res.bytes().await.map_err(|_| "The server can't be reached".to_string())?;
    let head = serde_json::to_vec(&RespMeta { status, headers }).map_err(|e| e.to_string())?;
    let mut framed = Vec::with_capacity(4 + head.len() + bytes.len());
    framed.extend_from_slice(&(head.len() as u32).to_be_bytes());
    framed.extend_from_slice(&head);
    framed.extend_from_slice(&bytes);
    Ok(Response::new(framed))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_two_headers_the_client_reads_come_back() {
        assert!(response_header_allowed("Content-Type"));
        assert!(response_header_allowed("retry-after"));
        assert!(!response_header_allowed("set-cookie"));
        assert!(!response_header_allowed("location"));
    }
}
