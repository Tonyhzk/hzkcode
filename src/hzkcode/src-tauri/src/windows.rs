//! Extra app windows: a conversation window (`?ctx=chat…`) and a standalone
//! file-editor window (`?ctx=editor…`). The frontend bundle is the same in
//! every window; the query parameters tell it which role to render.

use std::sync::atomic::{AtomicU64, Ordering};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

pub const CHAT_WINDOW_PREFIX: &str = "chat-";
pub const EDITOR_WINDOW_PREFIX: &str = "editor-";

static NEXT_WINDOW_ID: AtomicU64 = AtomicU64::new(1);

fn next_window_id() -> u64 {
    NEXT_WINDOW_ID.fetch_add(1, Ordering::SeqCst)
}

/// Percent-encode a query value, keeping the RFC 3986 unreserved set.
pub(crate) fn encode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// Bundle-relative URL carrying the window's role parameters.
pub fn window_url(params: &[(&str, &str)]) -> String {
    let mut url = String::from("index.html");
    for (index, (key, value)) in params.iter().enumerate() {
        url.push(if index == 0 { '?' } else { '&' });
        url.push_str(key);
        url.push('=');
        url.push_str(&encode(value));
    }
    url
}

/// Focus an already-open window carrying the same marker parameter instead of
/// stacking duplicates (one window per conversation / file).
fn focus_existing(app: &AppHandle, prefix: &str, key: &str, value: &str) -> bool {
    for (label, window) in app.webview_windows() {
        if !label.starts_with(prefix) {
            continue;
        }
        let Ok(url) = window.url() else { continue };
        if url.query_pairs().any(|(k, v)| k == key && v == value) {
            let _ = window.unminimize();
            let _ = window.set_focus();
            return true;
        }
    }
    false
}

/// Clamp a logical drop point so a `width × height` window whose top-left is
/// placed there stays inside the monitor the point falls on.
fn clamp_to_monitor(app: &AppHandle, x: f64, y: f64, width: f64, height: f64) -> (f64, f64) {
    let monitors = app.available_monitors().unwrap_or_default();
    let hit = monitors.iter().find(|monitor| {
        let scale = monitor.scale_factor();
        let origin = monitor.position().to_logical::<f64>(scale);
        let size = monitor.size().to_logical::<f64>(scale);
        x >= origin.x && x < origin.x + size.width && y >= origin.y && y < origin.y + size.height
    });
    let Some(monitor) = hit else { return (x, y) };
    let scale = monitor.scale_factor();
    let origin = monitor.position().to_logical::<f64>(scale);
    let size = monitor.size().to_logical::<f64>(scale);
    let max_x = (origin.x + size.width - width).max(origin.x);
    let max_y = (origin.y + size.height - height).max(origin.y);
    (x.clamp(origin.x, max_x), y.clamp(origin.y, max_y))
}

/// Build an app window matching the main window's chrome: macOS keeps the
/// Overlay titlebar with hidden title, Windows optionally draws the mac-like
/// captionless frame (setting: 标题栏样式), every other platform is native.
pub fn build_window(
    app: &AppHandle,
    label: &str,
    url: String,
    title: &str,
    width: f64,
    height: f64,
    position: Option<(f64, f64)>,
) -> Result<WebviewWindow, String> {
    let mut builder = WebviewWindowBuilder::new(app, label, WebviewUrl::App(url.into()))
        .title(title)
        .inner_size(width, height)
        .min_inner_size(900.0, 600.0)
        // Tauri 默认接管 webview 的拖放（用于自己的文件拖入事件），会吞掉
        // 前端的 HTML5 拖拽事件（WKWebView 下 dragstart/dragover 都不派发）。
        // 编辑器标签用 HTML5 拖拽实现"系统拖拽图像跟随鼠标出窗口"，且应用
        // 不使用文件拖入，故关闭该接管。
        .disable_drag_drop_handler();
    // 拖出标签的窗口落在松手处（左上角对齐、钳制在所在显示器内），其余
    // 窗口交给系统默认位置。
    if let Some((x, y)) = position {
        let (x, y) = clamp_to_monitor(app, x, y, width, height);
        builder = builder.position(x, y);
    }
    #[cfg(target_os = "macos")]
    {
        builder = builder
            .title_bar_style(tauri::TitleBarStyle::Overlay)
            .hidden_title(true);
    }
    #[cfg(target_os = "windows")]
    {
        let settings = crate::settings::read_settings().unwrap_or_default();
        let mac_like = settings.titlebar == "mac";
        builder = builder.decorations(!mac_like);
        if mac_like {
            // 无装饰窗口默认没有 DWM 阴影；打开它保住阴影（四边缩放走原生路径）。
            builder = builder.shadow(true);
        }
    }
    builder.build().map_err(|error| error.to_string())
}

/// Open one conversation in its own window. An existing window for the same
/// session is focused instead.
#[tauri::command]
pub async fn open_chat_window(
    app: AppHandle,
    engine: String,
    session_id: String,
    workspace_path: String,
) -> Result<(), String> {
    if focus_existing(&app, CHAT_WINDOW_PREFIX, "sessionId", &session_id) {
        return Ok(());
    }
    let url = window_url(&[
        ("ctx", "chat"),
        ("engine", &engine),
        ("sessionId", &session_id),
        ("workspacePath", &workspace_path),
    ]);
    let label = format!("{CHAT_WINDOW_PREFIX}{}", next_window_id());
    build_window(&app, &label, url, "HZK CODE", 1180.0, 820.0, None)?;
    Ok(())
}

/// Open one file in a standalone editor window. An existing window for the
/// same file is focused instead. `position` is the logical screen point the
/// tab was dropped at; the new window opens with its top-left there (clamped
/// to the monitor the point falls on).
#[tauri::command]
pub async fn open_editor_window(
    app: AppHandle,
    file_path: String,
    position: Option<[f64; 2]>,
) -> Result<(), String> {
    if focus_existing(&app, EDITOR_WINDOW_PREFIX, "filePath", &file_path) {
        return Ok(());
    }
    let url = window_url(&[("ctx", "editor"), ("filePath", &file_path)]);
    let label = format!("{EDITOR_WINDOW_PREFIX}{}", next_window_id());
    let position = position.map(|[x, y]| (x, y));
    build_window(&app, &label, url, "HZK CODE", 960.0, 720.0, position)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn window_url_encodes_values_and_joins_params() {
        let url = window_url(&[
            ("ctx", "chat"),
            ("engine", "claude"),
            ("sessionId", "a b/c"),
            ("workspacePath", "/Users/me/我的 项目"),
        ]);
        assert_eq!(
            url,
            "index.html?ctx=chat&engine=claude&sessionId=a%20b%2Fc&workspacePath=%2FUsers%2Fme%2F%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE"
        );
    }

    #[test]
    fn window_url_keeps_unreserved_characters() {
        assert_eq!(
            window_url(&[("filePath", "/tmp/a-b_c.d~e")]),
            "index.html?filePath=%2Ftmp%2Fa-b_c.d~e"
        );
    }
}
