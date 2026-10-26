mod crypto;
mod storage;

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::path::Path;
use std::sync::{atomic::{AtomicBool, Ordering}, LazyLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;

const PREVIEW_TTL: Duration = Duration::from_secs(300);
const MAX_ENTRIES: usize = 1000;
const PREFERENCE_KEYS: &[&str] = &[
    "hzkcode.permissionPref:v2", "hzkcode.promptHistoryEnabled", "hzkcode.usageTracking:v1",
    "hzkcode.zoom:v1", "hzkcode.terminalHeight", "hzkcode.panelCollapsed",
    "hzkcode.panelWidthMigrated", "hzkcode.sidebarCollapsed", "hzkcode.editorCollapsed",
    "hzkcode.panelWidth", "hzkcode.sidebarWidth", "hzkcode.editorWidth",
    "hzkcode.chat.runStatusChromeOpen", "hzkcode.headerPinnedActions",
    "hzkcode.openWorkspaceApp", "hzkcode.openWorkspaceCustomApps",
];
type Preferences = BTreeMap<String, String>;

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Snapshot {
    version: u32,
    app_version: String,
    exported_at: String,
    platform: String,
    settings: Value,
    config: Value,
    agents: Value,
    prompts: BTreeMap<String, String>,
    preferences: Preferences,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    code: &'static str,
    field: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Preview {
    token: String,
    app_version: String,
    exported_at: String,
    platform: String,
    provider_count: usize,
    agent_count: usize,
    prompt_count: usize,
    preference_count: usize,
    warnings: Vec<Warning>,
}

struct Pending {
    token: String,
    created: Instant,
    snapshot: Snapshot,
    original_digest: Vec<u8>,
    recovery_key: crypto::BackupKey,
    warnings: Vec<Warning>,
}
static PENDING: LazyLock<parking_lot::Mutex<Option<Pending>>> = LazyLock::new(|| parking_lot::Mutex::new(None));
static RESTART_PENDING: AtomicBool = AtomicBool::new(false);

pub(crate) fn ensure_writable() -> Result<(), String> {
    if RESTART_PENDING.load(Ordering::Acquire) { Err("backup_restart_required".into()) } else { Ok(()) }
}

#[derive(Serialize)]
pub struct ExportResult { path: String }
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportResult {
    backup_path: String,
    preferences: Preferences,
    warnings: Vec<Warning>,
}

fn now_millis() -> String {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis().to_string()
}

fn validate_preferences(preferences: &Preferences) -> Result<(), String> {
    if preferences.iter().any(|(key, value)| !PREFERENCE_KEYS.contains(&key.as_str()) || value.len() > 1024 * 1024)
        || preferences.values().map(String::len).sum::<usize>() > 4 * 1024 * 1024 {
        return Err("backup_invalid".into());
    }
    Ok(())
}

fn validate_prompt_file(name: &str) -> Result<(), String> {
    if name.len() <= 3 || !name.to_ascii_lowercase().ends_with(".md")
        || name.contains(['/', '\\', '\0']) {
        return Err("backup_invalid".into());
    }
    Ok(())
}

fn prompt_name_supported(name: &str, platform: &str) -> bool {
    if platform != "windows" { return name.len() <= 255; }
    if name.encode_utf16().count() > 255 || name.chars().any(|c| c < ' ' || "<>:\"|?*".contains(c)) {
        return false;
    }
    let stem = name.split('.').next().unwrap_or(name).trim_end().to_ascii_uppercase();
    !matches!(stem.as_str(), "CON" | "PRN" | "AUX" | "NUL")
        && !["COM", "LPT"].iter().any(|prefix| stem.strip_prefix(prefix).is_some_and(|suffix|
            matches!(suffix, "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³")))
}

fn filter_target_prompts(snapshot: &mut Snapshot, current: &Snapshot, platform: &str, warnings: &mut Vec<Warning>) {
    let case_insensitive = ["windows", "macos"].contains(&platform);
    let mut names = HashSet::new();
    snapshot.prompts.retain(|name, _| {
        let supported = prompt_name_supported(name, platform)
            && (!case_insensitive || (names.insert(name.to_lowercase())
                && !current.prompts.keys().any(|old| old != name && old.to_lowercase() == name.to_lowercase())));
        if !supported { warnings.push(Warning { code: "prompt_skipped", field: Some(name.clone()) }); }
        supported
    });
}

fn validate_snapshot(snapshot: &Snapshot) -> Result<(), String> {
    if snapshot.version != 1 { return Err("backup_version".into()); }
    if snapshot.app_version.len() > 80 || snapshot.platform.len() > 32 || snapshot.exported_at.parse::<u64>().is_err()
        || !snapshot.settings.is_object() || !snapshot.config.is_object() || !snapshot.agents.is_object() {
        return Err("backup_invalid".into());
    }
    let settings: crate::settings::AppSettings = serde_json::from_value(snapshot.settings.clone()).map_err(|_| "backup_invalid")?;
    crate::proxy::validate_proxy_settings(&settings).map_err(|_| "backup_invalid")?;
    let config: crate::config::CliConfig = serde_json::from_value(snapshot.config.clone()).map_err(|_| "backup_invalid")?;
    if config.claude.providers.len() > MAX_ENTRIES || config.claude.providers.values().any(|value| !value.is_object()) {
        return Err("backup_invalid".into());
    }
    if let Some(id) = config.claude.current.as_deref().filter(|id| !id.is_empty()) {
        if ![crate::config::LOCAL_PROVIDER_ID, crate::config::DISABLED_PROVIDER_ID,
            crate::config::LEGACY_LOCAL_CONFIG_TOML_ID].contains(&id) && !config.claude.providers.contains_key(id) {
            return Err("backup_invalid".into());
        }
    }
    let agents: crate::agents::AgentStore = serde_json::from_value(snapshot.agents.clone()).map_err(|_| "backup_invalid")?;
    let mut ids = HashSet::new();
    if agents.agents.len() > MAX_ENTRIES { return Err("backup_too_large".into()); }
    for agent in &agents.agents {
        crate::agents::validate_agent_for_import(agent).map_err(|_| "backup_invalid")?;
        if !ids.insert(&agent.id) { return Err("backup_invalid".into()); }
    }
    if snapshot.prompts.len() > MAX_ENTRIES { return Err("backup_too_large".into()); }
    for name in snapshot.prompts.keys() {
        validate_prompt_file(name)?;
    }
    validate_preferences(&snapshot.preferences)?;
    if serde_json::to_vec(snapshot).map_err(|_| "backup_invalid")?.len() > crypto::MAX_PAYLOAD {
        return Err("backup_too_large".into());
    }
    Ok(())
}

fn read_json(path: &Path, default: Value) -> Result<Value, String> {
    match storage::read_optional(path, crypto::MAX_PAYLOAD)? {
        None => Ok(default),
        Some(bytes) if bytes.iter().all(u8::is_ascii_whitespace) => Ok(default),
        Some(bytes) => serde_json::from_slice(&bytes).map_err(|_| "backup_invalid".into()),
    }
}

fn collect(root: &Path, preferences: Preferences) -> Result<Snapshot, String> {
    storage::check_directory(root)?;
    let mut prompts = BTreeMap::new();
    let prompt_dir = root.join("prompts");
    if storage::check_optional_directory(&prompt_dir)? {
        let mut total = 0;
        for entry in std::fs::read_dir(&prompt_dir).map_err(|_| "backup_io")? {
            let entry = entry.map_err(|_| "backup_io")?;
            let name = entry.file_name().into_string().map_err(|_| "backup_invalid")?;
            if !Path::new(&name).extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) { continue; }
            validate_prompt_file(&name)?;
            let bytes = storage::read_optional(&entry.path(), crypto::MAX_PAYLOAD)?.ok_or("backup_stale")?;
            total += bytes.len();
            if total > crypto::MAX_PAYLOAD || prompts.len() >= MAX_ENTRIES { return Err("backup_too_large".into()); }
            prompts.insert(name, String::from_utf8(bytes).map_err(|_| "backup_invalid")?);
        }
    }
    let snapshot = Snapshot {
        version: 1, app_version: env!("CARGO_PKG_VERSION").into(), exported_at: now_millis(),
        platform: std::env::consts::OS.into(),
        settings: read_json(&root.join("settings.json"), serde_json::to_value(crate::settings::AppSettings::default()).unwrap())?,
        config: read_json(&root.join("config.json"), serde_json::to_value(crate::config::CliConfig::default()).unwrap())?,
        agents: read_json(&root.join("agents.json"), json!({"agents": []}))?,
        prompts, preferences,
    };
    validate_snapshot(&snapshot)?;
    Ok(snapshot)
}

fn digest(snapshot: &Snapshot) -> Vec<u8> {
    Sha256::digest(serde_json::to_vec(&(&snapshot.settings, &snapshot.config, &snapshot.agents, &snapshot.prompts)).unwrap()).to_vec()
}

fn prepare_import(mut snapshot: Snapshot, current: &Snapshot) -> Result<(Snapshot, Vec<Warning>), String> {
    let mut warnings = vec![Warning { code: "workspace_preserved", field: None }, Warning { code: "network_review", field: None }];
    let settings = snapshot.settings.as_object_mut().ok_or("backup_invalid")?;
    for key in ["workspaceAliases", "archivedWorkspaces", "workspaceGroupAssignments"] {
        settings.remove(key);
        if let Some(value) = current.settings.get(key) { settings.insert(key.into(), value.clone()); }
    }
    let mut groups = settings.get("workspaceGroups").and_then(Value::as_array).cloned().unwrap_or_default();
    if let Some(existing) = current.settings.get("workspaceGroups").and_then(Value::as_array) {
        for group in existing {
            if !groups.iter().any(|other| other.get("id") == group.get("id")) { groups.push(group.clone()); }
        }
    }
    settings.insert("workspaceGroups".into(), Value::Array(groups));
    settings.insert("webRelayOn".into(), Value::Bool(false));
    warnings.push(Warning { code: "relay_disabled", field: None });
    settings.insert("webAuthKey".into(), if settings.get("webAuthEnabled").and_then(Value::as_bool) == Some(true) {
        Value::String(crate::settings::generate_pair_key())
    } else { Value::Null });
    warnings.push(Warning { code: "pairing_reset", field: None });
    let path_keys: Vec<String> = settings.keys().filter(|key| key.ends_with("Bin") || *key == "terminalShellPath").cloned().collect();
    for key in path_keys {
        if let Some(value) = settings.get(&key).and_then(Value::as_str).filter(|value| !value.is_empty()) {
            if crate::settings::validate_bin_override(value).is_err() {
                settings.remove(&key);
                warnings.push(Warning { code: "path_skipped", field: Some(key) });
            }
        }
    }
    if snapshot.preferences.contains_key("hzkcode.permissionPref:v2") {
        warnings.push(Warning { code: "permission_mode", field: None });
    }
    warnings.push(Warning { code: "machine_paths_review", field: None });
    filter_target_prompts(&mut snapshot, current, std::env::consts::OS, &mut warnings);
    validate_snapshot(&snapshot)?;
    Ok((snapshot, warnings))
}

fn prepare(root: &Path, archive: &[u8], password: &str) -> Result<(Pending, Preview), String> {
    let (plaintext, recovery_key) = crypto::open(archive, password)?;
    let snapshot: Snapshot = serde_json::from_slice(&plaintext).map_err(|_| "backup_invalid")?;
    validate_snapshot(&snapshot)?;
    let current = collect(root, Preferences::new())?;
    let original_digest = digest(&current);
    let (snapshot, warnings) = prepare_import(snapshot, &current)?;
    let token = uuid::Uuid::new_v4().to_string();
    let preview = Preview {
        token: token.clone(), app_version: snapshot.app_version.clone(), exported_at: snapshot.exported_at.clone(),
        platform: snapshot.platform.clone(), provider_count: snapshot.config.pointer("/claude/providers").and_then(Value::as_object).map_or(0, |p| p.len()),
        agent_count: snapshot.agents.get("agents").and_then(Value::as_array).map_or(0, |a| a.len()),
        prompt_count: snapshot.prompts.len(), preference_count: snapshot.preferences.len(), warnings: warnings.clone(),
    };
    Ok((Pending { token, created: Instant::now(), snapshot, original_digest, recovery_key, warnings }, preview))
}

fn import_prepared(root: &Path, pending: &Pending, preferences: Preferences) -> Result<ImportResult, String> {
    if pending.created.elapsed() > PREVIEW_TTL { return Err("backup_stale".into()); }
    let current = collect(root, preferences)?;
    if digest(&current) != pending.original_digest { return Err("backup_stale".into()); }
    let backup_dir = root.join("config-backups");
    storage::create_directory(&backup_dir)?;
    let backup_path = backup_dir.join(format!("before-import-{}-{}.hzkbackup", now_millis(), uuid::Uuid::new_v4()));
    let backup = pending.recovery_key.seal(&serde_json::to_vec(&current).map_err(|_| "backup_invalid")?)?;
    storage::write_new(&backup_path, &backup)?;
    let snapshot = &pending.snapshot;
    let mut files = BTreeMap::new();
    for (name, value) in [("settings.json", &snapshot.settings), ("config.json", &snapshot.config), ("agents.json", &snapshot.agents)] {
        files.insert(root.join(name), serde_json::to_vec_pretty(value).map_err(|_| "backup_invalid")?);
    }
    if !snapshot.prompts.is_empty() {
        storage::create_directory(&root.join("prompts"))?;
        for (name, content) in &snapshot.prompts { files.insert(root.join("prompts").join(name), content.as_bytes().to_vec()); }
    }
    storage::apply_files(&files)?;
    Ok(ImportResult { backup_path: backup_path.to_string_lossy().into_owned(), preferences: snapshot.preferences.clone(), warnings: pending.warnings.clone() })
}

fn check_archive_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute() || !path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("hzkbackup")) {
        return Err("backup_path_invalid".into());
    }
    Ok(())
}

fn check_native<R: tauri::Runtime>(app: &tauri::AppHandle<R>, window: &tauri::WebviewWindow<R>, importing: bool) -> Result<(), String> {
    if window.label() != "main" { return Err("backup_desktop_only".into()); }
    ensure_writable()?;
    if importing {
        let state = app.state::<crate::AppState>();
        if app.webview_windows().len() != 1 || !state.processes.0.lock().map_err(|_| "backup_busy")?.is_empty()
            || !state.terminals.try_lock().map_err(|_| "backup_busy")?.is_empty()
            || state.web.bridge_target().is_some() || state.relay.is_running() {
            return Err("backup_busy".into());
        }
    }
    Ok(())
}

fn with_config_lock<R: tauri::Runtime, T>(app: &tauri::AppHandle<R>, operation: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let store = app.state::<crate::config::ConfigStore>();
    let _config = store.0.lock().map_err(|_| "backup_busy")?;
    let _settings = crate::settings::settings_write_lock();
    let _agents = crate::agents::agents_write_lock();
    let _prompts = crate::prompts::prompts_write_lock();
    ensure_writable()?;
    operation()
}

#[tauri::command]
pub async fn config_backup_export<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, window: tauri::WebviewWindow<R>, path: String,
    password: String, preferences: Preferences,
) -> Result<ExportResult, String> {
    check_native(&app, &window, false)?;
    tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::PathBuf::from(path);
        check_archive_path(&path)?;
        let snapshot = with_config_lock(&app, || collect(&crate::paths::app_home(), preferences))?;
        let archive = crypto::BackupKey::new(&password)?.seal(&serde_json::to_vec(&snapshot).map_err(|_| "backup_invalid")?)?;
        storage::write_new(&path, &archive)?;
        Ok(ExportResult { path: path.to_string_lossy().into_owned() })
    }).await.map_err(|_| "backup_io")?
}

#[tauri::command]
pub async fn config_backup_preview<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, window: tauri::WebviewWindow<R>, path: String, password: String,
) -> Result<Preview, String> {
    check_native(&app, &window, true)?;
    let preview = tauri::async_runtime::spawn_blocking(move || {
        let path = std::path::PathBuf::from(path);
        check_archive_path(&path)?;
        let archive = storage::read_optional(&path, crypto::MAX_ARCHIVE)?.ok_or("backup_io")?;
        let (pending, preview) = with_config_lock(&app, || prepare(&crate::paths::app_home(), &archive, &password))?;
        *PENDING.lock() = Some(pending);
        Ok::<_, String>(preview)
    }).await.map_err(|_| "backup_io")??;
    let token = preview.token.clone();
    tauri::async_runtime::spawn(async move {
        tokio::time::sleep(PREVIEW_TTL).await;
        let mut pending = PENDING.lock();
        if pending.as_ref().is_some_and(|value| value.token == token) { pending.take(); }
    });
    Ok(preview)
}

#[tauri::command]
pub async fn config_backup_import<R: tauri::Runtime>(
    app: tauri::AppHandle<R>, window: tauri::WebviewWindow<R>, token: String, current_preferences: Preferences,
) -> Result<ImportResult, String> {
    check_native(&app, &window, true)?;
    tauri::async_runtime::spawn_blocking(move || {
        with_config_lock(&app, || {
            check_native(&app, &window, true)?;
            let mut cache = PENDING.lock();
            let pending = cache.as_ref().filter(|pending| pending.token == token).ok_or("backup_stale")?;
            let result = import_prepared(&crate::paths::app_home(), pending, current_preferences)?;
            RESTART_PENDING.store(true, Ordering::Release);
            cache.take();
            Ok(result)
        })
    }).await.map_err(|_| "backup_io")?
}

#[cfg(test)]
mod tests;

