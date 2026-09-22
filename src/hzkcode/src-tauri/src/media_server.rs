//! Loopback HTTP media server (`127.0.0.1:<random port>`).
//!
//! Editor media (images, videos) and markdown-preview images stream over
//! plain HTTP instead of the asset protocol: a macOS WKWebView media stack
//! refuses custom URL schemes — `<video src="asset://…">` fails with
//! MEDIA_ERR_SRC_NOT_SUPPORTED while images load fine (measured with a probe
//! page) — so playback needs a real http origin.
//!
//! Scope: `files::ensure_allowed` — exactly the trees the file commands may
//! read, so the server is never a wider filesystem primitive than `read_file`.
//! The base URL is injected into every window as `window.__hzkcodeMediaBase`
//! (windows.rs); the web-access bridge keeps its own /file route for browsers
//! (web.rs).

use axum::extract::{Query, State as AxumState};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::Router;
use serde::Deserialize;
use std::path::Path;
use std::sync::Arc;
use tokio::net::TcpListener;
use uuid::Uuid;

/// The loopback base every window's media URLs hang off (`…/media?token=…`).
/// `base` is `None` only when the server failed to start — windows then fall
/// back to the asset protocol, which still covers images.
#[derive(Default)]
pub struct MediaServerState {
    pub base: Option<String>,
}

/// Bind the loopback listener and start serving it on the async runtime.
/// Binding is synchronous on purpose: windows are built right after and need
/// the port in their initialization script.
pub fn start(db: Arc<crate::db::Db>) -> Result<MediaServerState, String> {
    let listener = std::net::TcpListener::bind(("127.0.0.1", 0)).map_err(|e| e.to_string())?;
    listener.set_nonblocking(true).map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    // The token is defense in depth only (loopback is same-user reachable);
    // it keeps stray browser cross-origin probes from reading files.
    let token = Uuid::new_v4().to_string();
    let base = format!("http://127.0.0.1:{port}/media?token={token}");
    let router = Router::new()
        .route("/media", get(media_handler))
        .with_state(MediaCtx { db, token });
    tauri::async_runtime::spawn(async move {
        match TcpListener::from_std(listener) {
            Ok(listener) => {
                if let Err(error) = axum::serve(listener, router).await {
                    eprintln!("[media] server stopped: {error}");
                }
            }
            Err(error) => eprintln!("[media] listener init failed: {error}"),
        }
    });
    Ok(MediaServerState { base: Some(base) })
}

#[derive(Clone)]
struct MediaCtx {
    db: Arc<crate::db::Db>,
    token: String,
}

#[derive(Deserialize)]
struct MediaQuery {
    path: String,
    token: Option<String>,
}

async fn media_handler(
    AxumState(ctx): AxumState<MediaCtx>,
    headers: HeaderMap,
    Query(q): Query<MediaQuery>,
) -> Response {
    if q.token.as_deref() != Some(ctx.token.as_str()) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let Ok(file) = crate::files::ensure_allowed(&q.path, &ctx.db) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    // Scope admits the path; only regular files carry media (same guard as
    // the web bridge's /file route).
    if !file.is_file() {
        return StatusCode::NOT_FOUND.into_response();
    }
    let range = headers
        .get(header::RANGE)
        .and_then(|value| value.to_str().ok())
        .map(str::to_string);
    serve_file(&file, range.as_deref()).await
}

/// The wire format of one served file — whole-file 200 (streamed, so images
/// of any size never sit in memory), or 206 with `Content-Range` (and
/// `Accept-Ranges` on both paths) when the request carries a satisfiable
/// single range, which is what lets media players seek. Shared with the web
/// bridge's /file route (web.rs).
pub(crate) async fn serve_file(file: &Path, range: Option<&str>) -> Response {
    /// One partial response is capped: enough for a player's read-ahead,
    /// small enough to bound a single allocation. The player requests the
    /// next slice itself. Mirrors the asset protocol's 1MB slicing.
    const MAX_RANGE_BYTES: u64 = 1024 * 1024;
    /// Streaming chunk size for whole-file responses.
    const STREAM_CHUNK_BYTES: usize = 256 * 1024;

    let Ok(len) = std::fs::metadata(file).map(|meta| meta.len()) else {
        return StatusCode::NOT_FOUND.into_response();
    };
    let mime = content_type(&file.to_string_lossy());

    if let Some(spec) = range {
        let Some((start, end)) = parse_range(spec, len) else {
            return (
                StatusCode::RANGE_NOT_SATISFIABLE,
                [(header::CONTENT_RANGE, format!("bytes */{len}"))],
                Vec::new(),
            )
                .into_response();
        };
        let end = end.min(start + MAX_RANGE_BYTES - 1);
        let Ok(bytes) = read_file_range(file, start, end) else {
            return StatusCode::INTERNAL_SERVER_ERROR.into_response();
        };
        return (
            StatusCode::PARTIAL_CONTENT,
            [
                (header::CONTENT_TYPE, mime.to_string()),
                (header::ACCEPT_RANGES, "bytes".to_string()),
                (header::CONTENT_RANGE, format!("bytes {start}-{end}/{len}")),
            ],
            bytes,
        )
            .into_response();
    }

    let Ok(handle) = tokio::fs::File::open(file).await else {
        return StatusCode::INTERNAL_SERVER_ERROR.into_response();
    };
    let stream = futures_util::stream::unfold(handle, |mut handle| async move {
        use tokio::io::AsyncReadExt;
        let mut chunk = vec![0u8; STREAM_CHUNK_BYTES];
        match handle.read(&mut chunk).await {
            Ok(0) => None,
            Ok(read) => {
                chunk.truncate(read);
                Some((Ok::<_, std::io::Error>(chunk), handle))
            }
            Err(error) => Some((Err(error), handle)),
        }
    });
    (
        [
            (header::CONTENT_TYPE, mime.to_string()),
            (header::ACCEPT_RANGES, "bytes".to_string()),
            (header::CONTENT_LENGTH, len.to_string()),
        ],
        axum::body::Body::from_stream(stream),
    )
        .into_response()
}

fn read_file_range(path: &Path, start: u64, end: u64) -> std::io::Result<Vec<u8>> {
    use std::io::{Read, Seek, SeekFrom};
    let mut file = std::fs::File::open(path)?;
    file.seek(SeekFrom::Start(start))?;
    let mut buf = vec![0u8; (end - start + 1) as usize];
    file.read_exact(&mut buf)?;
    Ok(buf)
}

/// Parse one `bytes=` range spec — `start-end`, `start-` or `-suffix` —
/// against a file of `len` bytes; `None` marks it unsatisfiable. Multi-ranges
/// are not supported: media players seek with single ranges.
fn parse_range(spec: &str, len: u64) -> Option<(u64, u64)> {
    let spec = spec.trim().strip_prefix("bytes=")?.trim();
    if len == 0 || spec.contains(',') {
        return None;
    }
    let (start_s, end_s) = spec.split_once('-')?;
    let (start, end) = if start_s.is_empty() {
        let suffix: u64 = end_s.parse().ok()?;
        if suffix == 0 {
            return None;
        }
        (len.saturating_sub(suffix), len - 1)
    } else {
        let start: u64 = start_s.parse().ok()?;
        let end = if end_s.is_empty() {
            len - 1
        } else {
            end_s.parse::<u64>().ok()?.min(len - 1)
        };
        (start, end)
    };
    if start >= len || start > end {
        return None;
    }
    Some((start, end))
}

/// Extension → MIME for everything the media server and the web bridge's
/// /file route hand out (mirrors web.rs's static table plus ranges).
pub(crate) fn content_type(path: &str) -> &'static str {
    let ext = path.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" | "mjs" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "map" => "application/json",
        "png" => "image/png",
        "jpg" | "jpeg" | "jfif" => "image/jpeg",
        "gif" => "image/gif",
        "svg" => "image/svg+xml",
        "webp" => "image/webp",
        "avif" => "image/avif",
        "heic" => "image/heic",
        "heif" => "image/heif",
        "tif" | "tiff" => "image/tiff",
        "bmp" => "image/bmp",
        "ico" => "image/x-icon",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "webm" => "video/webm",
        "mkv" => "video/x-matroska",
        "avi" => "video/x-msvideo",
        "ogv" => "video/ogg",
        "m2ts" | "mts" => "video/mp2t",
        "wmv" => "video/x-ms-wmv",
        "flv" => "video/x-flv",
        "mpg" | "mpeg" => "video/mpeg",
        "mxf" => "application/mxf",
        "woff" => "font/woff",
        "woff2" => "font/woff2",
        "ttf" => "font/ttf",
        "pdf" => "application/pdf",
        "txt" | "md" => "text/plain; charset=utf-8",
        "wasm" => "application/wasm",
        _ => "application/octet-stream",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_range_reads_single_range_specs() {
        assert_eq!(parse_range("bytes=0-499", 1000), Some((0, 499)));
        // Open-ended: through the last byte.
        assert_eq!(parse_range("bytes=500-", 1000), Some((500, 999)));
        // Suffix: the last N bytes.
        assert_eq!(parse_range("bytes=-200", 1000), Some((800, 999)));
        // An end past the file clamps to it.
        assert_eq!(parse_range("bytes=900-99999", 1000), Some((900, 999)));
        // Unsatisfiable or unsupported forms.
        assert_eq!(parse_range("bytes=1000-", 1000), None);
        assert_eq!(parse_range("bytes=0-", 0), None);
        assert_eq!(parse_range("bytes=0-1,5-6", 1000), None);
        assert_eq!(parse_range("items=0-1", 1000), None);
    }

    #[tokio::test]
    async fn serve_file_answers_ranges_for_media_seeking() {
        let dir = std::env::temp_dir().join(format!("hzkcode-media-test-{}", Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("clip.mp4");
        let body: Vec<u8> = (0..100u8).collect();
        std::fs::write(&file, &body).unwrap();

        // A middle slice: 206 with the exact byte range and video MIME.
        let response = serve_file(&file, Some("bytes=10-19")).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 10-19/100");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        let bytes = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..], &body[10..20]);

        // Open-ended range through EOF.
        let response = serve_file(&file, Some("bytes=95-")).await;
        assert_eq!(response.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes 95-99/100");

        // A range past the file is unsatisfiable.
        let response = serve_file(&file, Some("bytes=200-")).await;
        assert_eq!(response.status(), StatusCode::RANGE_NOT_SATISFIABLE);
        assert_eq!(response.headers()[header::CONTENT_RANGE], "bytes */100");

        // No Range header: the whole file streamed, still advertising range
        // support (images of any size arrive this way).
        let response = serve_file(&file, None).await;
        assert_eq!(response.status(), StatusCode::OK);
        assert_eq!(response.headers()[header::CONTENT_TYPE], "video/mp4");
        assert_eq!(response.headers()[header::ACCEPT_RANGES], "bytes");
        assert_eq!(response.headers()[header::CONTENT_LENGTH], "100");
        let bytes = axum::body::to_bytes(response.into_body(), 1024).await.unwrap();
        assert_eq!(&bytes[..], &body[..]);

        let _ = std::fs::remove_dir_all(&dir);
    }
}
