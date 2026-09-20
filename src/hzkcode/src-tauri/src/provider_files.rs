//! Channel env injection, official-file editing, and safe retirement of old
//! file-materialization backups. Switches never materialize a new channel.
//!
//! Switching a channel stores the id in our config (`section.current`) and
//! applies process-scoped channel env/config to that send. The CLI's native
//! file (`~/.hzkcode/settings.json`) stays the official configuration:
//! concurrent sessions can run different channels without clobbering each
//! other, and `--resume` still finds history in the CLI's real home.
//!
//! Legacy renderers identify old managed content before one-time restoration.
//! Unknown edits stop migration; the original and pre-migration files survive.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use toml_edit::DocumentMut;

use crate::config::{DISABLED_PROVIDER_ID, LEGACY_LOCAL_CONFIG_TOML_ID, LOCAL_PROVIDER_ID};

/// Legacy writer retained only to build migration regression fixtures.
/// `provider` is `None` for the pseudo ids (官方配置 / 停用).
#[cfg(test)]
fn apply(engine: &str, id: &str, provider: Option<&Value>) -> Result<(), String> {
    if id == DISABLED_PROVIDER_ID {
        // 停用 gates sending only; the CLI's files stay as they are.
        return Ok(());
    }
    let targets = targets(engine);
    if id == LOCAL_PROVIDER_ID || id == LEGACY_LOCAL_CONFIG_TOML_ID || id.is_empty() {
        for target in &targets {
            restore(target)?;
        }
        return Ok(());
    }
    let provider = provider.ok_or_else(|| format!("provider {id} not found for {engine}"))?;
    match engine {
        "claude" => apply_claude(&targets[0], provider),
        // Display-only engines declare no file target.
        _ => Ok(()),
    }
}

// ── File targets & backups ──────────────────────────────────────────────────

struct Target {
    path: PathBuf,
    backup: PathBuf,
}

/// Native files exposed by the official editor, with legacy backup paths.
fn targets(engine: &str) -> Vec<Target> {
    let home = |env_key: Option<&str>, default: &str| crate::engine::engine_home(env_key, default);
    let backup_dir = crate::paths::app_home()
        .join("provider-backups")
        .join(engine);
    let target = |path: PathBuf, name: &str| Target {
        path,
        backup: backup_dir.join(name),
    };
    match engine {
        "claude" => vec![target(
            home(Some("HZKCODE_CONFIG_DIR"), ".hzkcode").join("settings.json"),
            "settings.json",
        )],
        _ => Vec::new(),
    }
}

fn absent_marker(backup: &Path) -> PathBuf {
    backup.with_extension("absent")
}

/// Retire the old file-materialization state before its provider records can
/// change. Only an identified legacy rendering is restored. All originals
/// and the pre-migration live files remain available for recovery.
pub(crate) fn migrate_legacy(
    engine: &str,
    section: &crate::config::ProviderSection,
) -> Result<(), String> {
    static LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());
    let _guard = LOCK.lock().map_err(|e| e.to_string())?;
    migrate_targets(engine, section, &targets(engine))
}

fn read_optional(path: &Path) -> Result<Option<String>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => Ok(Some(text)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("read {}: {e}", path.display())),
    }
}

fn migrate_targets(
    engine: &str,
    section: &crate::config::ProviderSection,
    targets: &[Target],
) -> Result<(), String> {
    let mut plans = Vec::new();
    for target in targets {
        let marker = target.backup.with_extension("migrated");
        // Once retired, this backup must never be applied to a subsequently
        // selected CLI home. The marker keeps the old path for recovery only.
        if read_optional(&marker)?.is_some() {
            continue;
        }
        let original = read_optional(&target.backup)?;
        if original.is_none() && !absent_marker(&target.backup).exists() {
            continue;
        }
        let live = read_optional(&target.path)?;
        let mut restore_original = false;
        if live != original {
            let base = original
                .as_deref()
                .unwrap_or(if file_format(&target.path) == "json" {
                    "{}"
                } else {
                    ""
                });
            for provider in section.providers.values() {
                let rendered = match engine {
                    "claude" => render_claude(base, provider),
                    _ => continue,
                };
                if let (Some(live), Ok(expected)) = (live.as_deref(), rendered) {
                    // JSON property order was not stable in the old writer.
                    // For TOML require exact bytes, including user comments.
                    restore_original = if file_format(&target.path) == "json" {
                        let actual = serde_json::from_str::<Value>(live);
                        let expected = serde_json::from_str::<Value>(&expected);
                        matches!((actual, expected), (Ok(a), Ok(b)) if a == b)
                    } else {
                        live == expected
                    };
                }
                if restore_original {
                    break;
                }
            }
            let current = if section.current.as_deref() == Some(DISABLED_PROVIDER_ID) {
                section.disabled_from.as_deref()
            } else {
                section.current.as_deref()
            };
            let official = matches!(
                current,
                None | Some("") | Some(LOCAL_PROVIDER_ID) | Some(LEGACY_LOCAL_CONFIG_TOML_ID)
            );
            if !restore_original && !official {
                return Err(format!(
                    "HZKCODE_PROVIDER_MIGRATION_CONFLICT:{}",
                    serde_json::json!({
                        "path": target.path.to_string_lossy(),
                        "backup": target.backup.to_string_lossy(),
                    })
                ));
            }
        }
        plans.push((target, marker, live, original, restore_original));
    }
    // Validate the whole engine before any restore.
    for (target, marker, live, original, restore_original) in plans {
        if read_optional(&target.path)? != live {
            return Err(format!(
                "{} changed during provider migration; retry",
                target.path.display()
            ));
        }
        if restore_original {
            if let Some(live) = live.as_deref() {
                let archive = target.backup.with_extension("pre-migration");
                // Never overwrite an earlier recovery copy after a failed run.
                if !archive.exists() {
                    crate::settings::atomic_write(&archive, live)?;
                }
            }
            if let Some(original) = original.as_deref() {
                crate::settings::atomic_write(&target.path, original)?;
            } else if target.path.exists() {
                std::fs::remove_file(&target.path)
                    .map_err(|e| format!("remove {}: {e}", target.path.display()))?;
            }
        }
        crate::settings::atomic_write(&marker, &target.path.to_string_lossy())?;
    }
    Ok(())
}
/// Native config files of `engine` (the 官方配置 editor's pane list). Empty for
/// engines with no native config file.
#[tauri::command]
pub fn provider_file_paths(engine: String) -> Vec<String> {
    targets(&engine)
        .iter()
        .map(|t| t.path.display().to_string())
        .collect()
}

// ── 官方配置 editing ────────────────────────────────────────────────────────

/// One editable file of an engine's 官方配置 (the CLI's own config), one pane
/// of the edit dialog.
#[derive(Debug, Clone, serde::Serialize)]
pub struct OfficialConfigFile {
    /// Absolute path — the pane label, and the write-back key.
    pub path: String,
    /// Editor language mode, derived from the extension.
    pub format: &'static str,
    /// Live file content; "" when absent (`exists` distinguishes).
    pub content: String,
    pub exists: bool,
}

/// Editable draft of one official file, matched back to a declared target by
/// exact path so the client can never name an arbitrary file.
#[derive(Debug, Clone, serde::Deserialize)]
pub struct OfficialConfigDraft {
    pub path: String,
    pub content: String,
}

fn file_format(path: &Path) -> &'static str {
    match path.extension().and_then(|e| e.to_str()) {
        Some("toml") => "toml",
        _ => "json",
    }
}

/// Files of the engine's 官方配置, in pane order.
#[tauri::command]
pub fn official_config_read(engine: String) -> Result<Vec<OfficialConfigFile>, String> {
    let config = crate::config::read_config()?;
    let section = config
        .section(&engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    migrate_legacy(&engine, section)?;
    targets(&engine)
        .iter()
        .map(|t| {
            let content = match std::fs::read_to_string(&t.path) {
                Ok(content) => Ok(content),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
                Err(e) => Err(format!("read {}: {e}", t.path.display())),
            }?;
            Ok(OfficialConfigFile {
                path: t.path.display().to_string(),
                format: file_format(&t.path),
                content,
                exists: t.path.exists(),
            })
        })
        .collect()
}

/// Overwrite 官方配置 files. Native files stay the official configuration
/// (channels inject env at spawn and never rewrite them), so editing is
/// always allowed. Everything is validated before any write.
#[tauri::command]
pub fn official_config_write(
    store: tauri::State<'_, crate::config::ConfigStore>,
    engine: String,
    files: Vec<OfficialConfigDraft>,
) -> Result<(), String> {
    let _guard = store.0.lock().map_err(|e| e.to_string())?;
    let config = crate::config::read_config()?;
    let section = config
        .section(&engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    let targets = targets(&engine);
    if targets.is_empty() {
        return Err(format!("engine {engine} has no editable official config"));
    }
    for draft in &files {
        let target = targets
            .iter()
            .find(|t| t.path.display().to_string() == draft.path)
            .ok_or_else(|| format!("{} is not an official config file of {engine}", draft.path))?;
        validate_official(target, &draft.content)?;
    }
    migrate_legacy(&engine, section)?;
    for draft in &files {
        let target = targets
            .iter()
            .find(|t| t.path.display().to_string() == draft.path)
            .expect("validated above");
        write_official(target, &draft.content)?;
    }
    Ok(())
}

fn validate_official(target: &Target, content: &str) -> Result<(), String> {
    match file_format(&target.path) {
        "toml" => {
            content
                .parse::<DocumentMut>()
                .map_err(|e| format!("invalid TOML in {}: {e}", target.path.display()))?;
        }
        _ => {
            let value: Value = serde_json::from_str(content)
                .map_err(|e| format!("invalid JSON in {}: {e}", target.path.display()))?;
            if !value.is_object() {
                return Err(format!("{} must be a JSON object", target.path.display()));
            }
        }
    }
    Ok(())
}

fn write_official(target: &Target, content: &str) -> Result<(), String> {
    if let Some(dir) = target.path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    }
    // Legacy snapshots are recovery material, never an editor write target.
    crate::settings::atomic_write(&target.path, content)
}

/// Snapshot the file before the first managed write. An existing backup wins
/// (it is the pre-hzkcode original); a missing file is recorded with an
/// `.absent` marker so restore can remove what we created.
#[cfg(test)]
fn snapshot_once(target: &Target) -> Result<(), String> {
    if target.backup.exists() || absent_marker(&target.backup).exists() {
        return Ok(());
    }
    let dir = target
        .backup
        .parent()
        .ok_or_else(|| "backup path has no parent".to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| format!("mkdir {}: {e}", dir.display()))?;
    if target.path.exists() {
        std::fs::copy(&target.path, &target.backup)
            .map_err(|e| format!("backup {}: {e}", target.path.display()))?;
    } else {
        std::fs::write(absent_marker(&target.backup), "")
            .map_err(|e| format!("mark {} absent: {e}", target.path.display()))?;
    }
    Ok(())
}

/// 官方配置: put the pre-hzkcode file back. No backup and no marker means we
/// never managed the file — leave it alone.
#[cfg(test)]
fn restore(target: &Target) -> Result<(), String> {
    if target.backup.exists() {
        let content = std::fs::read_to_string(&target.backup)
            .map_err(|e| format!("read backup {}: {e}", target.backup.display()))?;
        crate::settings::atomic_write(&target.path, &content)?;
    } else if absent_marker(&target.backup).exists() && target.path.exists() {
        std::fs::remove_file(&target.path)
            .map_err(|e| format!("remove {}: {e}", target.path.display()))?;
    }
    Ok(())
}

/// Content to patch: the pristine backup when we already manage the file
/// (managed keys never accumulate), else the live file, else `default`.
#[cfg(test)]
fn base_content(target: &Target, default: &str) -> Result<String, String> {
    let source = if target.backup.exists() {
        &target.backup
    } else {
        &target.path
    };
    match std::fs::read_to_string(source) {
        Ok(content) => Ok(content),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(default.to_string()),
        Err(e) => Err(format!("read {}: {e}", source.display())),
    }
}

// ── Channel value extraction ────────────────────────────────────────────────

/// Loader/hook/hijack env keys a stored channel must never write into a
/// CLI's environment: they hand code execution or traffic interception to
/// whoever wrote the config file. Prefix families (DYLD_/LD_, GIT_CONFIG_KEY/
/// VALUE) are matched by prefix, the rest exactly; comparison is
/// case-insensitive because launchd/cmd env casing varies.
///
/// Beyond loader hooks: PATH hijacks the CLI's spawned git/rg children;
/// the proxy + NODE_EXTRA_CA_CERTS combo MITMs the CLI's HTTPS traffic;
/// GIT_CONFIG_* / GIT_TEMPLATE_DIR / GIT_EXEC_PATH turn the app's own git
/// calls into code execution; EDITOR/GIT_PAGER run when the CLI pages or
/// opens an editor.
fn is_blocked_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.starts_with("DYLD_")
        || upper.starts_with("LD_")
        || upper.starts_with("GIT_CONFIG_KEY_")
        || upper.starts_with("GIT_CONFIG_VALUE_")
    {
        return true;
    }
    matches!(
        upper.as_str(),
        "NODE_OPTIONS"
            | "NODE_REPL_EXTERNAL_MODULE"
            | "NODE_EXTRA_CA_CERTS"
            | "BASH_ENV"
            | "ENV"
            | "SHELLOPTS"
            | "PYTHONSTARTUP"
            | "PYTHONINSPECT"
            | "PYTHONPATH"
            | "RUBYOPT"
            | "PERL5OPT"
            | "PATH"
            | "HTTP_PROXY"
            | "HTTPS_PROXY"
            | "ALL_PROXY"
            | "GIT_SSH"
            | "GIT_SSH_COMMAND"
            | "GIT_CONFIG_GLOBAL"
            | "GIT_CONFIG_SYSTEM"
            | "GIT_CONFIG_COUNT"
            | "GIT_TEMPLATE_DIR"
            | "GIT_EXEC_PATH"
            | "SSH_ASKPASS"
            | "PROMPT_COMMAND"
            | "EDITOR"
            | "GIT_PAGER"
            | "PAGER"
            | "IFS"
    )
}

/// Static baseUrl/apiKey/model -> env var names: the hzkcode CLI's own
/// variables. The upstream spawnings are deliberately absent — the CLI no
/// longer reads them, so the app speaks one convention only. A channel carries
/// its fields either as flat keys or under these names in a raw env map.
fn env_names(engine: &str) -> [(&'static str, &'static [&'static str]); 3] {
    match engine {
        "claude" => [
            ("baseUrl", &["HZKCODE_BASE_URL"]),
            ("apiKey", &["HZKCODE_API_KEY"]),
            ("model", &["HZKCODE_MODEL"]),
        ],
        _ => [("baseUrl", &[]), ("apiKey", &[]), ("model", &[])],
    }
}

/// Provider/auth variables the hzkcode CLI reads. An inherited value — a shell
/// that exported credentials before launching the app — is dropped, so a
/// session's endpoint, credential and model come from the app's channel
/// settings instead of whoever started the app. Feature variables
/// (`HZKCODE_OSS_*`, `HZKCODE_FEISHU_*`, …) are not provider config and pass
/// through untouched.
pub(crate) fn is_provider_env_key(key: &str) -> bool {
    let upper = key.to_ascii_uppercase();
    if upper.starts_with("HZKCODE_ANTHROPIC_")
        || upper.starts_with("HZKCODE_DEFAULT_")
        || upper.starts_with("HZKCODE_BEDROCK_")
        || upper.starts_with("HZKCODE_VERTEX_")
        || upper.starts_with("HZKCODE_FOUNDRY_")
        || upper.starts_with("HZKCODE_GEMINI_")
        || upper.starts_with("HZKCODE_USE_")
        || upper.starts_with("HZKCODE_SKIP_")
    {
        return true;
    }
    matches!(
        upper.as_str(),
        "HZKCODE_BASE_URL"
            | "HZKCODE_BASE_URL_ENDPOINT"
            | "HZKCODE_API_KEY"
            | "HZKCODE_AUTH_TOKEN"
            | "HZKCODE_OAUTH_TOKEN"
            | "HZKCODE_MODEL"
            | "HZKCODE_SMALL_FAST_MODEL"
            | "HZKCODE_SUBAGENT_MODEL"
            | "HZKCODE_PROVIDER"
            | "HZKCODE_PROVIDER_MANAGED_BY_HOST"
            | "HZKCODE_AUTH_MODE"
            | "HZKCODE_API_MODE"
            | "HZKCODE_DISABLE_IMAGE_INPUT"
    )
}

fn non_empty_str(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// A channel's raw env maps: cc-switch's `settingsConfig.env` first (the
/// legacy claude/grok shape), then the flat `env` escape hatch.
fn channel_env_maps(
    provider: &Value,
) -> impl Iterator<Item = &serde_json::Map<String, Value>> + '_ {
    [
        provider.get("settingsConfig").and_then(|s| s.get("env")),
        provider.get("env"),
    ]
    .into_iter()
    .flatten()
    .filter_map(Value::as_object)
}

/// One convention field (baseUrl/apiKey/model): the flat field wins, then any
/// of the field's env names inside the raw env maps.
fn channel_field(engine: &str, provider: &Value, field: &str) -> Option<String> {
    if let Some(v) = non_empty_str(provider.get(field)) {
        return Some(v);
    }
    let (_, names) = env_names(engine).into_iter().find(|(f, _)| *f == field)?;
    channel_env_maps(provider)
        .find_map(|map| names.iter().find_map(|name| non_empty_str(map.get(*name))))
}

/// Channel env for spawn injection (and leftover file-materialize helpers):
/// raw env maps first (blocked keys and empties refused), convention fields
/// only where raw env has no value — raw env wins.
pub(crate) fn channel_env(
    engine: &str,
    provider: &Value,
) -> Result<HashMap<String, String>, String> {
    let mut out: HashMap<String, String> = HashMap::new();
    let mut seen = HashSet::new();
    for map in channel_env_maps(provider) {
        for (key, val) in map {
            if seen.contains(key) || is_blocked_env_key(key) {
                if is_blocked_env_key(key) {
                    eprintln!("[provider_files] refusing to inject blocked env key: {key}");
                }
                continue;
            }
            let scalar = match val {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            if scalar.trim().is_empty() {
                continue;
            }
            seen.insert(key.clone());
            out.insert(key.clone(), scalar);
        }
    }
    for (field, names) in env_names(engine) {
        let Some(value) = channel_field(engine, provider, field) else {
            continue;
        };
        for name in names {
            // A raw env map may already carry one spelling: keep its value and
            // fill in the others, so every CLI family sees the same endpoint.
            out.entry((*name).to_string())
                .or_insert_with(|| value.clone());
        }
    }
    Ok(out)
}

// ── claude: settings.json ───────────────────────────────────────────────────

#[cfg(test)]
fn apply_claude(target: &Target, provider: &Value) -> Result<(), String> {
    snapshot_once(target)?;
    let base = base_content(target, "{}")?;
    crate::settings::atomic_write(&target.path, &render_claude(&base, provider)?)
}

fn render_claude(base: &str, provider: &Value) -> Result<String, String> {
    let mut doc: Value =
        serde_json::from_str(base).map_err(|_| "Invalid legacy Claude settings JSON")?;
    if !doc.is_object() {
        return Err("Legacy Claude settings root is not a JSON object".into());
    }
    // Provider-selection keys in the base are residue from whatever managed
    // the file before hzkcode (another provider switcher captured in the
    // snapshot). A channel owns them outright: strip them so a polluted
    // snapshot can't resurrect foreign endpoints/credentials/model mappings
    // on every apply. The 官方配置 restore path is untouched — it still
    // returns the snapshot byte-for-byte.
    if let Some(env) = doc.get_mut("env").and_then(Value::as_object_mut) {
        for key in CLAUDE_MANAGED_ENV_KEYS {
            env.remove(*key);
        }
        if env.is_empty() {
            doc.as_object_mut().unwrap().remove("env");
        }
    }
    // cc-switch channels carry a full settingsConfig: merge its top-level
    // keys (env deep-merged below), keeping the user's unrelated settings.
    if let Some(sc) = provider.get("settingsConfig").and_then(Value::as_object) {
        for (key, val) in sc {
            if key != "env" {
                doc[key] = val.clone();
            }
        }
    }
    let env = channel_env("claude", provider)?;
    if !env.is_empty() {
        if !doc.get("env").is_some_and(Value::is_object) {
            doc["env"] = Value::Object(serde_json::Map::new());
        }
        for (key, val) in env {
            doc["env"][key] = Value::String(val);
        }
    }
    serde_json::to_string_pretty(&doc).map_err(|e| e.to_string())
}

/// Provider-selection env keys a claude channel owns outright once hzkcode
/// manages settings.json: endpoint, credentials, and model routing.
const CLAUDE_MANAGED_ENV_KEYS: &[&str] = &[
    "HZKCODE_BASE_URL",
    "HZKCODE_BASE_URL_ENDPOINT",
    "HZKCODE_API_KEY",
    "HZKCODE_ANTHROPIC_AUTH_TOKEN",
    "HZKCODE_AUTH_TOKEN",
    "HZKCODE_MODEL",
    "HZKCODE_SMALL_FAST_MODEL",
    "HZKCODE_DEFAULT_HIGH_MODEL",
    "HZKCODE_DEFAULT_MID_MODEL",
    "HZKCODE_DEFAULT_LOW_MODEL",
    "HZKCODE_PROVIDER",
    "HZKCODE_AUTH_MODE",
    "HZKCODE_API_MODE",
];

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU32, Ordering};

    fn legacy_section(provider: Value) -> crate::config::ProviderSection {
        crate::config::ProviderSection {
            providers: serde_json::Map::from_iter([("channel".into(), provider)]),
            current: Some("channel".into()),
            disabled_from: None,
        }
    }

    #[test]
    fn legacy_migration_restores_once_and_preserves_both_recovery_files() {
        let provider = serde_json::json!({"baseUrl":"https://relay.example", "apiKey":"test-key", "model":"test-model"});
        let section = legacy_section(provider.clone());
        let original = "{\n  \"permissions\": {\"allow\": []}\n}\n";
        let (dir, target) = fixture("migration-claude", "settings.json");
        std::fs::write(&target.path, original).unwrap();
        apply_claude(&target, &provider).unwrap();
        let managed = std::fs::read_to_string(&target.path).unwrap();
        migrate_targets("claude", &section, std::slice::from_ref(&target)).unwrap();
        assert_eq!(std::fs::read_to_string(&target.path).unwrap(), original);
        assert_eq!(std::fs::read_to_string(&target.backup).unwrap(), original);
        assert_eq!(
            std::fs::read_to_string(target.backup.with_extension("pre-migration")).unwrap(),
            managed
        );
        let edited = format!("{original}\n");
        write_official(&target, &edited).unwrap();
        migrate_targets("claude", &section, std::slice::from_ref(&target)).unwrap();
        assert_eq!(std::fs::read_to_string(&target.path).unwrap(), edited);
        assert_eq!(std::fs::read_to_string(&target.backup).unwrap(), original);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn legacy_migration_handles_absent_original_and_disabled_channel() {
        let (dir, target) = fixture("migration-absent", "settings.json");
        let provider = serde_json::json!({"apiKey":"test-key"});
        apply_claude(&target, &provider).unwrap();
        let mut section = legacy_section(provider);
        section.current = Some(DISABLED_PROVIDER_ID.into());
        section.disabled_from = Some("channel".into());
        migrate_targets("claude", &section, std::slice::from_ref(&target)).unwrap();
        assert!(!target.path.exists());
        assert!(absent_marker(&target.backup).exists());
        assert!(target.backup.with_extension("pre-migration").exists());
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn retired_backup_never_restores_into_a_different_cli_home() {
        let (dir, target) = fixture("migration-new-home", "settings.json");
        let provider = serde_json::json!({"apiKey":"test-key"});
        apply_claude(&target, &provider).unwrap();
        let managed = std::fs::read_to_string(&target.path).unwrap();
        let section = legacy_section(provider);
        migrate_targets("claude", &section, std::slice::from_ref(&target)).unwrap();
        let other = Target {
            path: dir.join("other-settings.json"),
            backup: target.backup,
        };
        std::fs::write(&other.path, &managed).unwrap();
        migrate_targets("claude", &section, std::slice::from_ref(&other)).unwrap();
        assert_eq!(std::fs::read_to_string(&other.path).unwrap(), managed);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn channel_env_raw_wins_convention_and_refuses_blocked_keys() {
        let p = serde_json::json!({
            "baseUrl": "https://flat.example",
            "apiKey": "sk-flat",
            "model": "flat-model",
            "settingsConfig": { "env": { "HZKCODE_BASE_URL": "https://raw.example" } },
            "env": { "HZKCODE_API_KEY": "sk-raw" },
        });
        let env = channel_env("claude", &p).unwrap();
        assert_eq!(
            env.get("HZKCODE_BASE_URL").map(String::as_str),
            Some("https://raw.example")
        );
        assert_eq!(env.get("HZKCODE_API_KEY").map(String::as_str), Some("sk-raw"));
        assert_eq!(
            env.get("HZKCODE_MODEL").map(String::as_str),
            Some("flat-model")
        );

        let blocked = serde_json::json!({ "env": {
            "NODE_OPTIONS": "--require ./x.js",
            "PATH": "/tmp/evil-bin:/usr/bin",
            "HTTPS_PROXY": "http://mitm.example:8080",
            "NODE_EXTRA_CA_CERTS": "/tmp/evil-ca.pem",
            "GIT_CONFIG_GLOBAL": "/tmp/evil-gitconfig",
            "GIT_CONFIG_KEY_0": "core.hooksPath",
            "EDITOR": "/tmp/evil-editor",
            "SAFE": "1"
        } });
        let env = channel_env("claude", &blocked).unwrap();
        for key in [
            "NODE_OPTIONS",
            "PATH",
            "HTTPS_PROXY",
            "NODE_EXTRA_CA_CERTS",
            "GIT_CONFIG_GLOBAL",
            "GIT_CONFIG_KEY_0",
            "EDITOR",
        ] {
            assert!(!env.contains_key(key), "{key} must never be injected");
        }
        assert_eq!(env.get("SAFE").map(String::as_str), Some("1"));
    }

    #[test]
    fn validate_official_rejects_malformed_content() {
        let (_, json_target) = fixture("validate-json", "settings.json");
        let (_, toml_target) = fixture("validate-toml", "config.toml");
        assert!(validate_official(&json_target, r#"{"env":{}}"#).is_ok());
        assert!(validate_official(&json_target, "{not json").is_err());
        // Scalars/arrays parse as JSON but are not a usable settings file.
        assert!(validate_official(&json_target, "[1,2]").is_err());
        assert!(validate_official(&toml_target, "[providers]\nx=1").is_ok());
        assert!(validate_official(&toml_target, "key = = 1").is_err());
    }

    #[test]
    fn write_official_preserves_legacy_snapshot() {
        let (dir, target) = fixture("official-sync", "settings.json");
        std::fs::create_dir_all(target.backup.parent().unwrap()).unwrap();
        std::fs::write(&target.path, r#"{"a":1}"#).unwrap();
        std::fs::write(&target.backup, r#"{"a":1}"#).unwrap();
        write_official(&target, r#"{"a":2}"#).unwrap();
        assert_eq!(std::fs::read_to_string(&target.path).unwrap(), r#"{"a":2}"#);
        assert_eq!(
            std::fs::read_to_string(&target.backup).unwrap(),
            r#"{"a":1}"#
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn write_official_preserves_legacy_absent_marker() {
        let (dir, target) = fixture("official-absent", "settings.json");
        std::fs::create_dir_all(target.backup.parent().unwrap()).unwrap();
        std::fs::write(absent_marker(&target.backup), "").unwrap();
        write_official(&target, r#"{"b":1}"#).unwrap();
        assert!(absent_marker(&target.backup).exists());
        assert!(!target.backup.exists());
        assert_eq!(std::fs::read_to_string(&target.path).unwrap(), r#"{"b":1}"#);
        let _ = std::fs::remove_dir_all(&dir);
    }

    static SEQ: AtomicU32 = AtomicU32::new(0);

    /// Isolated (target, backup) pair in a fresh temp dir.
    fn fixture(name: &str, file: &str) -> (PathBuf, Target) {
        let dir = std::env::temp_dir().join(format!(
            "hzkcode-provider-files-{name}-{}-{}",
            std::process::id(),
            SEQ.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&dir).unwrap();
        (
            dir.clone(),
            Target {
                path: dir.join(file),
                backup: dir.join("backups").join(file),
            },
        )
    }

    fn channel(fields: &[(&str, &str)]) -> Value {
        fields
            .iter()
            .map(|(k, v)| (k.to_string(), Value::String(v.to_string())))
            .collect::<serde_json::Map<String, Value>>()
            .into()
    }

    #[test]
    fn claude_merges_env_and_preserves_unrelated_settings() {
        let (dir, target) = fixture("claude", "settings.json");
        std::fs::write(
            &target.path,
            r#"{"model":"opus","hooks":{"Stop":[]},"env":{"USER_KEY":"keep"}}"#,
        )
        .unwrap();
        let p = channel(&[
            ("baseUrl", "https://a.example"),
            ("apiKey", "sk-a"),
            ("model", "m-a"),
        ]);
        apply_claude(&target, &p).unwrap();
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&target.path).unwrap()).unwrap();
        assert_eq!(out["model"], "opus");
        assert!(out["hooks"].is_object());
        assert_eq!(out["env"]["USER_KEY"], "keep");
        assert_eq!(out["env"]["HZKCODE_BASE_URL"], "https://a.example");
        assert_eq!(out["env"]["HZKCODE_API_KEY"], "sk-a");
        assert_eq!(out["env"]["HZKCODE_MODEL"], "m-a");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_second_switch_drops_first_channels_keys() {
        let (dir, target) = fixture("claude-switch", "settings.json");
        std::fs::write(&target.path, r#"{"env":{"USER_KEY":"keep"}}"#).unwrap();
        let a = channel(&[("baseUrl", "https://a.example")]);
        let b = channel(&[("baseUrl", "https://b.example"), ("model", "m-b")]);
        apply_claude(&target, &a).unwrap();
        apply_claude(&target, &b).unwrap();
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&target.path).unwrap()).unwrap();
        assert_eq!(out["env"]["HZKCODE_BASE_URL"], "https://b.example");
        assert_eq!(out["env"]["HZKCODE_MODEL"], "m-b");
        assert_eq!(out["env"]["USER_KEY"], "keep");
        // A leftover from the first channel must not survive the second.
        let mut c = channel(&[("model", "m-c")]);
        c["settingsConfig"] = serde_json::json!({"env": {"EXTRA_A": "x"}});
        apply_claude(&target, &c).unwrap();
        let d = channel(&[("model", "m-d")]);
        apply_claude(&target, &d).unwrap();
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&target.path).unwrap()).unwrap();
        assert!(out["env"].get("EXTRA_A").is_none());
        assert_eq!(out["env"]["HZKCODE_MODEL"], "m-d");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_snapshot_provider_keys_are_not_resurrected() {
        let (dir, target) = fixture("claude-residue", "settings.json");
        // The pre-hzkcode file was last written by another provider manager:
        // its endpoint/credential/model-routing keys sit in the snapshot.
        let original = r#"{"model":"opus","env":{"USER_KEY":"keep","HZKCODE_BASE_URL":"https://old.example","HZKCODE_API_KEY":"sk-old","HZKCODE_DEFAULT_HIGH_MODEL":"kimi-k3","HZKCODE_DEFAULT_MID_MODEL":"kimi-k3","HZKCODE_DEFAULT_LOW_MODEL":"kimi-k3","HZKCODE_SMALL_FAST_MODEL":"kimi-k3-mini"}}"#;
        std::fs::write(&target.path, original).unwrap();
        let p = channel(&[("baseUrl", "https://a.example"), ("apiKey", "sk-a")]);
        apply_claude(&target, &p).unwrap();
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&target.path).unwrap()).unwrap();
        assert_eq!(out["env"]["USER_KEY"], "keep");
        assert_eq!(out["env"]["HZKCODE_BASE_URL"], "https://a.example");
        assert_eq!(out["env"]["HZKCODE_API_KEY"], "sk-a");
        for key in [
            "HZKCODE_MODEL",
            "HZKCODE_DEFAULT_HIGH_MODEL",
            "HZKCODE_DEFAULT_MID_MODEL",
            "HZKCODE_DEFAULT_LOW_MODEL",
            "HZKCODE_SMALL_FAST_MODEL",
        ] {
            assert!(out["env"].get(key).is_none(), "{key} must not survive");
        }
        // 官方配置 restore still returns the polluted original byte-for-byte.
        restore(&target).unwrap();
        assert_eq!(std::fs::read_to_string(&target.path).unwrap(), original);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_strip_drops_emptied_env_object() {
        let (dir, target) = fixture("claude-strip-empty", "settings.json");
        std::fs::write(&target.path, r#"{"env":{"HZKCODE_MODEL":"m-old"}}"#).unwrap();
        apply_claude(&target, &channel(&[])).unwrap();
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&target.path).unwrap()).unwrap();
        assert!(out.get("env").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn claude_blocked_env_keys_never_written() {
        let (dir, target) = fixture("claude-blocked", "settings.json");
        let mut p = channel(&[]);
        p["env"] = serde_json::json!({"DYLD_INSERT_LIBRARIES": "/evil.dylib", "OK": "1"});
        apply_claude(&target, &p).unwrap();
        let out: Value =
            serde_json::from_str(&std::fs::read_to_string(&target.path).unwrap()).unwrap();
        assert!(out["env"].get("DYLD_INSERT_LIBRARIES").is_none());
        assert_eq!(out["env"]["OK"], "1");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn local_restores_backup_byte_for_byte() {
        let (dir, target) = fixture("restore", "settings.json");
        let original = r#"{"model":"opus","env":{"USER_KEY":"keep"}}"#;
        std::fs::write(&target.path, original).unwrap();
        let p = channel(&[("baseUrl", "https://a.example")]);
        apply_claude(&target, &p).unwrap();
        assert_ne!(std::fs::read_to_string(&target.path).unwrap(), original);
        restore(&target).unwrap();
        assert_eq!(std::fs::read_to_string(&target.path).unwrap(), original);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn restore_removes_file_we_created() {
        let (dir, target) = fixture("restore-absent", "settings.json");
        let p = channel(&[("baseUrl", "https://a.example")]);
        apply_claude(&target, &p).unwrap();
        assert!(target.path.exists());
        restore(&target).unwrap();
        assert!(!target.path.exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn pseudo_ids_touch_nothing() {
        let (dir, _t) = fixture("noop", "settings.json");
        let p = channel(&[("baseUrl", "https://x.example")]);
        apply("claude", DISABLED_PROVIDER_ID, Some(&p)).unwrap();
        assert!(dir.read_dir().unwrap().next().is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
