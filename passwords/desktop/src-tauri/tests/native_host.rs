//! The real host exe, started the way a browser starts it but by something that isn't one.
//! Its caller checks must stop it before it reads a message or touches anything.
use std::io::Write;
use std::process::{Command, Stdio};

const ID: &str = "abcdefghijklmnopabcdefghijklmnop";

fn run(args: &[&str], ids_on_file: &[&str]) -> (i32, String, Vec<u8>) {
    let dir = std::env::temp_dir().join(format!("promptly-host-test-{}-{}", std::process::id(), ids_on_file.len()));
    let data = dir.join(promptly_native::settings::APP_DIR);
    std::fs::create_dir_all(&data).unwrap();
    let settings = promptly_native::settings::Settings { extension_ids: ids_on_file.iter().map(|s| s.to_string()).collect(), ..Default::default() };
    promptly_native::settings::save(&data.join("desktop.json"), &settings).unwrap();

    let mut child = Command::new(env!("CARGO_BIN_EXE_promptly-native-host"))
        .args(args)
        .env("LOCALAPPDATA", &dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap();
    let mut frame = vec![];
    promptly_native::nmhost::write_frame(&mut frame, br#"{"t":"status"}"#).unwrap();
    let _ = child.stdin.take().unwrap().write_all(&frame);
    let out = child.wait_with_output().unwrap();
    let _ = std::fs::remove_dir_all(&dir);
    (out.status.code().unwrap_or(-1), String::from_utf8_lossy(&out.stderr).to_string(), out.stdout)
}

#[test]
fn no_arguments_is_refused() {
    let (code, err, stdout) = run(&[], &[]);
    assert_eq!(code, 1);
    assert!(err.contains("no caller"), "{err}");
    assert!(stdout.is_empty());
}

#[test]
fn an_extension_not_on_the_list_is_refused() {
    let origin = format!("chrome-extension://{ID}/");
    let (code, err, stdout) = run(&[&origin], &[]);
    assert_eq!(code, 1);
    assert!(err.contains("isn't allowed"), "{err}");
    assert!(stdout.is_empty());
}

#[test]
fn a_listed_extension_from_a_program_that_is_not_a_browser_is_refused() {
    let origin = format!("chrome-extension://{ID}/");
    let (code, err, stdout) = run(&[&origin, "--parent-window=0"], &[ID]);
    assert_eq!(code, 1);
    assert!(err.contains("not started by an installed browser"), "{err}");
    assert!(stdout.is_empty(), "not one byte of protocol");
}

#[test]
fn firefox_id_from_a_program_that_is_not_a_browser_is_refused() {
    let (code, err, stdout) = run(&[r"C:\x\manifest.json", promptly_native::nmhost::FIREFOX_ID], &[]);
    assert_eq!(code, 1);
    assert!(err.contains("not started by an installed browser"), "{err}");
    assert!(stdout.is_empty());
}
