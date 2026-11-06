//! An SSH agent on OpenSSH's pipe. It never holds a private key: it lists public keys the
//! vault gave it, and for each signature asks the person, then asks the page to sign.
//! It only ever takes the pipe if nothing else has it, so a running OpenSSH agent is left alone.
use std::future::Future;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};
use tokio::net::windows::named_pipe::{NamedPipeServer, ServerOptions};

pub const PIPE_NAME: &str = r"\\.\pipe\openssh-ssh-agent";

const SSH_AGENT_FAILURE: u8 = 5;
const SSH_AGENTC_REQUEST_IDENTITIES: u8 = 11;
const SSH_AGENT_IDENTITIES_ANSWER: u8 = 12;
const SSH_AGENTC_SIGN_REQUEST: u8 = 13;
const SSH_AGENT_SIGN_RESPONSE: u8 = 14;
const MAX_MESSAGE: u32 = 256 * 1024;
pub const ED25519: &str = "ssh-ed25519";

#[derive(Debug, PartialEq, Eq, Clone)]
pub struct Identity {
    /// The public key blob, exactly as in the OpenSSH public key line's base64.
    pub blob: Vec<u8>,
    pub comment: String,
}

#[derive(Debug, PartialEq, Eq)]
pub enum Request {
    Identities,
    Sign { key_blob: Vec<u8>, data: Vec<u8>, flags: u32 },
    Other(u8),
}

fn read_string<'a>(b: &mut &'a [u8]) -> Option<&'a [u8]> {
    if b.len() < 4 {
        return None;
    }
    let n = u32::from_be_bytes(b[..4].try_into().ok()?) as usize;
    if b.len() - 4 < n {
        return None;
    }
    let out = &b[4..4 + n];
    *b = &b[4 + n..];
    Some(out)
}

fn put_string(out: &mut Vec<u8>, s: &[u8]) {
    out.extend_from_slice(&(s.len() as u32).to_be_bytes());
    out.extend_from_slice(s);
}

pub fn parse_request(msg: &[u8]) -> Option<Request> {
    let (&kind, mut rest) = msg.split_first()?;
    match kind {
        SSH_AGENTC_REQUEST_IDENTITIES => Some(Request::Identities),
        SSH_AGENTC_SIGN_REQUEST => {
            let key_blob = read_string(&mut rest)?.to_vec();
            let data = read_string(&mut rest)?.to_vec();
            if rest.len() != 4 {
                return None;
            }
            let flags = u32::from_be_bytes(rest.try_into().ok()?);
            Some(Request::Sign { key_blob, data, flags })
        }
        other => Some(Request::Other(other)),
    }
}

pub fn failure() -> Vec<u8> {
    vec![SSH_AGENT_FAILURE]
}

pub fn identities_answer(ids: &[Identity]) -> Vec<u8> {
    let mut out = vec![SSH_AGENT_IDENTITIES_ANSWER];
    out.extend_from_slice(&(ids.len() as u32).to_be_bytes());
    for id in ids {
        put_string(&mut out, &id.blob);
        put_string(&mut out, id.comment.as_bytes());
    }
    out
}

/// `string "ssh-ed25519", string signature`, wrapped once more as the response's one field.
pub fn ed25519_sign_response(sig: &[u8; 64]) -> Vec<u8> {
    let mut inner = vec![];
    put_string(&mut inner, ED25519.as_bytes());
    put_string(&mut inner, sig);
    let mut out = vec![SSH_AGENT_SIGN_RESPONSE];
    put_string(&mut out, &inner);
    out
}

/// The key type at the start of a public key blob.
pub fn blob_type(blob: &[u8]) -> Option<&str> {
    let mut b = blob;
    std::str::from_utf8(read_string(&mut b)?).ok()
}

pub trait Backend: Send + Sync {
    /// What the vault offers. Empty while it's locked.
    fn identities(&self) -> impl Future<Output = Vec<Identity>> + Send;
    /// Shows the approval, and only if the person says yes, asks for a signature.
    /// `client` names the process on the other end of the pipe.
    fn sign(&self, client: &str, key: &Identity, data: Vec<u8>) -> impl Future<Output = Option<[u8; 64]>> + Send;
}

/// One message from the wire to the answer. Anything we don't support gets a plain failure,
/// which is what clients expect for optional requests.
pub async fn answer<B: Backend>(backend: &B, client: &str, msg: &[u8]) -> Vec<u8> {
    match parse_request(msg) {
        Some(Request::Identities) => identities_answer(&backend.identities().await),
        Some(Request::Sign { key_blob, data, .. }) => {
            if blob_type(&key_blob) != Some(ED25519) {
                return failure();
            }
            let ids = backend.identities().await;
            let Some(id) = ids.iter().find(|i| i.blob == key_blob) else {
                return failure();
            };
            match backend.sign(client, id, data).await {
                Some(sig) => ed25519_sign_response(&sig),
                None => failure(),
            }
        }
        _ => failure(),
    }
}

/// Serves one connection until it closes. Messages are a u32 big-endian length then the body.
pub async fn serve_connection<S: AsyncRead + AsyncWrite + Unpin, B: Backend>(mut stream: S, backend: &B, client: &str) -> std::io::Result<()> {
    loop {
        let mut len = [0u8; 4];
        match stream.read_exact(&mut len).await {
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::UnexpectedEof => return Ok(()),
            Err(e) => return Err(e),
        }
        let n = u32::from_be_bytes(len);
        if n == 0 || n > MAX_MESSAGE {
            return Ok(());
        }
        let mut msg = vec![0u8; n as usize];
        stream.read_exact(&mut msg).await?;
        let reply = answer(backend, client, &msg).await;
        stream.write_all(&(reply.len() as u32).to_be_bytes()).await?;
        stream.write_all(&reply).await?;
        stream.flush().await?;
    }
}

// ---- The pipe ----

#[derive(Debug, PartialEq, Eq)]
pub enum StartError {
    /// Something else holds the name, probably Windows's OpenSSH Authentication Agent.
    PipeTaken,
    Other(String),
}

impl std::fmt::Display for StartError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::PipeTaken => write!(f, "Another SSH agent is already running (usually the Windows OpenSSH Authentication Agent). It's been left alone. Stop it in Services to use this one."),
            Self::Other(e) => write!(f, "{e}"),
        }
    }
}

/// `first_pipe_instance` is what keeps us from sharing a name with a running agent: Windows
/// refuses the create if the pipe already exists. Remote clients are refused, and the DACL
/// only lets this user in.
pub fn create_pipe(name: &str, first: bool) -> Result<NamedPipeServer, StartError> {
    use windows::core::w;
    use windows::Win32::Foundation::{LocalFree, HLOCAL};
    use windows::Win32::Security::Authorization::{ConvertStringSecurityDescriptorToSecurityDescriptorW, SDDL_REVISION_1};
    use windows::Win32::Security::{PSECURITY_DESCRIPTOR, SECURITY_ATTRIBUTES};

    let mut sd = PSECURITY_DESCRIPTOR::default();
    // Owner Rights get everything, and nobody else gets anything.
    // SAFETY: a constant SDDL string, sd is an out parameter freed below.
    unsafe { ConvertStringSecurityDescriptorToSecurityDescriptorW(w!("D:P(A;;GA;;;OW)"), SDDL_REVISION_1, &mut sd, None) }.map_err(|e| StartError::Other(e.to_string()))?;
    let mut sa = SECURITY_ATTRIBUTES { nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32, lpSecurityDescriptor: sd.0, bInheritHandle: false.into() };
    let mut opts = ServerOptions::new();
    opts.first_pipe_instance(first).reject_remote_clients(true);
    // SAFETY: sa and the descriptor it points to are alive until after this call.
    let made = unsafe { opts.create_with_security_attributes_raw(name, &mut sa as *mut _ as *mut _) };
    // SAFETY: from the convert call above.
    unsafe {
        let _ = LocalFree(Some(HLOCAL(sd.0)));
    }
    made.map_err(|e| {
        // ERROR_ACCESS_DENIED is what a taken name gives with first_pipe_instance;
        // ERROR_PIPE_BUSY if the other side has used up its instances.
        if matches!(e.raw_os_error(), Some(5) | Some(231)) {
            StartError::PipeTaken
        } else {
            StartError::Other(e.to_string())
        }
    })
}

/// The process on the other end of a pipe, by name, for the approval prompt.
pub fn client_process(pipe: &NamedPipeServer) -> String {
    use std::os::windows::io::AsRawHandle;
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Pipes::GetNamedPipeClientProcessId;
    use windows::Win32::System::Threading::{OpenProcess, QueryFullProcessImageNameW, PROCESS_NAME_WIN32, PROCESS_QUERY_LIMITED_INFORMATION};
    let mut pid = 0u32;
    // SAFETY: a live pipe handle, and buffers are the size passed.
    unsafe {
        if GetNamedPipeClientProcessId(HANDLE(pipe.as_raw_handle() as *mut _), &mut pid).is_err() {
            return "an unknown program".to_string();
        }
        let Ok(h) = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) else {
            return format!("process {pid}");
        };
        let mut buf = vec![0u16; 2048];
        let mut len = buf.len() as u32;
        let name = QueryFullProcessImageNameW(h, PROCESS_NAME_WIN32, windows::core::PWSTR(buf.as_mut_ptr()), &mut len).ok().map(|_| String::from_utf16_lossy(&buf[..len as usize]));
        let _ = CloseHandle(h);
        name.and_then(|p| p.rsplit('\\').next().map(str::to_string)).unwrap_or_else(|| format!("process {pid}"))
    }
}

/// Accepts clients until `stop` fires. The first instance has already been created by the
/// caller, so a taken pipe is reported before this ever runs.
pub async fn run<B: Backend + 'static>(name: String, mut server: NamedPipeServer, backend: std::sync::Arc<B>, mut stop: tokio::sync::watch::Receiver<bool>) {
    loop {
        tokio::select! {
            _ = stop.changed() => return,
            connected = server.connect() => {
                if connected.is_err() {
                    return;
                }
                let Ok(next) = create_pipe(&name, false) else { return };
                let client = std::mem::replace(&mut server, next);
                let backend = backend.clone();
                tokio::spawn(async move {
                    let who = client_process(&client);
                    let _ = serve_connection(client, &*backend, &who).await;
                });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};

    struct Mock {
        ids: Vec<Identity>,
        approve: bool,
        signs: AtomicU32,
        seen_client: Mutex<String>,
    }

    impl Backend for Mock {
        async fn identities(&self) -> Vec<Identity> {
            self.ids.clone()
        }
        async fn sign(&self, client: &str, _key: &Identity, _data: Vec<u8>) -> Option<[u8; 64]> {
            *self.seen_client.lock().unwrap() = client.to_string();
            self.signs.fetch_add(1, Ordering::SeqCst);
            self.approve.then_some([0xab; 64])
        }
    }

    fn ed_blob(k: u8) -> Vec<u8> {
        let mut b = vec![];
        put_string(&mut b, ED25519.as_bytes());
        put_string(&mut b, &[k; 32]);
        b
    }

    fn mock(approve: bool) -> Mock {
        Mock { ids: vec![Identity { blob: ed_blob(1), comment: "work laptop".into() }], approve, signs: AtomicU32::new(0), seen_client: Mutex::new(String::new()) }
    }

    fn sign_msg(blob: &[u8]) -> Vec<u8> {
        let mut m = vec![SSH_AGENTC_SIGN_REQUEST];
        put_string(&mut m, blob);
        put_string(&mut m, b"to be signed");
        m.extend_from_slice(&0u32.to_be_bytes());
        m
    }

    #[test]
    fn parses_requests_and_refuses_junk() {
        assert_eq!(parse_request(&[11]), Some(Request::Identities));
        assert_eq!(parse_request(&[27, 1, 2]), Some(Request::Other(27)));
        assert_eq!(parse_request(&[]), None);
        let m = sign_msg(&ed_blob(1));
        assert_eq!(parse_request(&m), Some(Request::Sign { key_blob: ed_blob(1), data: b"to be signed".to_vec(), flags: 0 }));
        assert_eq!(parse_request(&m[..m.len() - 1]), None, "short flags");
        let mut long = m.clone();
        long.push(0);
        assert_eq!(parse_request(&long), None, "trailing bytes");
        assert_eq!(parse_request(&[13, 0xff, 0xff, 0xff, 0xff]), None, "length past the end");
    }

    #[test]
    fn encodes_identities_and_signatures() {
        let a = identities_answer(&[Identity { blob: vec![1, 2], comment: "c".into() }]);
        assert_eq!(a, vec![12, 0, 0, 0, 1, 0, 0, 0, 2, 1, 2, 0, 0, 0, 1, b'c']);
        assert_eq!(identities_answer(&[]), vec![12, 0, 0, 0, 0]);
        let s = ed25519_sign_response(&[7u8; 64]);
        assert_eq!(s[0], 14);
        let mut rest = &s[1..];
        let mut inner = read_string(&mut rest).unwrap();
        assert!(rest.is_empty());
        assert_eq!(read_string(&mut inner).unwrap(), ED25519.as_bytes());
        assert_eq!(read_string(&mut inner).unwrap(), &[7u8; 64]);
    }

    #[tokio::test]
    async fn each_signature_asks_and_a_refusal_is_a_failure() {
        let m = mock(false);
        assert_eq!(answer(&m, "ssh.exe", &sign_msg(&ed_blob(1))).await, failure());
        assert_eq!(m.signs.load(Ordering::SeqCst), 1);

        let m = mock(true);
        let r = answer(&m, "ssh.exe", &sign_msg(&ed_blob(1))).await;
        assert_eq!(r[0], SSH_AGENT_SIGN_RESPONSE);
        answer(&m, "ssh.exe", &sign_msg(&ed_blob(1))).await;
        assert_eq!(m.signs.load(Ordering::SeqCst), 2, "no approval is remembered");
        assert_eq!(*m.seen_client.lock().unwrap(), "ssh.exe");
    }

    #[tokio::test]
    async fn never_asks_about_a_key_it_does_not_have_or_an_unsupported_type() {
        let m = mock(true);
        assert_eq!(answer(&m, "x", &sign_msg(&ed_blob(2))).await, failure());
        let mut rsa = vec![];
        put_string(&mut rsa, b"ssh-rsa");
        assert_eq!(answer(&m, "x", &sign_msg(&rsa)).await, failure());
        assert_eq!(m.signs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn locked_vault_lists_nothing_and_signs_nothing() {
        let m = Mock { ids: vec![], approve: true, signs: AtomicU32::new(0), seen_client: Mutex::new(String::new()) };
        assert_eq!(answer(&m, "x", &[SSH_AGENTC_REQUEST_IDENTITIES]).await, identities_answer(&[]));
        assert_eq!(answer(&m, "x", &sign_msg(&ed_blob(1))).await, failure());
        assert_eq!(m.signs.load(Ordering::SeqCst), 0);
    }

    #[tokio::test]
    async fn unknown_requests_get_a_failure_not_a_hangup() {
        let m = mock(true);
        assert_eq!(answer(&m, "x", &[27, 0, 0]).await, failure());
        assert_eq!(answer(&m, "x", &[]).await, failure());
    }

    #[tokio::test]
    async fn wire_framing_over_a_stream() {
        let (mut client, server) = tokio::io::duplex(4096);
        let m = Arc::new(mock(true));
        let backend = m.clone();
        let task = tokio::spawn(async move { serve_connection(server, &*backend, "t").await });
        client.write_all(&1u32.to_be_bytes()).await.unwrap();
        client.write_all(&[SSH_AGENTC_REQUEST_IDENTITIES]).await.unwrap();
        let mut len = [0u8; 4];
        client.read_exact(&mut len).await.unwrap();
        let mut reply = vec![0u8; u32::from_be_bytes(len) as usize];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[0], SSH_AGENT_IDENTITIES_ANSWER);
        // An absurd length just ends the connection.
        client.write_all(&(MAX_MESSAGE + 1).to_be_bytes()).await.unwrap();
        task.await.unwrap().unwrap();
    }

    fn test_pipe() -> String {
        format!(r"\\.\pipe\promptly-test-agent-{}", crate::random_token())
    }

    #[tokio::test]
    async fn does_not_take_a_pipe_that_exists() {
        let name = test_pipe();
        let first = create_pipe(&name, true).unwrap();
        assert_eq!(create_pipe(&name, true).err(), Some(StartError::PipeTaken));
        drop(first);
    }

    #[tokio::test]
    async fn serves_a_real_named_pipe_client() {
        use tokio::net::windows::named_pipe::ClientOptions;
        let name = test_pipe();
        let server = create_pipe(&name, true).unwrap();
        let (stop_tx, stop_rx) = tokio::sync::watch::channel(false);
        let backend = Arc::new(mock(true));
        let runner = tokio::spawn(run(name.clone(), server, backend.clone(), stop_rx));
        let mut client = ClientOptions::new().open(&name).unwrap();
        client.write_all(&1u32.to_be_bytes()).await.unwrap();
        client.write_all(&[SSH_AGENTC_REQUEST_IDENTITIES]).await.unwrap();
        let mut len = [0u8; 4];
        client.read_exact(&mut len).await.unwrap();
        let mut reply = vec![0u8; u32::from_be_bytes(len) as usize];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply, identities_answer(&backend.ids));
        // The client process name is found from the real pipe. It's this test binary.
        let m = sign_msg(&ed_blob(1));
        client.write_all(&(m.len() as u32).to_be_bytes()).await.unwrap();
        client.write_all(&m).await.unwrap();
        client.read_exact(&mut len).await.unwrap();
        let mut reply = vec![0u8; u32::from_be_bytes(len) as usize];
        client.read_exact(&mut reply).await.unwrap();
        assert_eq!(reply[0], SSH_AGENT_SIGN_RESPONSE);
        assert!(backend.seen_client.lock().unwrap().to_lowercase().contains("promptly_native"), "{}", backend.seen_client.lock().unwrap());
        stop_tx.send(true).unwrap();
        runner.await.unwrap();
    }
}
