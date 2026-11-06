//! The browser's native messaging host. Console subsystem on purpose: Chrome runs hosts through
//! `cmd.exe /c` and treats a host that detaches from it as gone. Browsers start it hidden.
fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = promptly_native::nmhost::host_main(&args, &promptly_native::settings::data_dir());
    std::process::exit(code);
}
