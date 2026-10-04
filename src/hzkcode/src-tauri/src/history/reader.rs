use super::{parse_session_file, Message, ParsedSession, SessionMeta};
use base64::Engine as _;
use serde::Serialize;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, LazyLock, Mutex};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionPage {
    pub messages: Vec<Message>,
    pub next_before: Option<i64>,
    /// Earlier delegation rows and turn boundaries, independent of paging.
    pub subagent_history: Vec<Message>,
}

/// Lock the db, run a parameterless query, and collect rows through `map_row`.
fn query_rows<T>(
    state: &crate::AppState,
    sql: &str,
    map_row: impl Fn(&rusqlite::Row<'_>) -> rusqlite::Result<T>,
) -> Result<Vec<T>, String> {
    let conn = state.db.0.lock();
    let mut stmt = conn.prepare(sql).map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], map_row).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    for row in rows {
        match row {
            Ok(value) => out.push(value),
            Err(e) => eprintln!("[history] skipping undecodable row: {e}"),
        }
    }
    Ok(out)
}

/// Run a sessions-table mutation, then notify listeners.
fn mutate_sessions(
    state: &crate::AppState,
    sql: &str,
    params: impl rusqlite::Params,
) -> Result<(), String> {
    let conn = state.db.0.lock();
    conn.execute(sql, params).map_err(|e| e.to_string())?;
    drop(conn);
    state.sink.emit_sessions_changed();
    Ok(())
}

#[tauri::command]
pub fn list_sessions(state: tauri::State<'_, crate::AppState>) -> Result<Vec<SessionMeta>, String> {
    query_rows(
        &state,
        "SELECT s.engine, s.session_id, s.workspace_path, s.file_path, s.file_size, s.file_mtime_ms,
                s.title, s.preview, s.created_at, s.updated_at, s.message_count, s.pinned, s.custom_title,
                m.model, e.effort, p.provider_id
         FROM sessions s
         LEFT JOIN session_models m ON m.engine = s.engine AND m.session_id = s.session_id
         LEFT JOIN session_efforts e ON e.engine = s.engine AND e.session_id = s.session_id
         LEFT JOIN session_providers p ON p.engine = s.engine AND p.session_id = s.session_id
         ORDER BY COALESCE(s.updated_at, 0) DESC",
        |r| {
            Ok(SessionMeta {
                engine: r.get(0)?,
                session_id: r.get(1)?,
                workspace_path: r.get(2)?,
                file_path: r.get(3)?,
                file_size: r.get(4)?,
                file_mtime_ms: r.get(5)?,
                title: r.get(6)?,
                preview: r.get(7)?,
                created_at: r.get(8)?,
                updated_at: r.get(9)?,
                message_count: r.get(10)?,
                pinned: r.get::<_, i64>(11)? != 0,
                custom_title: r.get(12)?,
                model: r.get(13)?,
                effort: r.get(14)?,
                provider: r.get(15)?,
            })
        },
    )
}

/// Remember the model id a session ran, spelled as the picker spells it
/// ("provider/model"). The engine's transcript only carries the bare model
/// name, so this row is what keeps a session's provider and model across
/// clients and restarts — see [`SessionMeta::model`].
#[tauri::command]
pub fn remember_session_model(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    model: String,
) -> Result<(), String> {
    if model.trim().is_empty() {
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    state
        .db
        .remember_session_model(&engine, &session_id, &model, now)?;
    state.sink.emit_sessions_changed();
    Ok(())
}

/// Remember the reasoning effort a session ran, beside its model and for the
/// same reason — see [`SessionMeta::effort`].
#[tauri::command]
pub fn remember_session_effort(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    effort: String,
) -> Result<(), String> {
    if effort.trim().is_empty() {
        return Ok(());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    state
        .db
        .remember_session_effort(&engine, &session_id, &effort, now)?;
    state.sink.emit_sessions_changed();
    Ok(())
}

/// Remember the in-app channel a session ran. Spawn injects env from this id
/// and never rewrites the CLI's own files — see [`SessionMeta::provider`].
#[tauri::command]
pub fn remember_session_provider(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    provider_id: String,
) -> Result<(), String> {
    if provider_id.trim().is_empty() {
        return Ok(());
    }
    // Same standard as run ids (send_message_inner): bounded length and a
    // channel-id charset (plugin-prefixed ids use alnum/-/_; dots tolerated
    // for hand-written configs). A hand-edited db must not smuggle odd keys
    // into downstream lookups.
    if engine.trim().is_empty() || engine.len() > 64 {
        return Err("invalid engine".into());
    }
    if session_id.trim().is_empty() || session_id.len() > 256 {
        return Err("invalid session id".into());
    }
    if provider_id.len() > 128
        || !provider_id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_' | b'.'))
    {
        return Err("invalid provider id".into());
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    state
        .db
        .remember_session_provider(&engine, &session_id, &provider_id, now)?;
    state.sink.emit_sessions_changed();
    Ok(())
}

fn session_file_path(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
) -> Result<PathBuf, String> {
    let conn = db.0.lock();
    conn.query_row(
        "SELECT file_path FROM sessions WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id],
        |r| r.get::<_, String>(0),
    )
    .map(PathBuf::from)
    .map_err(|_| format!("session not found: {engine}/{session_id}"))
}

/// One cache entry: the parse plus the subagent fold over all its messages,
/// so paging cuts the fold at the page start instead of refolding the whole
/// prefix on every turn of the page. The fold derives from `parsed.messages`
/// alone, so it invalidates with the same stat key.
struct CachedSession {
    parsed: ParsedSession,
    fold: SubagentFold,
}

/// Parsed sessions keyed by (path, size, mtime_ms): paging re-slices a cached
/// parse instead of re-reading the file. Bounded two ways: 32 entries and a
/// ~128MB byte budget (image data URLs make entries heavy).
static PARSED_CACHE: LazyLock<Mutex<HashMap<(PathBuf, i64, i64), Arc<CachedSession>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static PARSED_CACHE_BYTES: LazyLock<Mutex<usize>> = LazyLock::new(|| Mutex::new(0));

const PARSED_CACHE_CAPACITY: usize = 32;
const PARSED_CACHE_BUDGET_BYTES: usize = 128 * 1024 * 1024;

/// Rough in-memory footprint of one parsed session (text + image payloads).
fn parsed_footprint(parsed: &ParsedSession) -> usize {
    parsed
        .messages
        .iter()
        .map(|m| {
            m.text.len()
                + m.images.iter().map(|i| i.len()).sum::<usize>()
                + m.ts.as_deref().map(str::len).unwrap_or(0)
                + 128
        })
        .sum()
}

fn cached_session(engine: &str, path: &Path) -> Result<Arc<CachedSession>, String> {
    let Some((size, mtime_ms)) = super::stat_signature(path) else {
        // Unstattable file: let the parse produce the real error.
        let parsed = parse_session_file(engine, path)?;
        let fold = subagent_fold(&parsed.messages);
        return Ok(Arc::new(CachedSession { parsed, fold }));
    };
    let key = (path.to_path_buf(), size, mtime_ms);
    if let Some(hit) = PARSED_CACHE.lock().map_err(|e| e.to_string())?.get(&key) {
        return Ok(Arc::clone(hit));
    }
    let parsed = parse_session_file(engine, path)?;
    let fold = subagent_fold(&parsed.messages);
    // The fold's cloned delegation rows count toward the budget too.
    let footprint = parsed_footprint(&parsed)
        + fold.iter().map(|(_, row)| row.text.len() + 128).sum::<usize>();
    let cached = Arc::new(CachedSession { parsed, fold });
    let mut cache = PARSED_CACHE.lock().map_err(|e| e.to_string())?;
    let mut bytes = PARSED_CACHE_BYTES.lock().map_err(|e| e.to_string())?;
    // Over budget or capacity: drop everything rather than evicting entries
    // one by one (pages are re-parseable, and scans are cheap by stat key).
    if cache.len() >= PARSED_CACHE_CAPACITY || *bytes + footprint > PARSED_CACHE_BUDGET_BYTES {
        cache.clear();
        *bytes = 0;
    }
    *bytes += footprint;
    cache.insert(key, Arc::clone(&cached));
    Ok(cached)
}

/// The fold over a whole session, each row tagged with the index of the
/// message whose processing emitted it: a delegation or boundary row tags its
/// own index, a user row tags the index of the delegation or boundary that
/// closes its turn, and the trailing unclosed user tags `usize::MAX`. Paging
/// cuts this at the page start — see `subagent_history_until`.
type SubagentFold = Vec<(usize, Message)>;

/// Keep the inputs the subagent fold consumes, not old chat bodies or tool output.
/// Turn boundaries remain so a reopened session never treats an old spawn as new.
fn subagent_fold(messages: &[Message]) -> SubagentFold {
    let mut rows = SubagentFold::new();
    let mut last_user = None;
    let mut needs_boundary = false;
    for (index, message) in messages.iter().enumerate() {
        if message.role == "user" {
            last_user = Some(message);
            continue;
        }
        let delegation = message.role == "tool" && is_subagent_history_tool(message);
        let boundary = needs_boundary && matches!(message.role.as_str(), "assistant" | "thinking");
        if !delegation && !boundary {
            continue;
        }
        if let Some(user) = last_user.take() {
            rows.push((index, subagent_history_row(user, false)));
        }
        rows.push((index, subagent_history_row(message, delegation)));
        needs_boundary = delegation;
    }
    if !rows.is_empty() {
        if let Some(user) = last_user {
            rows.push((usize::MAX, subagent_history_row(user, false)));
        }
    }
    rows
}

/// The fold of one prefix, kept for tests as the reference the cached
/// truncation is pinned against.
#[cfg(test)]
fn subagent_history(messages: &[Message]) -> Vec<Message> {
    subagent_fold(messages).into_iter().map(|(_, row)| row).collect()
}

/// Cut a full-session fold at `start`, byte-identical to folding
/// `messages[..start]` directly. Rows triggered before the cut keep the order
/// the prefix fold emits them in; the pending user at the cut is appended
/// exactly when the prefix fold would — its turn was never closed inside the
/// prefix (even when the full fold spends it on a delegation past the cut, or
/// a newer user replaces it and it never appears there at all).
fn subagent_history_until(messages: &[Message], fold: &SubagentFold, start: usize) -> Vec<Message> {
    let mut rows: Vec<Message> = fold
        .iter()
        .take_while(|(trigger, _)| *trigger < start)
        .map(|(_, row)| row.clone())
        .collect();
    if rows.is_empty() {
        return rows;
    }
    let Some(user_index) = messages[..start].iter().rposition(|m| m.role == "user") else {
        return rows;
    };
    // The pending user was already spent if a delegation or boundary closed
    // its turn inside the prefix; as the last user before the cut, any row
    // triggered between it and the cut closed its turn.
    let closed = fold
        .iter()
        .any(|(trigger, _)| user_index < *trigger && *trigger < start);
    if !closed {
        rows.push(subagent_history_row(&messages[user_index], false));
    }
    rows
}

fn is_subagent_history_tool(message: &Message) -> bool {
    if message.args.as_ref().is_some_and(|args| args.get("tasks").is_some() || args.get("ids").is_some()) {
        return true;
    }
    if message.result.as_ref().and_then(|result| result.get("details")).is_some_and(|details| {
        ["jobs", "peers", "progress"].iter().any(|key| details.get(key).is_some())
            || details.get("op").and_then(serde_json::Value::as_str) == Some("jobs")
    }) {
        return true;
    }
    let head = message.text.split('·').next().unwrap_or_default().trim().to_ascii_lowercase();
    let first = head.split(|c: char| c.is_whitespace() || c == '/' || c == '\\').next().unwrap_or_default().replace('-', "_");
    matches!(first.as_str(), "task" | "agent" | "spawn" | "spawn_agent" | "spawn_subagent"
        | "workflow" | "run_workflow" | "pipeline" | "dispatch" | "dispatch_agent" | "delegate")
        || ["spawn agent", "agent swarm", "agent_swarm", "workflow", "subagent"].iter().any(|name| head.contains(name))
}

fn subagent_history_row(message: &Message, delegation: bool) -> Message {
    Message {
        seq: message.seq,
        role: message.role.clone(),
        text: if delegation { message.text.clone() } else { String::new() },
        ts: None,
        // Subagent rows are display-only folds of sidechain messages: they
        // do not address a main-conversation entry, so no branch uuid.
        uuid: None,
        path: None,
        args: if delegation { message.args.clone() } else { None },
        // Status snapshots and result presence matter; the full output still
        // lives in the paginated timeline and need not cross IPC twice.
        result: if delegation {
            message.result.as_ref().map(|result| match result.get("details") {
                Some(details) => serde_json::json!({ "details": details }),
                None => serde_json::Value::Bool(true),
            })
        } else { None },
        todos: None,
        usage: None,
        model: None,
        effort: None,
        duration_ms: None,
        images: Vec::new(),
        level: None,
    }
}

/// Slice a cached parse into a page (shared by local and remote loaders).
fn page_from_cached(
    cached: &CachedSession,
    limit: Option<usize>,
    before_seq: Option<i64>,
) -> SessionPage {
    let limit = limit.unwrap_or(100).clamp(1, 500);
    let messages = &cached.parsed.messages;
    let (page, next_before, start) = match before_seq {
        Some(before) => {
            let end = messages
                .iter()
                .position(|m| m.seq >= before)
                .unwrap_or(messages.len());
            let start = end.saturating_sub(limit);
            let next = if start > 0 {
                messages.get(start).map(|m| m.seq)
            } else {
                None
            };
            (messages[start..end].to_vec(), next, start)
        }
        None => {
            let start = messages.len().saturating_sub(limit);
            let next = if start > 0 {
                messages.get(start).map(|m| m.seq)
            } else {
                None
            };
            (messages[start..].to_vec(), next, start)
        }
    };
    SessionPage {
        messages: page,
        next_before,
        subagent_history: subagent_history_until(messages, &cached.fold, start),
    }
}

/// Sync body of `load_session_page` (parsing multi-MB session files must not
/// run on the IPC main thread).
fn load_session_page_blocking(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
    limit: Option<usize>,
    before_seq: Option<i64>,
) -> Result<SessionPage, String> {
    let path = session_file_path(db, engine, session_id)?;
    let cached = cached_session(engine, &path)?;
    Ok(page_from_cached(&cached, limit, before_seq))
}

#[tauri::command]
pub async fn load_session_page(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    limit: Option<usize>,
    before_seq: Option<i64>,
) -> Result<SessionPage, String> {
    let db = Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        load_session_page_blocking(&db, &engine, &session_id, limit, before_seq)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 远程会话路径形状白名单。本地等价物 session_file_path 只认 db 登记的
/// 引擎 home 内文件;远程会话没有 db 行(remotePath 由插件会话源上报),
/// 用「绝对 .jsonl + 落在该引擎已知会话目录形态」收口,挡住借 IPC 读
/// 发行版内任意 .jsonl 文件。
fn is_plausible_remote_session_path(engine: &str, path: &str) -> bool {
    if !path.ends_with(".jsonl") || !path.starts_with('/') {
        return false;
    }
    // 拒绝 `..` 段与 NUL:防止借拼路径逃出会话树。
    if path.contains('\0') || path.split('/').any(|seg| seg == "..") {
        return false;
    }
    let markers: &[&str] = match engine {
        // ~/.hzkcode/projects/<encoded>/<sid>.jsonl
        "claude" => &["/projects/"],
        // 未知引擎硬拒绝:白名单只对已适配的会话树形态成立。
        _ => &[],
    };
    markers.iter().any(|m| path.contains(m))
}

/// 远程转录本拉取上限(base64 前)。
const MAX_REMOTE_SESSION_BYTES: u64 = 64 * 1024 * 1024;

/// 远程工作区会话的历史回放:插件会话源把远端 jsonl 绝对路径随 `remotePath`
/// 上报;这里经引擎 spawn 同一套远程通道 `base64` 拉回转录本,落到本机缓存
/// 文件后复用既有解析/分页/子代理折叠。缓存文件仅在内容有变化时重写(stat
/// 签名不变 → 翻页命中解析缓存,不重析)。
#[tauri::command]
pub async fn load_remote_session_page(
    state: tauri::State<'_, crate::AppState>,
    workspace_path: String,
    engine: String,
    session_id: String,
    remote_path: String,
    limit: Option<usize>,
    before_seq: Option<i64>,
) -> Result<SessionPage, String> {
    use sha2::Digest as _;
    if !is_plausible_remote_session_path(&engine, &remote_path) {
        return Err(format!("远程会话路径不合法: {remote_path}"));
    }
    let transport = crate::engine::wsl_transport::transport_for_workspace(&state.db, &workspace_path)
        .ok_or_else(|| format!("工作区 {workspace_path} 未登记远程传输"))?;
    // 先远端 stat 卡住字节上限再 base64,超限/不可读直接非零退出,
    // 避免超大转录本经 1.33× 膨胀后全量进内存。
    let quoted = crate::engine::wsl_transport::sh_quote(&remote_path);
    let script = format!(
        "sz=$(stat -c %s -- {quoted} 2>/dev/null) || {{ echo '远程会话文件不可读' >&2; exit 3; }}; \
         [ \"$sz\" -le {MAX_REMOTE_SESSION_BYTES} ] || {{ echo \"远程会话文件过大(${{sz}}B,上限 {MAX_REMOTE_SESSION_BYTES}B)\" >&2; exit 4; }}; \
         base64 -w0 -- {quoted}"
    );
    // run_script_output 已剥传输层噪声;载荷是单行 base64。
    let raw = crate::engine::wsl_transport::run_script_output(&transport, &script).await?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(raw.trim())
        .map_err(|e| format!("远程转录本解码失败: {e}"))?;

    let dir = crate::paths::app_home().join("remote-sessions");
    std::fs::create_dir_all(&dir).map_err(|e| format!("创建缓存目录失败: {e}"))?;
    let digest = sha2::Sha256::digest(format!("{workspace_path}|{engine}|{session_id}|{remote_path}"));
    let name: String = digest[..16].iter().map(|b| format!("{b:02x}")).collect();
    let cache_path = dir.join(format!("{name}.jsonl"));
    let stale = std::fs::read(&cache_path).map(|old| old != bytes).unwrap_or(true);
    if stale {
        let tmp = dir.join(format!("{name}.jsonl.tmp"));
        std::fs::write(&tmp, &bytes).map_err(|e| format!("写缓存失败: {e}"))?;
        std::fs::rename(&tmp, &cache_path).map_err(|e| format!("缓存落位失败: {e}"))?;
    }

    let engine_for_parse = engine.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let cached = cached_session(&engine_for_parse, &cache_path)?;
        Ok(page_from_cached(&cached, limit, before_seq))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Remove the session's on-disk file. Returns Ok when the disk state is
/// gone (or wisely skipped), Err when the removal failed — callers keep the
/// db row on Err so a session cannot "delete then resurrect" on the next scan.
fn delete_session_disk(engine: &str, path: &Path) -> Result<(), String> {
    match engine {
        "claude" => match std::fs::remove_file(path) {
            Ok(()) => Ok(()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(e) => Err(format!("remove {}: {e}", path.display())),
        },
        // 未知引擎硬失败:宁可删除报错,也不能静默跳过磁盘删除让会话在下次
        // 扫描"复活"。
        _ => Err(format!("delete_session: unknown engine {engine}")),
    }
}

/// Session ids are uuids (the CLI's own) — refuse anything else before it is
/// echoed back into a filesystem lookup, so a hostile id cannot traverse out
/// of the projects root.
fn is_safe_session_id(session_id: &str) -> bool {
    !session_id.is_empty()
        && session_id
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

/// Locate `<session_id>.jsonl` across every project dir under the CLI's
/// projects root. The db row is the fast path, but not every session has one:
/// a session created moments ago may not be scanned yet, and one filed under
/// a wrong project dir (an inherited `HZKCODE_DEV_CALLER_CWD`, pinned at
/// spawn) is never scanned at all — deleting must still work.
fn session_files_by_id(engine: &str, session_id: &str) -> Vec<PathBuf> {
    if engine != "claude" || !is_safe_session_id(session_id) {
        return Vec::new();
    }
    let projects = crate::engine::engine_home(Some("HZKCODE_CONFIG_DIR"), ".hzkcode")
        .join("projects");
    let Ok(entries) = std::fs::read_dir(&projects) else {
        return Vec::new();
    };
    let file_name = format!("{session_id}.jsonl");
    entries
        .flatten()
        .map(|entry| entry.path().join(&file_name))
        .filter(|candidate| candidate.is_file())
        .collect()
}

/// Best-effort removal of the session's sidecar dir (`<project>/<session>/`
/// holds subagent transcripts). The `.jsonl` is already gone by the time this
/// runs, so a failure here must not fail the delete.
fn remove_session_dir(session_file: &Path) {
    let Some(stem) = session_file.file_stem() else {
        return;
    };
    let dir = session_file.with_file_name(stem);
    if dir.is_dir() {
        let _ = std::fs::remove_dir_all(&dir);
    }
}

/// Sync body of `delete_session` (disk + db work off the main thread).
///
/// Disk first, then the row: on a disk failure the row is kept so a session
/// cannot "delete then resurrect" on the next scan. The lookup must not
/// depend on the index: a row without a file and a file without a row both
/// delete cleanly, so a stale sidebar row can always go.
fn delete_session_blocking(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
) -> Result<(), String> {
    let mut paths: Vec<PathBuf> = Vec::new();
    if let Ok(recorded) = session_file_path(db, engine, session_id) {
        paths.push(recorded);
    }
    for stray in session_files_by_id(engine, session_id) {
        if !paths.contains(&stray) {
            paths.push(stray);
        }
    }
    for path in &paths {
        delete_session_disk(engine, path)?;
        remove_session_dir(path);
    }
    let conn = db.0.lock();
    conn.execute(
        "DELETE FROM sessions WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub async fn delete_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
) -> Result<(), String> {
    let db = Arc::clone(&state.db);
    let sink = Arc::clone(&state.sink);
    tauri::async_runtime::spawn_blocking(move || {
        delete_session_blocking(&db, &engine, &session_id)
    })
    .await
    .map_err(|e| e.to_string())??;
    sink.emit_sessions_changed();
    Ok(())
}

/// One forked session: the new id plus the inherited title when the source
/// carried a custom one.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchResult {
    pub session_id: String,
    pub title: Option<String>,
}

/// First user prompt of the forked prefix, collapsed to one line — the
/// sidebar fallback title until the next scan derives the full summary.
fn first_prompt_of(entries: &[&Value]) -> String {
    for entry in entries {
        if entry.get("type").and_then(Value::as_str) != Some("user") {
            continue;
        }
        let content = entry.get("message").and_then(|m| m.get("content"));
        let text = match content {
            Some(Value::String(s)) => s.clone(),
            Some(Value::Array(blocks)) => blocks
                .iter()
                .find_map(|b| {
                    (b.get("type").and_then(Value::as_str) == Some("text"))
                        .then(|| b.get("text").and_then(Value::as_str))
                        .flatten()
                })
                .unwrap_or_default()
                .to_string(),
            _ => String::new(),
        };
        let collapsed = text.split_whitespace().collect::<Vec<_>>().join(" ");
        if !collapsed.is_empty() {
            return collapsed.chars().take(100).collect();
        }
    }
    String::new()
}

/// `<base> (分支[ n])`, numbered past any title already in use — the CLI's
/// own naming for forks of a titled session.
fn unique_branch_title(db: &crate::db::Db, base: &str) -> String {
    let titles: Vec<String> = {
        let conn = db.0.lock();
        conn.prepare("SELECT custom_title FROM sessions WHERE custom_title IS NOT NULL")
            .and_then(|mut stmt| {
                stmt.query_map([], |r| r.get::<_, String>(0))
                    .map(|rows| rows.filter_map(Result::ok).collect())
            })
            .unwrap_or_default()
    };
    let plain = format!("{base} (分支)");
    if !titles.iter().any(|t| t == &plain) {
        return plain;
    }
    let mut n = 2u32;
    loop {
        let candidate = format!("{base} (分支 {n})");
        if !titles.iter().any(|t| t == &candidate) {
            return candidate;
        }
        n += 1;
    }
}

/// Fork the session at `target_uuid`, mirroring the CLI's /branch: main
/// conversation entries up to and including an assistant target (a user
/// target forks right before it), `sessionId` rewritten, the parent chain
/// rebuilt, `forkedFrom` traceability added, and the aggregated
/// content-replacement entry carried over.
fn branch_session_blocking(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
    workspace_path: &str,
    target_uuid: &str,
) -> Result<BranchResult, String> {
    if engine != "claude" {
        return Err(format!("branch_session: unknown engine {engine}"));
    }
    // The recorded path first; a session created moments ago may not be
    // indexed yet, so fall back to the id scan (same resolution as delete).
    let source = session_file_path(db, engine, session_id)
        .ok()
        .filter(|path| path.is_file())
        .or_else(|| session_files_by_id(engine, session_id).into_iter().next())
        .ok_or_else(|| "没有可创建分支的会话".to_string())?;
    let content =
        std::fs::read_to_string(&source).map_err(|e| format!("read {}: {e}", source.display()))?;
    let entries: Vec<Value> = content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line.trim()).ok())
        .collect();

    let is_transcript_message = |entry: &Value| {
        matches!(
            entry.get("type").and_then(Value::as_str),
            Some("user" | "assistant" | "attachment" | "system")
        )
    };
    let main: Vec<&Value> = entries
        .iter()
        .filter(|entry| {
            is_transcript_message(entry)
                && entry.get("isSidechain").and_then(Value::as_bool) != Some(true)
        })
        .collect();
    let target_index = main
        .iter()
        .position(|entry| entry.get("uuid").and_then(Value::as_str) == Some(target_uuid))
        .ok_or_else(|| "所选消息已不可用，无法从此处创建分支".to_string())?;
    // Assistant target: include that reply. Any other target (a user prompt):
    // fork right before it, so the branch ends on the previous reply.
    let branch_end = if main[target_index].get("type").and_then(Value::as_str) == Some("assistant")
    {
        target_index + 1
    } else {
        target_index
    };
    let kept = &main[..branch_end];
    if kept.is_empty() {
        return Err("没有可创建分支的消息".to_string());
    }

    let fork_id = uuid::Uuid::new_v4().to_string();
    let mut lines: Vec<String> = Vec::with_capacity(kept.len() + 2);
    let mut parent: Option<String> = None;
    for entry in kept {
        let mut forked = (*entry).clone();
        let obj = forked.as_object_mut().ok_or("会话条目格式异常")?;
        obj.insert("sessionId".into(), Value::String(fork_id.clone()));
        obj.insert(
            "parentUuid".into(),
            parent.clone().map(Value::String).unwrap_or(Value::Null),
        );
        obj.insert("isSidechain".into(), Value::Bool(false));
        let entry_uuid = entry
            .get("uuid")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        obj.insert(
            "forkedFrom".into(),
            serde_json::json!({ "sessionId": session_id, "messageUuid": entry_uuid }),
        );
        lines.push(serde_json::to_string(&forked).map_err(|e| e.to_string())?);
        parent = Some(entry_uuid);
    }

    let replacements: Vec<Value> = entries
        .iter()
        .filter(|entry| {
            entry.get("type").and_then(Value::as_str) == Some("content-replacement")
                && entry.get("sessionId").and_then(Value::as_str) == Some(session_id)
        })
        .filter_map(|entry| entry.get("replacements").and_then(Value::as_array))
        .flat_map(|list| list.iter().cloned())
        .collect();
    if !replacements.is_empty() {
        lines.push(
            serde_json::to_string(&serde_json::json!({
                "type": "content-replacement",
                "sessionId": fork_id,
                "replacements": replacements,
            }))
            .map_err(|e| e.to_string())?,
        );
    }

    // Inherit the source's custom title the way the CLI does; the entry
    // keeps the CLI's own /resume listing in sync with the sidebar.
    let source_title: Option<String> = db
        .0
        .lock()
        .query_row(
            "SELECT custom_title FROM sessions WHERE engine=?1 AND session_id=?2",
            rusqlite::params![engine, session_id],
            |r| r.get::<_, Option<String>>(0),
        )
        .unwrap_or(None)
        .filter(|t| !t.trim().is_empty());
    let title = source_title.map(|base| unique_branch_title(db, base.trim()));
    if let Some(title) = title.as_deref() {
        lines.push(
            serde_json::to_string(&serde_json::json!({
                "type": "custom-title",
                "customTitle": title,
                "sessionId": fork_id,
            }))
            .map_err(|e| e.to_string())?,
        );
    }

    let fork_path = source.with_file_name(format!("{fork_id}.jsonl"));
    let mut payload = lines.join("\n");
    payload.push('\n');
    crate::settings::atomic_write(&fork_path, &payload)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = std::fs::set_permissions(&fork_path, std::fs::Permissions::from_mode(0o600));
    }

    // Index the fork immediately so the sidebar shows it with its title; the
    // next scan updates the derived fields (its upsert never touches
    // custom_title).
    let now_ms = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let first_prompt = first_prompt_of(kept);
    db.0.lock()
        .execute(
            "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title, preview, created_at, updated_at, message_count, custom_title)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?6,?6,?9,?10)
             ON CONFLICT(engine, session_id) DO UPDATE SET
                workspace_path=excluded.workspace_path,
                file_path=excluded.file_path,
                file_size=excluded.file_size,
                file_mtime_ms=excluded.file_mtime_ms",
            rusqlite::params![
                engine,
                fork_id,
                workspace_path,
                fork_path.to_string_lossy(),
                payload.len() as i64,
                now_ms,
                first_prompt,
                "",
                kept.len() as i64,
                title,
            ],
        )
        .map_err(|e| e.to_string())?;

    Ok(BranchResult {
        session_id: fork_id,
        title,
    })
}

/// Fork the conversation at one message (the CLI's /branch equivalent).
#[tauri::command]
pub async fn branch_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    workspace_path: String,
    target_uuid: String,
) -> Result<BranchResult, String> {
    let db = Arc::clone(&state.db);
    let sink = Arc::clone(&state.sink);
    let result = tauri::async_runtime::spawn_blocking(move || {
        branch_session_blocking(&db, &engine, &session_id, &workspace_path, &target_uuid)
    })
    .await
    .map_err(|e| e.to_string())??;
    sink.emit_sessions_changed();
    Ok(result)
}

/// 远程(WSL 发行版内)会话删除:插件会话源上报的 remotePath 经与
/// load_remote_session_page 相同的形状白名单校验后,走同一套远程通道
/// rm。远程会话没有本地 db 行,无需 emit_sessions_changed——前端
/// 删除后自行刷新,插件源重新 list 时文件已不存在。
#[tauri::command]
pub async fn delete_remote_session(
    state: tauri::State<'_, crate::AppState>,
    workspace_path: String,
    engine: String,
    remote_path: String,
) -> Result<(), String> {
    if !is_plausible_remote_session_path(&engine, &remote_path) {
        return Err(format!("远程会话路径不合法: {remote_path}"));
    }
    let transport = crate::engine::wsl_transport::transport_for_workspace(&state.db, &workspace_path)
        .ok_or_else(|| format!("工作区 {workspace_path} 未登记远程传输"))?;
    let quoted = crate::engine::wsl_transport::sh_quote(&remote_path);
    let script = format!("rm -f -- {quoted}");
    crate::engine::wsl_transport::run_script_output(&transport, &script).await?;
    Ok(())
}

#[tauri::command]
pub fn pin_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    pinned: bool,
) -> Result<(), String> {
    mutate_sessions(
        &state,
        "UPDATE sessions SET pinned=?3 WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id, pinned as i64],
    )
}

#[tauri::command]
pub fn rename_session(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    title: String,
) -> Result<(), String> {
    let value = if title.trim().is_empty() {
        None
    } else {
        Some(title.trim().to_string())
    };
    mutate_sessions(
        &state,
        "UPDATE sessions SET custom_title=?3 WHERE engine=?1 AND session_id=?2",
        rusqlite::params![engine, session_id, value],
    )
}

#[tauri::command]
pub fn rescan_sessions(state: tauri::State<'_, crate::AppState>) {
    super::scanner::spawn_scan(Arc::clone(&state.db), Arc::clone(&state.sink));
}

// ==================== Workspaces ====================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Workspace {
    pub id: String,
    pub path: String,
    pub name: String,
    pub last_opened_at: Option<i64>,
    pub sort_order: Option<i64>,
    /// Sidebar group (工作区分组) this workspace belongs to; None = ungrouped.
    pub group_id: Option<String>,
    /// Opaque metadata written via host-capability callers (plugin
    /// `workspaces.add`); absent for ordinary directories. The backend never
    /// interprets it — consumers (spawn transport, plugin panels) own the shape.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<serde_json::Value>,
}

#[tauri::command]
pub fn list_workspaces(state: tauri::State<'_, crate::AppState>) -> Result<Vec<Workspace>, String> {
    query_rows(
        &state,
        "SELECT id, path, name, last_opened_at, sort_order, group_id, meta FROM workspaces
         ORDER BY sort_order IS NULL, sort_order, COALESCE(last_opened_at, 0) DESC",
        |r| {
            let meta_json: Option<String> = r.get(6)?;
            Ok(Workspace {
                id: r.get(0)?,
                path: r.get(1)?,
                name: r.get(2)?,
                last_opened_at: r.get(3)?,
                sort_order: r.get(4)?,
                group_id: r.get(5)?,
                meta: meta_json.and_then(|s| serde_json::from_str(&s).ok()),
            })
        },
    )
}

#[tauri::command]
pub fn add_workspace(
    state: tauri::State<'_, crate::AppState>,
    path: String,
    meta: Option<serde_json::Value>,
) -> Result<Workspace, String> {
    // `wsl` meta steers engine traffic over ssh to a plugin-named host (出站
    // + 远程执行导向) — it must come through plugin_caps::plugin_add_workspace
    // where the manifest grant is checked server-side. This general command
    // serves trusted host UI only (a plugin bypassing the JS gate via direct
    // IPC would otherwise set it here).
    if let Some(m) = &meta {
        if m.as_object().is_some_and(|o| o.contains_key("wsl")) {
            return Err(
                "wsl meta requires plugin_add_workspace (host:workspace:remote grant)".to_string(),
            );
        }
    }
    add_workspace_inner(&state, &path, meta)
}

/// Shared body of `add_workspace` / `plugin_caps::plugin_add_workspace`:
/// shape checks + upsert. Grant checks live in the callers.
pub(crate) fn add_workspace_inner(
    state: &crate::AppState,
    path: &str,
    meta: Option<serde_json::Value>,
) -> Result<Workspace, String> {
    let trimmed = path.trim();
    if trimmed.is_empty() {
        return Err("empty path".to_string());
    }
    // Host-capability callers (plugin workspaces.add) may register paths that
    // do not exist on this machine (remote host / WSL distro) — meta presence
    // is the opt-in that skips the local is_dir check.
    if meta.is_none() {
        let dir = std::path::PathBuf::from(trimmed);
        if !dir.is_dir() {
            return Err(format!("not a directory: {trimmed}"));
        }
    }
    if let Some(m) = &meta {
        if m.as_object().is_none_or(|o| o.is_empty()) {
            return Err("meta must be a non-empty object when provided".to_string());
        }
    }
    let name = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|n| n.to_str())
        .map(str::to_string)
        // "/" 这类纯分隔符路径:file_name 为 None 且 trim 后为空 → 原串兜底,
        // 空名字进 db 只会换来一个无法辨认的侧栏条目。
        .unwrap_or_else(|| match trimmed.trim_end_matches(['/', '\\']) {
            "" => trimmed.to_string(),
            rest => rest.to_string(),
        });
    let id = uuid::Uuid::new_v4().to_string();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0);
    let meta_json = meta.as_ref().map(|m| m.to_string());
    {
        let conn = state.db.0.lock();
        conn.execute(
            "INSERT INTO workspaces(id, path, name, last_opened_at, meta) VALUES(?1,?2,?3,?4,?5)
             ON CONFLICT(path) DO UPDATE SET last_opened_at=excluded.last_opened_at,
                meta=COALESCE(excluded.meta, workspaces.meta)",
            rusqlite::params![id, trimmed, name, now, meta_json],
        )
        .map_err(|e| e.to_string())?;
    }
    super::scanner::spawn_scan(Arc::clone(&state.db), Arc::clone(&state.sink));
    Ok(Workspace {
        id,
        path: trimmed.to_string(),
        name,
        last_opened_at: Some(now),
        sort_order: None,
        group_id: None,
        meta,
    })
}
/// Assign a workspace to a sidebar group (None = ungrouped). The group must
/// exist in app settings so a deleted group never lingers on a row.
#[tauri::command]
pub fn set_workspace_group(
    state: tauri::State<'_, crate::AppState>,
    id: String,
    group_id: Option<String>,
) -> Result<(), String> {
    if let Some(gid) = group_id.as_deref() {
        let exists = crate::settings::read_settings()?
            .workspace_groups
            .iter()
            .any(|g| g.id == gid);
        if !exists {
            return Err(format!("unknown group: {gid}"));
        }
    }
    let conn = state.db.0.lock();
    conn.execute(
        "UPDATE workspaces SET group_id=?2 WHERE id=?1",
        rusqlite::params![id, group_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[tauri::command]
pub fn reorder_workspaces(
    state: tauri::State<'_, crate::AppState>,
    ids: Vec<String>,
) -> Result<(), String> {
    let conn = state.db.0.lock();
    for (index, id) in ids.iter().enumerate() {
        conn.execute(
            "UPDATE workspaces SET sort_order=?2 WHERE id=?1",
            rusqlite::params![id, index as i64],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
pub fn remove_workspace(
    state: tauri::State<'_, crate::AppState>,
    id: String,
) -> Result<(), String> {
    let conn = state.db.0.lock();
    let path: Option<String> = conn
        .query_row(
            "SELECT path FROM workspaces WHERE id=?1",
            rusqlite::params![id],
            |r| r.get(0),
        )
        .ok();
    conn.execute("DELETE FROM workspaces WHERE id=?1", rusqlite::params![id])
        .map_err(|e| e.to_string())?;
    if let Some(path) = path {
        conn.execute(
            "DELETE FROM sessions WHERE workspace_path=?1",
            rusqlite::params![path],
        )
        .map_err(|e| e.to_string())?;
    }
    drop(conn);
    state.sink.emit_sessions_changed();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("hzkcode-history-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Steers HZKCODE_CONFIG_DIR (what `engine_home` reads) at the scratch;
    /// shares the process-wide env lock with the other modules' tests.
    struct ConfigDirGuard {
        _lock: parking_lot::MutexGuard<'static, ()>,
        prev: Option<std::ffi::OsString>,
    }
    impl ConfigDirGuard {
        fn set(dir: &Path) -> Self {
            let lock = crate::test_support::HOME_ENV_LOCK.lock();
            let prev = std::env::var_os("HZKCODE_CONFIG_DIR");
            std::env::set_var("HZKCODE_CONFIG_DIR", dir);
            Self { _lock: lock, prev }
        }
    }
    impl Drop for ConfigDirGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(value) => std::env::set_var("HZKCODE_CONFIG_DIR", value),
                None => std::env::remove_var("HZKCODE_CONFIG_DIR"),
            }
        }
    }

    #[test]
    fn delete_session_finds_unindexed_files_and_stays_idempotent() {
        let scratch = Scratch::new();
        let db = crate::db::Db::open_at(&scratch.0.join("app.db")).unwrap();
        let config_dir = scratch.0.join("cli");
        let projects = config_dir.join("projects");
        let dir_a = projects.join("-ws-a");
        let dir_b = projects.join("-ws-b");
        std::fs::create_dir_all(&dir_a).unwrap();
        std::fs::create_dir_all(&dir_b).unwrap();
        // A fresh (never scanned) session, a mis-filed copy in another
        // project dir, and its sidecar subagent dir.
        std::fs::write(dir_a.join("fresh-1.jsonl"), "{}\n").unwrap();
        std::fs::write(dir_b.join("fresh-1.jsonl"), "{}\n").unwrap();
        std::fs::create_dir_all(dir_a.join("fresh-1/subagents")).unwrap();
        std::fs::write(dir_a.join("fresh-1/subagents/agent-x.jsonl"), "{}\n").unwrap();
        // An indexed session: row + file.
        std::fs::write(dir_a.join("indexed-1.jsonl"), "{}\n").unwrap();
        db.0.lock()
            .execute(
                "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title) VALUES('claude','indexed-1','/ws',?1,1,1,'t')",
                rusqlite::params![dir_a.join("indexed-1.jsonl").to_string_lossy()],
            )
            .unwrap();
        let _guard = ConfigDirGuard::set(&config_dir);

        // No db row at all (fresh / mis-filed): located by id and deleted.
        delete_session_blocking(&db, "claude", "fresh-1").unwrap();
        assert!(!dir_a.join("fresh-1.jsonl").exists());
        assert!(!dir_b.join("fresh-1.jsonl").exists());
        assert!(!dir_a.join("fresh-1").exists(), "sidecar dir must go too");

        // Indexed session: file and row both go.
        delete_session_blocking(&db, "claude", "indexed-1").unwrap();
        assert!(!dir_a.join("indexed-1.jsonl").exists());
        let count: i64 = db
            .0
            .lock()
            .query_row(
                "SELECT COUNT(*) FROM sessions WHERE session_id='indexed-1'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);

        // Nothing on disk and no row: still Ok, so a stale sidebar row can go.
        delete_session_blocking(&db, "claude", "fresh-1").unwrap();

        // A hostile id never escapes the projects root.
        assert!(session_files_by_id("claude", "../evil").is_empty());
        delete_session_blocking(&db, "claude", "../evil").unwrap();
    }

    #[test]
    fn branch_session_forks_at_the_target_entry() {
        let scratch = Scratch::new();
        let db = crate::db::Db::open_at(&scratch.0.join("app.db")).unwrap();
        let config_dir = scratch.0.join("cli");
        let projects = config_dir.join("projects");
        let dir = projects.join("-ws");
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("src-1.jsonl");
        let lines = [
            serde_json::json!({"type":"user","uuid":"u1","sessionId":"src-1","message":{"role":"user","content":"hi"},"timestamp":"2026-10-04T00:00:00.000Z"}),
            serde_json::json!({"type":"assistant","uuid":"a1","sessionId":"src-1","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"hello"}]},"timestamp":"2026-10-04T00:00:01.000Z"}),
            serde_json::json!({"type":"user","uuid":"u2","sessionId":"src-1","message":{"role":"user","content":"again"},"timestamp":"2026-10-04T00:00:02.000Z"}),
            serde_json::json!({"type":"assistant","uuid":"a2","sessionId":"src-1","message":{"role":"assistant","model":"m","content":[{"type":"text","text":"done"}]},"timestamp":"2026-10-04T00:00:03.000Z"}),
            serde_json::json!({"type":"content-replacement","sessionId":"src-1","replacements":[{"id":"r1"}]}),
        ];
        std::fs::write(
            &src,
            lines.iter().map(|l| l.to_string()).collect::<Vec<_>>().join("\n") + "\n",
        )
        .unwrap();
        db.0.lock()
            .execute(
                "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title,custom_title) VALUES('claude','src-1','/ws',?1,1,1,'t','接续测试')",
                rusqlite::params![src.to_string_lossy().to_string()],
            )
            .unwrap();
        let _guard = ConfigDirGuard::set(&config_dir);

        // Assistant target: forks inclusive of that reply.
        let result = branch_session_blocking(&db, "claude", "src-1", "/ws", "a1").unwrap();
        let fork = dir.join(format!("{}.jsonl", result.session_id));
        let text = std::fs::read_to_string(&fork).unwrap();
        let forked: Vec<Value> = text
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        let ids: Vec<&str> = forked
            .iter()
            .filter_map(|e| e.get("uuid").and_then(Value::as_str))
            .collect();
        assert_eq!(ids, ["u1", "a1"]);
        assert!(forked.iter().all(|e| {
            e.get("sessionId").and_then(Value::as_str) == Some(result.session_id.as_str())
        }));
        assert_eq!(
            forked[0].get("forkedFrom").unwrap(),
            &serde_json::json!({"sessionId":"src-1","messageUuid":"u1"})
        );
        assert!(forked[0].get("parentUuid").unwrap().is_null());
        assert_eq!(forked[1].get("parentUuid").and_then(Value::as_str), Some("u1"));
        let repl = forked
            .iter()
            .find(|e| e.get("type").and_then(Value::as_str) == Some("content-replacement"))
            .unwrap();
        assert_eq!(
            repl.get("sessionId").and_then(Value::as_str),
            Some(result.session_id.as_str())
        );
        assert_eq!(result.title.as_deref(), Some("接续测试 (分支)"));
        assert!(forked.iter().any(|e| {
            e.get("type").and_then(Value::as_str) == Some("custom-title")
                && e.get("customTitle").and_then(Value::as_str) == Some("接续测试 (分支)")
        }));
        let db_title: Option<String> = db
            .0
            .lock()
            .query_row(
                "SELECT custom_title FROM sessions WHERE session_id=?1",
                rusqlite::params![result.session_id],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(db_title.as_deref(), Some("接续测试 (分支)"));

        // User target: forks right before the selected prompt.
        let second = branch_session_blocking(&db, "claude", "src-1", "/ws", "u2").unwrap();
        assert_eq!(second.title.as_deref(), Some("接续测试 (分支 2)"));
        let text2 = std::fs::read_to_string(dir.join(format!("{}.jsonl", second.session_id))).unwrap();
        let ids2: Vec<String> = text2
            .lines()
            .filter_map(|l| serde_json::from_str::<Value>(l).ok())
            .filter_map(|e| e.get("uuid").and_then(Value::as_str).map(str::to_string))
            .collect();
        assert_eq!(ids2, ["u1", "a1"]);

        // Missing target: localized error, nothing written.
        let before = std::fs::read_dir(&dir).unwrap().count();
        assert!(branch_session_blocking(&db, "claude", "src-1", "/ws", "nope").is_err());
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), before);
    }

    #[test]
    fn remote_session_path_shape_is_claude_only() {
        // 合法形态:绝对 .jsonl 且落在 claude 会话目录下
        assert!(is_plausible_remote_session_path(
            "claude",
            "/home/dev/.hzkcode/projects/-home-dev-proj/s-1.jsonl"
        ));
        // 形状不符:相对路径、非 jsonl、`..` 段、目录形态不匹配
        assert!(!is_plausible_remote_session_path("claude", "home/dev/x.jsonl"));
        assert!(!is_plausible_remote_session_path("claude", "/home/dev/.hzkcode/projects/p/s.txt"));
        assert!(!is_plausible_remote_session_path(
            "claude",
            "/home/dev/.hzkcode/projects/../settings.jsonl"
        ));
        // 任意 .jsonl(不在会话目录形态下)一律拒绝 —— 防借 IPC 读发行版文件
        assert!(!is_plausible_remote_session_path("claude", "/etc/cron.d/job.jsonl"));
        // 未适配引擎一律拒绝,即使路径落在 claude 会话树里
        assert!(!is_plausible_remote_session_path(
            "codex",
            "/home/dev/.codex/sessions/2026/09/15/rollout-abc.jsonl"
        ));
        assert!(!is_plausible_remote_session_path(
            "codex",
            "/home/dev/.hzkcode/projects/p/s.jsonl"
        ));
    }

    #[test]
    fn session_page_restores_subagents_older_than_the_visible_page() {
        let scratch = Scratch::new();
        let path = scratch.0.join("session.jsonl");
        let db_path = scratch.0.join("app.db");
        let brief = "# Target\nReview the relay.\n# Acceptance\nRecover without toggling.";
        let mut lines = vec![
            json!({"type":"user","message":{"role":"user","content":"Review"}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{
                "type":"tool_use","id":"dispatch","name":"Task",
                "input":{"description":"SavedReviewer","prompt":brief}
            }]}}),
            json!({"type":"user","message":{"role":"user","content":[{
                "type":"tool_result","tool_use_id":"dispatch",
                "content":[{"type":"text","text":"Spawned"}]
            }]}}),
        ];
        for i in 0..120 {
            lines.push(json!({"type":"assistant","message":{"role":"assistant","content":format!("later {i}")}}));
        }
        std::fs::write(&path, lines.iter().map(serde_json::Value::to_string).collect::<Vec<_>>().join("\n")).unwrap();
        {
            let db = crate::db::Db::open_at(&db_path).unwrap();
            db.0.lock().execute(
                "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title) VALUES('claude','saved','/ws',?1,1,1,'Review')",
                rusqlite::params![path.to_string_lossy().as_ref()],
            ).unwrap();
        }
        // Reopen the DB as a fresh process would, with no frontend roster cache.
        let db = crate::db::Db::open_at(&db_path).unwrap();
        let page = load_session_page_blocking(&db, "claude", "saved", Some(100), None).unwrap();
        assert_eq!(page.messages.len(), 100);
        assert!(page.messages.iter().all(|message| message.text.starts_with("later")));
        let wire = serde_json::to_value(&page).unwrap();
        let history = wire["subagentHistory"].as_array().expect("session history is independent of pagination");
        let task = history.iter().find(|row| row["text"] == "Task").unwrap();
        assert_eq!(task["args"]["description"], "SavedReviewer");
        assert_eq!(task["args"]["prompt"], brief);
        let older = load_session_page_blocking(&db, "claude", "saved", Some(100), page.next_before).unwrap();
        assert!(older.messages.iter().any(|row| row.text == "Task"));
    }

    fn plain(seq: i64, role: &str) -> Message {
        Message {
            seq,
            role: role.into(),
            text: String::new(),
            ts: None,
            uuid: None,
            path: None,
            args: None,
            result: None,
            todos: None,
            usage: None,
            model: None,
            effort: None,
            duration_ms: None,
            images: Vec::new(),
            level: None,
        }
    }

    fn delegation(seq: i64) -> Message {
        let mut message = plain(seq, "tool");
        message.text = "task · worker".into();
        message.args = Some(json!({"tasks": []}));
        message
    }

    /// Cutting the cached full fold at a page start must reproduce a fresh
    /// fold of that prefix byte for byte — including the pending-user row
    /// that the full fold spends past the cut, and one a newer user replaces
    /// so it never appears in the full fold at all.
    #[test]
    fn truncated_fold_matches_a_fresh_prefix_fold() {
        let messages = vec![
            plain(0, "user"),       // closed by the delegation at 1
            delegation(1),          // emits user 0 + itself
            plain(2, "assistant"),  // turn boundary
            plain(3, "user"),       // replaced by user 4: absent from the full fold
            plain(4, "user"),       // closed by the delegation at 5
            delegation(5),
            plain(6, "user"),       // spent past the cut by the boundary at 7
            plain(7, "thinking"),   // turn boundary, emits user 6
            plain(8, "user"),       // trailing unclosed user
            plain(9, "assistant"),  // no boundary: follows a boundary, not a delegation
        ];
        let fold = subagent_fold(&messages);
        for start in 0..=messages.len() {
            let cut = serde_json::to_value(subagent_history_until(&messages, &fold, start)).unwrap();
            let fresh = serde_json::to_value(subagent_history(&messages[..start])).unwrap();
            assert_eq!(cut, fresh, "start={start}");
        }
    }

    /// claude sessions are a single jsonl — the plain remove_file arm.
    #[test]
    fn delete_claude_removes_single_file() {
        let scratch = Scratch::new();
        let path = scratch.0.join("sess-1.jsonl");
        std::fs::write(&path, "{}\n").unwrap();
        delete_session_disk("claude", &path).unwrap();
        assert!(!path.exists());
    }

    /// Unknown engines fail loudly instead of silently skipping the disk
    /// delete (the silent path is how deleted sessions resurrect).
    #[test]
    fn delete_unknown_engine_errors() {
        let scratch = Scratch::new();
        let path = scratch.0.join("sess.jsonl");
        std::fs::write(&path, "{}").unwrap();
        assert!(delete_session_disk("future-engine", &path).is_err());
        assert!(path.exists());
    }
}
