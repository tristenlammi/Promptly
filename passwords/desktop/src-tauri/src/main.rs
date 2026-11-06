// No console window in a release build.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod commands;
mod net;
mod ssh;
mod state;
mod updater;
mod windows_ui;

fn main() {
    let hidden = std::env::args().any(|a| a == "--hidden");
    let builder = tauri::Builder::default();
    // The test build can run beside a real install, and leaves the real shortcut alone.
    #[cfg(not(feature = "e2e"))]
    let builder = builder.plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
        windows_ui::show_main(app);
    }));
    builder
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .manage(state::App::load())
        .invoke_handler(tauri::generate_handler![
            commands::connection_get,
            commands::connection_begin,
            commands::connection_save,
            commands::connection_clear,
            net::net_fetch,
            commands::device_name,
            commands::open_external,
            commands::clipboard_copy,
            commands::clipboard_clear,
            commands::hello_status,
            commands::hello_enable,
            commands::hello_unlock,
            commands::hello_disable,
            commands::autostart_get,
            commands::autostart_set,
            commands::backup_status,
            commands::backup_configure,
            commands::backup_save,
            commands::backup_password_set,
            commands::backup_password_get,
            commands::native_host_status,
            commands::native_host_set,
            commands::updater_status,
            commands::main_show,
            commands::device_notice,
            commands::overlay_search,
            commands::overlay_act,
            commands::overlay_close,
            commands::overlay_open_main,
            commands::quick_results,
            commands::quick_feedback,
            commands::autotype_perform,
            ssh::ssh_status,
            ssh::ssh_set,
            ssh::ssh_identities_reply,
            ssh::ssh_sign_reply,
            #[cfg(feature = "e2e")]
            commands::e2e_open_overlay,
            #[cfg(feature = "e2e")]
            commands::e2e_clipboard,
            #[cfg(feature = "e2e")]
            commands::e2e_hello_answer,
            #[cfg(feature = "e2e")]
            commands::e2e_open_settings,
            #[cfg(feature = "e2e")]
            commands::e2e_hide_main,
            #[cfg(feature = "e2e")]
            commands::e2e_ssh_approve,
            #[cfg(feature = "e2e")]
            commands::e2e_emit,
            #[cfg(feature = "e2e")]
            commands::e2e_device_notice,
        ])
        .setup(move |app| {
            windows_ui::create_windows(app.handle(), hidden)?;
            windows_ui::create_tray(app.handle())?;
            windows_ui::register_shortcut(app.handle());
            windows_ui::watch_for_sleep(app.handle().clone());
            updater::setup(app.handle());
            ssh::start_if_enabled(app.handle().clone());
            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("the app failed to start");
}
