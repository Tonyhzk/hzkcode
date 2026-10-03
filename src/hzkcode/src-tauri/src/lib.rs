pub mod agents;
pub mod agent_catalog;
pub mod baidu_tongji;
pub mod cli_lifecycle;
pub mod config;
pub mod db;
pub mod drag_ghost;
pub mod engine;
pub mod event_sink;
pub mod files;
pub mod git;
pub mod history;
pub mod media_server;
pub mod metrics;
pub mod open_app;
pub mod paths;
pub mod plugins;
pub mod plugin_caps;
pub mod prompts;
pub mod proxy;
pub mod provider_files;
pub mod provider_models;
pub mod settings;
pub mod usage;
pub mod slash_commands;
pub mod terminal;
#[cfg(test)]
mod test_support;
pub mod relay;
pub mod web;
pub mod windows;

use std::sync::Arc;
use tauri::{Emitter, Manager};

pub struct AppState {
    pub db: Arc<db::Db>,
    pub sink: Arc<event_sink::EventSink>,
    pub terminal_sink: Arc<event_sink::EventSink>,
    /// Webview + any attached web-access broadcasters (web.rs).
    pub emitters: Arc<event_sink::BroadcastEmit>,
    pub terminals: terminal::TerminalRegistry,
    pub processes: Arc<engine::ProcessRegistry>,
    pub web: web::WebAccessState,
    pub relay: relay::RelayState,
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    paths::ensure_dirs().expect("failed to create app home");
    engine::images::sweep_pasted_images();
    config::import_legacy_config_once();
    // A .app launched from Finder/Launchpad gets the launchd PATH
    // (/usr/bin:/bin:…), so `which::which` can't see CLIs installed via
    // homebrew/npm/nvm and every engine greys out. Adopt the login shell's
    // PATH before any detection/spawn runs.
    adopt_login_shell_path();
    // Apply the persisted network proxy to this process's env before any
    // engine/terminal spawn, so children inherit HTTP(S)_PROXY/ALL_PROXY.
    if let Ok(settings) = settings::read_settings() {
        if let Err(error) = proxy::apply_app_proxy_settings(&settings) {
            eprintln!("[proxy] failed to apply persisted proxy settings: {error}");
        }
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .setup(|app| {
            let db = Arc::new(db::Db::open().expect("failed to open app db"));
            // Sweep per-send credential staging left behind by a crash.
            engine::sweep_staging_dirs();
            if let Err(error) = db::import_legacy_workspaces_once(&db) {
                // Import failure must never block startup; the sidebar simply
                // starts empty and the user adds workspaces by hand.
                eprintln!("[db] legacy workspace import failed: {error}");
            }

            if let Err(error) = settings::import_legacy_groups_once(&db) {
                // Same non-fatal rule: groups stay unassigned and the user can
                // redo them in Settings → 工作区.
                eprintln!("[settings] legacy group import failed: {error}");
            }

            if let Err(error) = agents::import_legacy_agents_once(&db) {
                // Same non-fatal rule: the `#` picker simply starts empty.
                eprintln!("[agents] legacy agent import failed: {error}");
            }
            if let Err(error) = prompts::import_legacy_prompts_once(&db) {
                // Same non-fatal rule: the `!` picker simply starts empty.
                eprintln!("[prompts] legacy prompt import failed: {error}");
            }
            // files.rs commands inject State<'_, Arc<db::Db>> for workspace
            // confinement, so the Arc itself must be managed alongside.
            app.manage(Arc::clone(&db));
            // 媒体预览（编辑器图片/视频、markdown 图片）走本机回环 HTTP 服务：
            // macOS WKWebView 的媒体层不接受自定义 scheme（asset:// 的 <video>
            // 直接 SRC_NOT_SUPPORTED），http 才有可靠的视频播放。失败只降级
            // 媒体显示，不阻塞启动。必须在创建窗口前 manage——窗口的初始化
            // 脚本要写出 URL 基座。
            let media_state = media_server::start(Arc::clone(&db)).unwrap_or_else(|error| {
                eprintln!("[media] server start failed: {error}");
                media_server::MediaServerState::default()
            });
            app.manage(media_state);
            let emitters = event_sink::BroadcastEmit::new(Arc::new(app.handle().clone()));
            let state = AppState {
                db,
                sink: event_sink::EventSink::new(emitters.clone()),
                terminal_sink: event_sink::EventSink::with_name(
                    emitters.clone(),
                    terminal::TERMINAL_OUTPUT_EVENT,
                ),
                emitters,
                terminals: terminal::TerminalRegistry::default(),
                processes: Arc::new(engine::ProcessRegistry::default()),
                web: web::WebAccessState::default(),
                relay: relay::RelayState::default(),
            };
            // Clone what the initial scan needs before state moves into manage.
            let scan_db = Arc::clone(&state.db);
            let scan_sink = Arc::clone(&state.sink);
            app.manage(state);
            // Provider commands inject State<'_, ConfigStore> directly (not
            // via AppState), so the store must be managed as its own type —
            // otherwise every provider mutation panics with "state() called
            // before manage()".
            app.manage(config::ConfigStore::default());
            app.manage(metrics::MetricsState::new());
            app.manage(baidu_tongji::BaiduTongjiState::load());
            app.manage(drag_ghost::DragGhostState::default());
            // Keep the pairing key from lingering: while the switch is on, a
            // fresh code is minted every ten minutes and broadcast.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let mut interval =
                        tokio::time::interval(std::time::Duration::from_secs(600));
                    loop {
                        interval.tick().await;
                        let _ = crate::settings::rotate_web_auth_key(&handle);
                    }
                });
            }
            // Initial history scan, non-blocking.
            history::scanner::spawn_scan(scan_db, scan_sink);
            // Relay autostart: the outbound tunnel is what keeps the machine
            // reachable with nobody at the desk, so it comes back on launch
            // when the switch was left on. Failures are logged, never fatal;
            // the running task retries the dial by itself from there.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let settings = settings::read_settings().unwrap_or_default();
                    let Some((url, key)) = relay::autostart_target(&settings) else {
                        return;
                    };
                    if let Err(error) = relay::web_relay_start(handle, url, key).await {
                        eprintln!("[relay] autostart failed: {error}");
                    }
                });
            }
            // Dev convenience: `HZKCODE_WEB_AUTOSTART=1 pnpm dev` starts the LAN
            // bridge at launch and prints the URL, so the web build can be
            // exercised without clicking the settings toggle.
            #[cfg(debug_assertions)]
            if std::env::var_os("HZKCODE_WEB_AUTOSTART").is_some() {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    match web::web_access_start(handle).await {
                        Ok(info) => println!("[web] dev autostart: {}", info.url),
                        Err(error) => eprintln!("[web] autostart failed: {error}"),
                    }
                });
            }
            // 窗口在 setup 末尾创建（tauri.conf.json 不再声明 windows），这样能按持久化
            // 设置决定装饰：Windows 可选仿 mac 自绘标题栏（decorations=false + shadow，
            // 保留 DWM 阴影与四边缩放），macOS 保持 Overlay + 系统原生红绿灯（与原配置
            // 一致）。放在 manage(state) 之后：窗口一开始加载前端就会 invoke 命令，
            // 状态必须已经就位。设置改动需重启应用。会话/编辑器窗口共用同一构建逻辑
            // （windows::build_window）。主窗口 label 固定为 "main"。
            windows::build_window(
                app.handle(),
                "main",
                "index.html".to_string(),
                "HZK CODE",
                1400.0,
                900.0,
                None,
            )
            .expect("failed to create main window");
            Ok(())
        })
        .on_window_event(|window, event| {
            // 独立编辑器窗口关闭：把文件还给来源窗口，标签回到编辑器区（拖出时
            // 它从那里移走了）。CloseRequested 时窗口仍在，URL 里的 filePath
            // 可读；Destroyed 时窗口已经没了。广播给所有窗口，各窗口按
            // localStorage 里的拖出记录认领（会话窗口拖出的要还给会话窗口）。
            if let tauri::WindowEvent::CloseRequested { .. } = event {
                if window.label().starts_with(windows::EDITOR_WINDOW_PREFIX) {
                    // 事件给的是 Window（不含 webview），URL 要从对应的
                    // WebviewWindow 取；CloseRequested 时窗口尚未销毁。
                    if let Some(webview) = window.app_handle().get_webview_window(window.label()) {
                        if let Ok(url) = webview.url() {
                            if let Some((_, file_path)) =
                                url.query_pairs().find(|(key, _)| key == "filePath")
                            {
                                let _ = window
                                    .app_handle()
                                    .emit("editor://window-closed", file_path.into_owned());
                            }
                        }
                    }
                }
            }
            if let tauri::WindowEvent::Destroyed = event {
                if let Some(state) = window.try_state::<AppState>() {
                    // Multi-window: only the last window's destruction ends the
                    // app — closing one of several windows (a conversation or
                    // editor window) must never kill engine runs or terminals
                    // the other windows still own. Counting the others works
                    // whether or not the dying window left the registry first.
                    let self_label = window.label();
                    let others = window
                        .app_handle()
                        .webview_windows()
                        .keys()
                        .filter(|label| label.as_str() != self_label)
                        .count();
                    if others == 0 {
                        state.processes.kill_all();
                        plugin_caps::kill_all_tracked_children();
                        tauri::async_runtime::block_on(terminal::kill_all(&state.terminals));
                    }
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            // 窗口
            settings::restart_app,
            windows::open_chat_window,
            windows::open_editor_window,
            // 拖拽浮层窗口（跟随光标的标签卡片）
            drag_ghost::show_drag_ghost,
            drag_ghost::hide_drag_ghost,
            // config
            config::get_cli_config,
            config::upsert_provider,
            config::delete_provider,
            config::set_current_provider,
            provider_files::provider_file_paths,
            provider_files::official_config_read,
            provider_files::official_config_write,
            config::reorder_providers,
            provider_models::fetch_provider_models,
            // settings
            settings::get_app_settings,
            settings::update_app_settings,
            settings::set_window_theme,
            // plugins
            plugins::plugin_list,
            plugins::plugin_install_from_path,
            plugins::plugin_uninstall,
            plugins::plugin_set_enabled,
            plugins::plugin_quarantine,
            plugins::plugin_read_file,
            plugins::plugin_storage_get,
            plugins::plugin_storage_set,
            plugins::plugin_storage_delete,
            // plugin marketplace (Phase 3, plan §6)
            plugins::market::plugin_fetch_index,
            plugins::market::plugin_install_from_marketplace,
            plugins::market::plugin_check_updates,
            // engine
            engine::send_message,
            engine::interrupt_session,
            engine::answer_question,
            engine::answer_permission,
            engine::list_engines,
            engine::models::list_engine_models,
            engine::images::save_pasted_image,
            engine::images::import_attachments,
            // history
            history::reader::list_sessions,
            usage::usage_record,
            usage::usage_summary,
            usage::usage_clear,
            history::reader::load_session_page,
            history::reader::load_remote_session_page,
            history::reader::delete_session,
            history::reader::delete_remote_session,
            history::reader::pin_session,
            history::reader::rename_session,
            history::reader::remember_session_model,
            history::reader::remember_session_effort,
            history::reader::remember_session_provider,
            history::reader::rescan_sessions,
            history::reader::list_workspaces,
            history::reader::add_workspace,
            history::reader::reorder_workspaces,
            history::reader::remove_workspace,
            history::reader::set_workspace_group,
            // files
            files::list_dir,
            files::read_file,
            files::write_file,
            files::create_dir,
            files::rename_item,
            files::trash_item,
            files::duplicate_item,
            files::paste_item,
            files::create_file,
            files::search_text,
            files::list_file_index,
            // composer `/` slash-command picker
            slash_commands::list_slash_commands,
            // agents & prompts (composer `#`/`!` pickers)
            agents::agent_list,
            agents::agent_add,
            agents::agent_update,
            agents::agent_delete,
            // built-in agent catalog (agency-agents pack)
            agent_catalog::list_built_in_agents,
            agent_catalog::set_built_in_agent_enabled,
            agent_catalog::set_built_in_agent_division_enabled,
            agent_catalog::get_built_in_agent_prompt,
            agent_catalog::resolve_enabled_built_in_agent,
            prompts::prompts_list,
            prompts::prompts_dirs,
            prompts::prompts_create,
            prompts::prompts_update,
            prompts::prompts_delete,
            prompts::prompts_move,
            // On-demand directory grants (desktop-only — see grant_root).
            files::grant_scope,
            files::grant_root,
            files::list_granted_roots,
            files::revoke_granted_root,
            // git
            git::git_status,
            git::git_repository_summaries,
            git::git_file_colors,
            git::git_diff,
            git::git_stage,
            git::git_unstage,
            git::git_commit,
            git::git_push,
            git::git_pull,
            git::git_branches,
            git::git_checkout,
            git::git_create_branch,
            // open-app
            open_app::open_workspace_in,
            open_app::open_custom_program,
            open_app::get_program_icon,
            open_app::reveal_in_file_manager,
            // terminal
            terminal::terminal_open,
            terminal::terminal_write,
            terminal::terminal_resize,
            terminal::terminal_close,
            // metrics
            metrics::app_metrics,
            // plugin capability egress (network:/exec: manifest grants)
            plugin_caps::plugin_http_request,
            plugin_caps::plugin_add_workspace,
            plugin_caps::plugin_exec_run,
            plugin_caps::plugin_exec_spawn,
            plugin_caps::plugin_exec_kill,
            // web access
            web::web_access_start,
            web::web_access_stop,
            web::web_access_status,
            // Device rows: the bridge already dispatched these for phones,
            // but the desktop page invokes them over IPC too — without this
            // registration its list silently stayed empty.
            web::web_devices,
            web::web_device_approve,
            web::web_device_rename,
            web::web_device_revoke,
            // Key rotation stays desktop-only: a phone rotating it would lock
            // every other device out.
            web::rotate_web_pair_key,
            web::remote_control_active,
            relay::web_relay_start,
            relay::web_relay_stop,
            relay::web_relay_status,
            relay::relay_deploy_pack,
            relay::relay_deploy,
            // managed-CLI lifecycle
            cli_lifecycle::cli_version_status,
            cli_lifecycle::cli_update_plan,
            cli_lifecycle::cli_update,
            // baidu tongji (Linux-native transport; rejected elsewhere)
            baidu_tongji::load_baidu_tongji_script,
            baidu_tongji::send_baidu_tongji_beacon,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
/// Probe the user's login+interactive shell for its PATH and install it into
/// this process. `-l` sources .zprofile (homebrew), `-i` sources .zshrc
/// (nvm/volta/npm-global). No-op on failure: detection simply falls back to
/// the inherited PATH.
///
/// Interactive rc files can block on network fetches or keychain prompts, so
/// the probe is capped at 3s — a hung login shell must never stall startup.
#[cfg(unix)]
fn adopt_login_shell_path() {
    const MARKER: &str = "__OMP_GUI_PATH__";
    const TIMEOUT: std::time::Duration = std::time::Duration::from_secs(3);
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let script = format!("echo '{MARKER}'\"$PATH\"");
    let Ok(mut child) = std::process::Command::new(&shell)
        .args(["-l", "-i", "-c", &script])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::null())
        .spawn()
    else {
        return;
    };
    let Some(mut stdout) = child.stdout.take() else {
        let _ = child.kill();
        return;
    };
    // read_to_string ends at pipe EOF, i.e. exactly when the shell exits
    // (rc files backgrounding nothing sane). A helper thread keeps the read
    // off this startup path so the timeout below stays in charge.
    let (tx, rx) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        use std::io::Read;
        let mut out = String::new();
        let _ = stdout.read_to_string(&mut out);
        let _ = tx.send(out);
    });
    let Ok(stdout) = rx.recv_timeout(TIMEOUT) else {
        let _ = child.kill();
        let _ = child.wait();
        return;
    };
    if !child.wait().map(|s| s.success()).unwrap_or(false) {
        return;
    }
    // Shell rc files may print noise; only the marked line is authoritative.
    for line in stdout.lines().rev() {
        if let Some(path) = line.trim().strip_prefix(MARKER) {
            if !path.is_empty() {
                std::env::set_var("PATH", path);
            }
            return;
        }
    }
}

#[cfg(not(unix))]
fn adopt_login_shell_path() {}
