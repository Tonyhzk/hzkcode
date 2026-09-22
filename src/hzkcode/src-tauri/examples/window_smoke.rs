//! Smoke: build an extra app window (chat / editor) with the real
//! `windows::build_window` path against the dev server — exercises the
//! `?ctx=…` URL, window construction, and the frontend's window-role
//! resolution end to end without the running app. Registers the minimal
//! command set the chat surface needs so the target session actually loads.
//!
//!   cargo run --example window_smoke -- chat <engine> <sessionId> <workspacePath>
//!   cargo run --example window_smoke -- editor <filePath>
//!   cargo run --example window_smoke -- raw <relative page, e.g. index.html>

use std::sync::Arc;
use tauri::Manager;

use hzkcode_lib::event_sink::{self, BroadcastEmit};
use hzkcode_lib::{db, engine, terminal, web, windows, AppState};

fn main() {
    paths_guard();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let kind = args.first().cloned().unwrap_or_else(|| "chat".into());
    let kind_for_setup = kind.clone();
    let args_for_setup = args.clone();
    tauri::Builder::default()
        .setup(move |app| {
            let database = Arc::new(db::Db::open().expect("app db"));
            let emitters = BroadcastEmit::new(Arc::new(app.handle().clone()));
            let state = AppState {
                db: Arc::clone(&database),
                sink: event_sink::EventSink::new(emitters.clone()),
                terminal_sink: event_sink::EventSink::with_name(
                    emitters.clone(),
                    terminal::TERMINAL_OUTPUT_EVENT,
                ),
                emitters,
                terminals: terminal::TerminalRegistry::default(),
                processes: Arc::new(engine::ProcessRegistry::default()),
                web: web::WebAccessState::default(),
                relay: hzkcode_lib::relay::RelayState::default(),
            };
            app.manage(Arc::clone(&database));
            app.manage(state);
            app.manage(hzkcode_lib::config::ConfigStore::default());
            // 与正式启动一致：媒体服务器（编辑器图片/视频预览的 http 源）。
            let media_state = hzkcode_lib::media_server::start(Arc::clone(&database))
                .unwrap_or_else(|error| {
                    eprintln!("[window_smoke] media server: {error}");
                    hzkcode_lib::media_server::MediaServerState::default()
                });
            if let Some(base) = media_state.base.as_deref() {
                println!("[window_smoke] media base: {base}");
            }
            app.manage(media_state);

            let url = if kind_for_setup == "editor" {
                let file = args_for_setup
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "/tmp/window_smoke.txt".into());
                windows::window_url(&[("ctx", "editor"), ("filePath", &file)])
            } else if kind_for_setup == "raw" {
                // Any page the dev server serves (media probes, fixtures).
                args_for_setup
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "index.html".into())
            } else {
                let engine = args_for_setup
                    .get(1)
                    .cloned()
                    .unwrap_or_else(|| "claude".into());
                let session = args_for_setup.get(2).cloned().unwrap_or_default();
                let workspace = args_for_setup
                    .get(3)
                    .cloned()
                    .unwrap_or_else(|| "/tmp".into());
                windows::window_url(&[
                    ("ctx", "chat"),
                    ("engine", &engine),
                    ("sessionId", &session),
                    ("workspacePath", &workspace),
                ])
            };
            println!("[window_smoke] opening {url}");
            // Label matches the `chat-*` capability grant so the window gets
            // the same permissions a real extra window has.
            windows::build_window(
                app.handle(),
                "chat-smoke",
                url,
                "HZK CODE",
                1100.0,
                800.0,
                None,
            )
            .map_err(|error| error.to_string())?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            hzkcode_lib::history::reader::list_sessions,
            hzkcode_lib::history::reader::list_workspaces,
            hzkcode_lib::history::reader::load_session_page,
            hzkcode_lib::engine::list_engines,
            hzkcode_lib::settings::get_app_settings,
            hzkcode_lib::config::get_cli_config,
            hzkcode_lib::files::list_dir,
            hzkcode_lib::files::read_file,
        ])
        .run(tauri::generate_context!())
        .expect("window smoke failed");
}

/// The app's startup path owns directory creation; mirror just enough of it
/// for the db to open.
fn paths_guard() {
    hzkcode_lib::paths::ensure_dirs().expect("app dirs");
}
