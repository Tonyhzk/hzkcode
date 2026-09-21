//! Drag ghost window: a frameless, transparent, always-on-top, click-through
//! window that follows the cursor while an editor tab is dragged. DOM content
//! cannot paint past its window's edge, so this native window is what keeps
//! the drag feedback visible once the pointer leaves the main window — and it
//! lets the drag itself carry a transparent system image (hiding the
//! platform's "fly back on cancel" animation) without losing the feedback.

use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Manager, PhysicalPosition, WebviewUrl, WebviewWindowBuilder};

use crate::windows::encode;

const GHOST_LABEL: &str = "drag-ghost";
/// ~120Hz cursor polling keeps the window glued to the pointer.
const FOLLOW_INTERVAL: Duration = Duration::from_millis(8);

/// Stop flag of the running follow loop; a new show replaces it.
#[derive(Default)]
pub struct DragGhostState(pub Mutex<Option<Arc<AtomicBool>>>);

fn stop_following(state: &DragGhostState) {
    if let Ok(mut guard) = state.0.lock() {
        if let Some(stop) = guard.take() {
            stop.store(true, Ordering::Relaxed);
        }
    }
}

/// Show the ghost window under the cursor and start following it. `width` /
/// `height` are the card's logical size; `offset_*` is the grab point inside
/// it, so the card keeps the pointer grip the tab had.
#[tauri::command]
pub async fn show_drag_ghost(
    app: AppHandle,
    state: tauri::State<'_, DragGhostState>,
    label: String,
    width: f64,
    height: f64,
    offset_x: f64,
    offset_y: f64,
) -> Result<(), String> {
    stop_following(&state);
    // Rebuild each time: the card text rides the URL, and a stale window
    // would keep the previous tab's label.
    if let Some(existing) = app.get_webview_window(GHOST_LABEL) {
        let _ = existing.destroy();
    }
    let url = format!("index.html?ctx=drag-ghost&label={}", encode(&label));
    let window = WebviewWindowBuilder::new(&app, GHOST_LABEL, WebviewUrl::App(url.into()))
        .inner_size(width, height)
        .decorations(false)
        .transparent(true)
        .always_on_top(true)
        .skip_taskbar(true)
        .focused(false)
        .shadow(false)
        .resizable(false)
        .build()
        .map_err(|error| error.to_string())?;
    // Click-through: the ghost must never intercept the drag it visualizes.
    let _ = window.set_ignore_cursor_events(true);

    let stop = Arc::new(AtomicBool::new(false));
    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(stop.clone());
    }
    // Cursor coordinates are physical; the grab offset is logical.
    let scale = window.scale_factor().unwrap_or(1.0);
    let offset_x = offset_x * scale;
    let offset_y = offset_y * scale;
    let follow_app = app.clone();
    std::thread::spawn(move || {
        while !stop.load(Ordering::Relaxed) {
            if let Ok(cursor) = follow_app.cursor_position() {
                if let Some(win) = follow_app.get_webview_window(GHOST_LABEL) {
                    let _ = win.set_position(PhysicalPosition::new(
                        cursor.x - offset_x,
                        cursor.y - offset_y,
                    ));
                }
            }
            std::thread::sleep(FOLLOW_INTERVAL);
        }
    });
    Ok(())
}

/// Hide the ghost window and stop following.
#[tauri::command]
pub async fn hide_drag_ghost(
    app: AppHandle,
    state: tauri::State<'_, DragGhostState>,
) -> Result<(), String> {
    stop_following(&state);
    if let Some(window) = app.get_webview_window(GHOST_LABEL) {
        let _ = window.destroy();
    }
    Ok(())
}
