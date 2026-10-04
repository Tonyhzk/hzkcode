use super::{scan_summary_file, session_stat_signature, ScanSummary, SessionFile};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// Bump when title derivation changes so unchanged files still re-title.
const TITLE_VERSION: &str = "8";

/// Titles matching these prefixes were derived before envelope stripping
/// existed; one migration pass re-derives them even when files are unchanged.
const NOISE_TITLE_WHERE: &str = "title LIKE '<file %' ESCAPE '\\'
     OR title LIKE '[Image #%' ESCAPE '\\'
     OR title LIKE '<user\\_info%' ESCAPE '\\'
     OR title LIKE '<user\\_query%' ESCAPE '\\'
     OR title LIKE '# AGENTS.md instructions%'
     OR title LIKE '<environment\\_context%' ESCAPE '\\'
     OR title LIKE '<agents-instructions%'
     OR title LIKE '<skill>%'
     OR title LIKE '<recommended\\_plugins%' ESCAPE '\\'
     OR title LIKE '<command-message%'
     OR title LIKE '<command-name%'
     OR title LIKE '<INSTRUCTIONS>%'";

fn discover_claude(workspace: &Path) -> Vec<SessionFile> {
    // The CLI's config root honors HZKCODE_CONFIG_DIR; pinning ~/.hzkcode
    // here would lose the history of users who relocate it.
    let base = crate::engine::engine_home(Some("HZKCODE_CONFIG_DIR"), ".hzkcode").join("projects");
    let mut out = Vec::new();
    let mut seen_sessions = std::collections::HashSet::new();
    for dir in claude_project_dirs(&base, workspace) {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if path.extension().and_then(|e| e.to_str()) != Some("jsonl") {
                continue;
            }
            let Some(stem) = path.file_stem().and_then(|s| s.to_str()) else {
                continue;
            };
            if stem == "history" || !seen_sessions.insert(stem.to_string()) {
                continue;
            }
            out.push(SessionFile {
                engine: "claude",
                session_id: stem.to_string(),
                workspace_path: workspace.to_string_lossy().to_string(),
                file_path: path,
            });
        }
    }
    out
}

/// Strip the `\\?\` verbatim prefix Windows `canonicalize` adds — the CLI
/// encodes the plain path, so the prefix would break the match.
fn strip_verbatim_prefix(path: &str) -> &str {
    path.strip_prefix(r"\\?\").unwrap_or(path)
}

/// Candidate `<projects>/<encoded>` dirs for one workspace. Windows terminals
/// disagree on drive-letter case, slash direction, and trailing separators,
/// and the CLI encodes whatever cwd spelling it saw — so try the raw
/// spelling, a trailing-separator-trimmed one, and the canonicalized path.
fn claude_project_dirs(base: &Path, workspace: &Path) -> Vec<PathBuf> {
    fn push(out: &mut Vec<PathBuf>, seen: &mut std::collections::HashSet<String>, base: &Path, spelling: &str) {
        if !spelling.is_empty() && seen.insert(spelling.to_string()) {
            out.push(base.join(super::claude_encode_project_path(spelling)));
        }
    }
    let mut out = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let raw = workspace.to_string_lossy().to_string();
    let trimmed = raw.trim_end_matches(['/', '\\']).to_string();
    push(&mut out, &mut seen, base, &raw);
    push(&mut out, &mut seen, base, &trimmed);
    for spelling in [&raw, &trimmed] {
        if let Ok(canonical) = std::fs::canonicalize(spelling) {
            let canonical = strip_verbatim_prefix(&canonical.to_string_lossy()).to_string();
            push(&mut out, &mut seen, base, &canonical);
        }
    }
    out
}

// ==================== Scan ====================

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanReport {
    pub scanned: usize,
    pub reparsed: usize,
    pub reused: usize,
}

/// One candidate session file on disk, identified lazily.
struct Candidate {
    engine: &'static str,
    path: PathBuf,
    /// Session id known from the filename/index without reading the file.
    known_id: Option<String>,
    /// Workspace attribution without reading the file (filename-keyed engines).
    known_workspace: Option<String>,
}

/// The scan only ever needs the
/// db and the event sink, so callers pass those two directly.
fn scan_with_sink(
    db: &crate::db::Db,
    sink: &Arc<crate::event_sink::EventSink>,
) -> Result<ScanReport, String> {
    let changed_sink = Arc::clone(sink);
    let progress_sink = Arc::clone(sink);
    scan_inner(
        db,
        move || changed_sink.emit_sessions_changed(),
        move |p| progress_sink.emit_scan_progress(p),
    )
}

/// The scan itself, decoupled from the event sink for testing.
pub fn scan_with(db: &crate::db::Db, on_changed: impl Fn()) -> Result<ScanReport, String> {
    scan_inner(db, on_changed, |_| {})
}

// ---------- phase helpers (each stage is lock-free except where noted) ----------

/// Enumerate every candidate session file (readdir/index only, no content).
fn gather_candidates(workspaces: &[String]) -> Vec<Candidate> {
    let mut candidates: Vec<Candidate> = Vec::new();
    let mut seen_paths: std::collections::HashSet<PathBuf> = std::collections::HashSet::new();
    for workspace_path in workspaces {
        let workspace = PathBuf::from(workspace_path);
        for file in discover_claude(&workspace) {
            if seen_paths.insert(file.file_path.clone()) {
                candidates.push(Candidate {
                    engine: file.engine,
                    path: file.file_path,
                    known_id: Some(file.session_id),
                    known_workspace: Some(file.workspace_path),
                });
            }
        }
    }
    candidates
}

/// Stat every candidate and fold (path, size, mtime) into one signature. The
/// per-file signature also folds the segment manifest in (segmented sessions),
/// so rotations invalidate caches even when the active file is untouched.
fn stat_all(workspaces: &[String], candidates: &[Candidate]) -> (Vec<Option<(i64, i64)>>, String) {
    let mut signature_hasher = Sha256::new();
    signature_hasher.update(format!("v{}|", crate::db::CACHE_VERSION).as_bytes());
    for w in workspaces {
        signature_hasher.update(w.as_bytes());
        signature_hasher.update(b"|");
    }
    let mut stats: Vec<Option<(i64, i64)>> = Vec::with_capacity(candidates.len());
    for cand in candidates {
        let sig = session_stat_signature(cand.engine, &cand.path);
        if let Some((size, mtime_ms)) = sig {
            signature_hasher.update(cand.path.to_string_lossy().as_bytes());
            signature_hasher.update(size.to_le_bytes());
            signature_hasher.update(mtime_ms.to_le_bytes());
        }
        stats.push(sig);
    }
    (stats, format!("{:x}", signature_hasher.finalize()))
}

/// Tier-1 gate (brief lock): a matching global signature means nothing
/// changed and the scan short-circuits. Also decides whether the one-time
/// title re-derivation migration is still pending.
struct Tier1 {
    signature: String,
    retitle_pending: bool,
}

fn tier1_gate(db: &crate::db::Db, signature: String) -> Result<Option<Tier1>, String> {
    let conn = db.0.lock();
    let previous: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key='stat_signature'",
            [],
            |r| r.get(0),
        )
        .ok();
    let row_count: i64 = conn
        .query_row("SELECT COUNT(*) FROM sessions", [], |r| r.get(0))
        .unwrap_or(0);
    let title_version: Option<String> = conn
        .query_row(
            "SELECT value FROM meta WHERE key='title_version'",
            [],
            |r| r.get(0),
        )
        .ok();
    // One-time migration: titles derived before envelope stripping
    // (`<file …` / `[Image #…` / `<user_info>`) or rows with no timestamps
    // force a single re-derivation even when files are unchanged.
    let retitle_pending = title_version.as_deref() != Some(TITLE_VERSION)
        && conn
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM sessions WHERE {NOISE_TITLE_WHERE} OR updated_at IS NULL"
                ),
                [],
                |r| r.get::<_, i64>(0),
            )
            .map_err(|e| e.to_string())?
            > 0;
    if previous.as_deref() == Some(signature.as_str()) && row_count > 0 && !retitle_pending {
        return Ok(None);
    }
    Ok(Some(Tier1 {
        signature,
        retitle_pending,
    }))
}

/// Prefetch (brief lock) the stored per-file stat keys and, while the
/// re-title migration runs, the paths whose titles are still noise. Lets the
/// parse phase decide "unchanged" without holding the db lock.
fn prefetch_stat_keys(
    db: &crate::db::Db,
    retitle_pending: bool,
) -> Result<
    (
        std::collections::HashMap<String, (i64, i64)>,
        std::collections::HashSet<String>,
    ),
    String,
> {
    let conn = db.0.lock();
    let mut stmt = conn
        .prepare("SELECT file_path, file_size, file_mtime_ms FROM sessions")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
            ))
        })
        .map_err(|e| e.to_string())?;
    let mut stats = std::collections::HashMap::new();
    for row in rows {
        match row {
            Ok((path, size, mtime)) => {
                stats.insert(path, (size, mtime));
            }
            Err(e) => eprintln!("[scanner] skipping undecodable session stat row: {e}"),
        }
    }
    let mut stale = std::collections::HashSet::new();
    if retitle_pending {
        let mut stmt = conn
            .prepare(&format!(
                "SELECT file_path FROM sessions WHERE {NOISE_TITLE_WHERE} OR updated_at IS NULL"
            ))
            .map_err(|e| e.to_string())?;
        let rows = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?;
        for row in rows {
            match row {
                Ok(path) => {
                    stale.insert(path);
                }
                Err(e) => eprintln!("[scanner] skipping undecodable stale-title row: {e}"),
            }
        }
    }
    Ok((stats, stale))
}

/// One changed file fully processed outside the db lock: identity peek (for
/// head-keyed engines) + the lightweight summary parse.
struct PreparedUpsert {
    engine: &'static str,
    session_id: String,
    workspace_path: String,
    path_str: String,
    size: i64,
    mtime_ms: i64,
    summary: ScanSummary,
}

fn prepare_candidate(
    cand: &Candidate,
    sig: (i64, i64),
    stat_keys: &std::collections::HashMap<String, (i64, i64)>,
    stale_paths: &std::collections::HashSet<String>,
) -> Option<PreparedUpsert> {
    let (size, mtime_ms) = sig;
    let path_str = cand.path.to_string_lossy().to_string();
    // Unchanged on disk (stat key match) and not pending re-title: reuse.
    if stat_keys.get(&path_str) == Some(&sig) && !stale_paths.contains(&path_str) {
        return None;
    }
    // Claude sessions carry their identity from the filename index.
    let session_id = cand.known_id.clone()?;
    let workspace_path = cand.known_workspace.clone()?;
    let summary = scan_summary_file(cand.engine, &cand.path).ok()?;
    Some(PreparedUpsert {
        engine: cand.engine,
        session_id,
        workspace_path,
        path_str,
        size,
        mtime_ms,
        summary,
    })
}

/// Phase B (one lock, one transaction): upsert every prepared row, then
/// record the signature that makes the next scan a short-circuit.
fn upsert_rows(db: &crate::db::Db, rows: &[PreparedUpsert], tier1: &Tier1) -> Result<(), String> {
    let mut conn = db.0.lock();
    let tx = conn.transaction().map_err(|e| e.to_string())?;
    for row in rows {
        // Engines whose jsonl has no per-line timestamps would otherwise land
        // at updated_at=0 and fall off the sidebar's recent list. File mtime
        // is the fallback for every engine, not a grok-only special case.
        let created_at = row.summary.first_ts.or(Some(row.mtime_ms));
        let updated_at = row.summary.last_ts.or(Some(row.mtime_ms));
        tx.execute(
            "INSERT INTO sessions(engine, session_id, workspace_path, file_path, file_size, file_mtime_ms, title, preview, created_at, updated_at, message_count)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(engine, session_id) DO UPDATE SET
                workspace_path=excluded.workspace_path,
                file_path=excluded.file_path,
                file_size=excluded.file_size,
                file_mtime_ms=excluded.file_mtime_ms,
                title=excluded.title,
                preview=excluded.preview,
                created_at=COALESCE(sessions.created_at, excluded.created_at),
                updated_at=excluded.updated_at,
                message_count=excluded.message_count",
            rusqlite::params![
                row.engine,
                row.session_id,
                row.workspace_path,
                row.path_str,
                row.size,
                row.mtime_ms,
                row.summary.title,
                row.summary.preview,
                created_at,
                updated_at,
                row.summary.message_count,
            ],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.execute(
        "INSERT INTO meta(key, value) VALUES('stat_signature', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        rusqlite::params![tier1.signature],
    )
    .map_err(|e| e.to_string())?;
    tx.execute(
        "INSERT INTO meta(key, value) VALUES('title_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        [TITLE_VERSION],
    )
    .map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}

/// `on_progress` fires throttled during the parse loop and once with
/// `finished: true` when a scan that emitted any progress completes.
fn scan_inner(
    db: &crate::db::Db,
    on_changed: impl Fn(),
    on_progress: impl Fn(crate::event_sink::ScanProgress),
) -> Result<ScanReport, String> {
    let workspaces = db.workspace_paths()?;
    let candidates = gather_candidates(&workspaces);
    let (stats, signature) = stat_all(&workspaces, &candidates);
    let Some(tier1) = tier1_gate(db, signature)? else {
        return Ok(ScanReport {
            scanned: candidates.len(),
            reparsed: 0,
            reused: candidates.len(),
        });
    };
    let (stat_keys, stale_paths) = prefetch_stat_keys(db, tier1.retitle_pending)?;

    // Phase A (lock-free): parse changed files, collect rows to upsert.
    let total = candidates.len();
    let step = (total / 50).max(1);
    if total > 0 {
        on_progress(crate::event_sink::ScanProgress {
            done: 0,
            total,
            finished: false,
        });
    }
    let mut rows = Vec::new();
    let mut reused = 0usize;
    for (index, (cand, sig)) in candidates.iter().zip(stats.iter()).enumerate() {
        let processed = index + 1;
        if processed % step == 0 {
            on_progress(crate::event_sink::ScanProgress {
                done: processed,
                total,
                finished: false,
            });
        }
        let Some(sig) = sig else {
            continue;
        };
        match prepare_candidate(cand, *sig, &stat_keys, &stale_paths) {
            Some(row) => rows.push(row),
            None => {
                if stat_keys.get(&cand.path.to_string_lossy().to_string()) == Some(sig) {
                    reused += 1;
                }
            }
        }
    }

    // Phase B: the db lock is held only for the upsert transaction.
    let reparsed = rows.len();
    upsert_rows(db, &rows, &tier1)?;
    on_changed();
    if total > 0 {
        on_progress(crate::event_sink::ScanProgress {
            done: total,
            total,
            finished: true,
        });
    }
    Ok(ScanReport {
        scanned: total,
        reparsed,
        reused,
    })
}

/// Spawn a background scan off the Tauri runtime. Concurrent invocations
/// collapse: a scan already in flight makes the new call a no-op.
pub fn spawn_scan(db: Arc<crate::db::Db>, sink: Arc<crate::event_sink::EventSink>) {
    use std::sync::atomic::{AtomicBool, Ordering};
    static SCAN_RUNNING: AtomicBool = AtomicBool::new(false);
    if SCAN_RUNNING
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return;
    }
    tauri::async_runtime::spawn_blocking(move || {
        // RAII so a panicking scan still frees the slot for the next one.
        struct ResetOnDrop;
        impl Drop for ResetOnDrop {
            fn drop(&mut self) {
                SCAN_RUNNING.store(false, Ordering::SeqCst);
            }
        }
        let _guard = ResetOnDrop;
        if let Err(error) = scan_with_sink(&db, &sink) {
            eprintln!("[scanner] scan failed: {error}");
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Serializes env-mutating scanner tests: two tests mutating the process
    /// environment in parallel would clobber each other.
    static HOME_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

    fn scratch_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("hzkcode-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// Env-mutating guard for HZKCODE_CONFIG_DIR; shares HOME_LOCK so every
    /// env-dependent scanner test stays serialized.
    struct HzkcodeConfigDirGuard {
        _lock: std::sync::MutexGuard<'static, ()>,
        prev: Option<std::ffi::OsString>,
    }
    impl HzkcodeConfigDirGuard {
        fn set(dir: &Path) -> Self {
            let lock = HOME_LOCK.lock().unwrap_or_else(|e| e.into_inner());
            let prev = std::env::var_os("HZKCODE_CONFIG_DIR");
            std::env::set_var("HZKCODE_CONFIG_DIR", dir);
            Self { _lock: lock, prev }
        }
    }
    impl Drop for HzkcodeConfigDirGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(value) => std::env::set_var("HZKCODE_CONFIG_DIR", value),
                None => std::env::remove_var("HZKCODE_CONFIG_DIR"),
            }
        }
    }

    #[test]
    fn strip_verbatim_prefix_removes_windows_prefix_only() {
        assert_eq!(strip_verbatim_prefix(r"\\?\C:\Users\zlt\proj"), r"C:\Users\zlt\proj");
        assert_eq!(strip_verbatim_prefix(r"C:\Users\zlt\proj"), r"C:\Users\zlt\proj");
        assert_eq!(strip_verbatim_prefix("/Users/demo/proj"), "/Users/demo/proj");
    }

    /// A workspace recorded with a trailing separator must still find the
    /// history the CLI wrote under the trimmed spelling, and the config root
    /// must honor HZKCODE_CONFIG_DIR.
    #[test]
    fn discover_claude_matches_trailing_slash_spelling_under_config_dir() {
        let home = scratch_dir("discover-claude");
        let config_dir = home.join("claude-config");
        let workspace = home.join("ws");
        std::fs::create_dir_all(&workspace).unwrap();
        let encoded = super::super::claude_encode_project_path(&workspace.to_string_lossy());
        let project_dir = config_dir.join("projects").join(&encoded);
        std::fs::create_dir_all(&project_dir).unwrap();
        std::fs::write(project_dir.join("s1.jsonl"), "{}\n").unwrap();

        let _guard = HzkcodeConfigDirGuard::set(&config_dir);
        let spelled = PathBuf::from(format!("{}/", workspace.to_string_lossy()));
        let found = discover_claude(&spelled);
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].session_id, "s1");

        std::fs::remove_dir_all(&home).ok();
    }
}
