//! The webview has no network of its own (its CSP allows only Tauri's IPC). All vault traffic
//! goes through one Rust call, which can only reach the connected server's vault API. Even a
//! compromised page has nowhere else to send things.

#[derive(Debug, PartialEq, Eq)]
pub enum NetError {
    BadServer,
    NotVaultApi,
    BadMethod,
}

impl std::fmt::Display for NetError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::BadServer => write!(f, "That doesn't look like a server address. It needs https, except on your own machine."),
            Self::NotVaultApi => write!(f, "That address isn't the vault API."),
            Self::BadMethod => write!(f, "That method isn't used."),
        }
    }
}

fn is_local(host: &str) -> bool {
    host == "localhost" || host == "127.0.0.1" || host == "[::1]" || host.ends_with(".localhost")
}

/// `https://host[:port]` or, on this machine only, `http://`. Same rule as the extension.
/// No path, userinfo, query or fragment.
pub fn normalise_server(input: &str) -> Result<String, NetError> {
    let input = input.trim().trim_end_matches('/');
    let (scheme, rest) = match input.split_once("://") {
        Some((s, r)) => (s.to_ascii_lowercase(), r),
        None => ("https".to_string(), input),
    };
    if rest.is_empty() || rest.contains(['/', '?', '#', '@', '\\', ' ']) {
        return Err(NetError::BadServer);
    }
    let lower = rest.to_ascii_lowercase();
    let host = match lower.strip_prefix('[') {
        Some(_) => lower.split_inclusive(']').next().unwrap_or("").to_string(),
        None => lower.split(':').next().unwrap_or("").to_string(),
    };
    if host.is_empty() {
        return Err(NetError::BadServer);
    }
    let port_ok = match lower.strip_prefix(&host) {
        Some("") => true,
        Some(p) => p.strip_prefix(':').is_some_and(|n| !n.is_empty() && n.parse::<u16>().is_ok()),
        None => false,
    };
    if !port_ok {
        return Err(NetError::BadServer);
    }
    match scheme.as_str() {
        "https" => Ok(format!("https://{lower}")),
        "http" if is_local(&host) => Ok(format!("http://{lower}")),
        _ => Err(NetError::BadServer),
    }
}

const ALLOWED_METHODS: &[&str] = &["GET", "POST", "PUT", "PATCH", "DELETE"];
const API_PREFIX: &str = "/api/passwords/";

/// What the webview asked for, checked against the connected server. Returns the path and
/// query to request. `url` must start with exactly the server's origin.
pub fn check_request(server: &str, url: &str, method: &str) -> Result<String, NetError> {
    if !ALLOWED_METHODS.contains(&method) {
        return Err(NetError::BadMethod);
    }
    let rest = url.strip_prefix(server).ok_or(NetError::NotVaultApi)?;
    if !rest.starts_with(API_PREFIX) || rest.contains("..") || rest.contains('\\') || rest.contains('#') {
        return Err(NetError::NotVaultApi);
    }
    let decoded_dots = rest.to_ascii_lowercase();
    if decoded_dots.contains("%2e") || decoded_dots.contains("%2f") || decoded_dots.contains("%5c") {
        return Err(NetError::NotVaultApi);
    }
    Ok(rest.to_string())
}

/// Headers a page may set. Authorization isn't one of them: Rust adds the device token,
/// and the page never sees it after connecting.
pub fn header_allowed(name: &str) -> bool {
    matches!(name.to_ascii_lowercase().as_str(), "content-type" | "x-vault-session")
}

/// The two public connect calls run before there's a device token, and don't need one.
pub fn wants_device_token(path: &str) -> bool {
    let bare = path.split('?').next().unwrap_or(path);
    !matches!(bare, "/api/passwords/connect/start" | "/api/passwords/connect/poll")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn server_addresses() {
        assert_eq!(normalise_server("https://home.example.org/").unwrap(), "https://home.example.org");
        assert_eq!(normalise_server("home.example.org").unwrap(), "https://home.example.org");
        assert_eq!(normalise_server("HTTPS://Home.Example.ORG:8443").unwrap(), "https://home.example.org:8443");
        assert_eq!(normalise_server("http://localhost:8092").unwrap(), "http://localhost:8092");
        assert_eq!(normalise_server("http://127.0.0.1:8092").unwrap(), "http://127.0.0.1:8092");
        assert_eq!(normalise_server("http://app.localhost").unwrap(), "http://app.localhost");
        assert_eq!(normalise_server("http://[::1]:8092").unwrap(), "http://[::1]:8092");
        for bad in [
            "http://example.org",
            "http://localhost.example.org",
            "ftp://example.org",
            "file:///c:/x",
            "https://user:pw@example.org",
            "https://example.org/some/path",
            "https://example.org?x=1",
            "https://example.org:notaport",
            "https://example.org:99999",
            "https://exa mple.org",
            "",
            "https://",
        ] {
            assert!(normalise_server(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn only_the_vault_api_on_the_connected_server() {
        let s = "https://home.example.org";
        assert_eq!(check_request(s, "https://home.example.org/api/passwords/account", "GET").unwrap(), "/api/passwords/account");
        assert_eq!(check_request(s, "https://home.example.org/api/passwords/vaults/1/changes?since=0&limit=500", "GET").unwrap(), "/api/passwords/vaults/1/changes?since=0&limit=500");
        for (url, method) in [
            ("https://evil.example.org/api/passwords/account", "GET"),
            ("https://home.example.org.evil.org/api/passwords/account", "GET"),
            ("https://home.example.org@evil.org/api/passwords/account", "GET"),
            ("https://home.example.org/api/auth/refresh", "POST"),
            ("https://home.example.org/api/passwords/../auth/me", "GET"),
            ("https://home.example.org/api/passwords/%2e%2e/auth/me", "GET"),
            ("https://home.example.org/api/passwords/%2E%2E%2Fauth", "GET"),
            ("https://home.example.org/api/passwords\\..\\auth", "GET"),
            ("http://home.example.org/api/passwords/account", "GET"),
            ("https://home.example.org/", "GET"),
        ] {
            assert_eq!(check_request(s, url, method), Err(NetError::NotVaultApi), "{url}");
        }
        assert_eq!(check_request(s, "https://home.example.org/api/passwords/account", "TRACE"), Err(NetError::BadMethod));
        assert_eq!(check_request(s, "https://home.example.org/api/passwords/account", "CONNECT"), Err(NetError::BadMethod));
    }

    #[test]
    fn the_page_cannot_set_identity_headers() {
        assert!(header_allowed("Content-Type"));
        assert!(header_allowed("x-vault-session"));
        assert!(!header_allowed("Authorization"));
        assert!(!header_allowed("Cookie"));
        assert!(!header_allowed("Host"));
    }

    #[test]
    fn token_goes_on_everything_but_the_public_connect_calls() {
        assert!(!wants_device_token("/api/passwords/connect/start"));
        assert!(!wants_device_token("/api/passwords/connect/poll"));
        assert!(wants_device_token("/api/passwords/account"));
        assert!(wants_device_token("/api/passwords/connect/code/ABC"));
    }
}
