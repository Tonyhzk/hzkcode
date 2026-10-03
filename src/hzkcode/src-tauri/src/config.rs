use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub const LOCAL_PROVIDER_ID: &str = "__local_settings_json__";
/// Legacy kimi marker from the imported v1 config: same "use the CLI's own
/// config" semantics, different spelling.
pub(crate) const LEGACY_LOCAL_CONFIG_TOML_ID: &str = "__local_config_toml__";
/// Legacy marker from builds that could switch an engine off. Historical
/// configs may still carry it as `current`; it resolves to the official
/// config now, so those configs keep launching without special handling.
pub const DISABLED_PROVIDER_ID: &str = "__disabled__";
pub const ENGINES: [&str; 1] = ["claude"];

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ProviderSection {
    #[serde(default)]
    pub providers: serde_json::Map<String, Value>,
    #[serde(default)]
    pub current: Option<String>,
}

/// Per-engine config sections: the engine id doubles as the serialized key,
/// so the shape stays flat (`{"claude": …}`) while section()/section_mut()
/// dispatch is generated, not hand-written.
macro_rules! engine_sections {
    ($(($field:ident, $id:literal)),* $(,)?) => {
        #[derive(Debug, Clone, Serialize, Deserialize, Default)]
        pub struct CliConfig {
            $(#[serde(default, rename = $id)] pub $field: ProviderSection,)*
            /// Preserve unknown top-level fields from legacy config on import.
            #[serde(flatten)]
            pub extra: HashMap<String, Value>,
        }

        impl CliConfig {
            pub fn section(&self, engine: &str) -> Option<&ProviderSection> {
                match engine {
                    $($id => Some(&self.$field),)*
                    _ => None,
                }
            }

            pub fn section_mut(&mut self, engine: &str) -> Option<&mut ProviderSection> {
                match engine {
                    $($id => Some(&mut self.$field),)*
                    _ => None,
                }
            }
        }
    };
}

engine_sections!(
    (claude, "claude"),
);

#[derive(Default)]
pub struct ConfigStore(pub Mutex<()>);

pub fn read_config() -> Result<CliConfig, String> {
    let path = crate::paths::config_path();
    if !path.exists() {
        return Ok(CliConfig::default());
    }
    let content =
        std::fs::read_to_string(&path).map_err(|e| format!("read {}: {e}", path.display()))?;
    if content.trim().is_empty() {
        return Ok(CliConfig::default());
    }
    serde_json::from_str(&content).map_err(|e| format!("parse {}: {e}", path.display()))
}

fn write_config(config: &CliConfig) -> Result<(), String> {
    let path = crate::paths::config_path();
    let content = serde_json::to_string_pretty(config).map_err(|e| e.to_string())?;
    crate::settings::atomic_write(&path, &content)
}

/// One-time import of the legacy ~/.ccgui/config.json claude section. Runs
/// only when the new config does not exist yet.
pub fn import_legacy_config_once() {
    let new_path = crate::paths::config_path();
    if new_path.exists() {
        return;
    }
    let legacy_path = crate::paths::legacy_home().join("config.json");
    if !legacy_path.exists() {
        return;
    }
    let Ok(content) = std::fs::read_to_string(&legacy_path) else {
        return;
    };
    let Ok(legacy) = serde_json::from_str::<Value>(&content) else {
        return;
    };
    let mut config = CliConfig::default();
    for engine in ENGINES {
        let Some(section) = legacy.get(engine) else {
            continue;
        };
        let providers = section
            .get("providers")
            .and_then(Value::as_object)
            .cloned()
            .unwrap_or_default();
        let current = section
            .get("current")
            .and_then(Value::as_str)
            .map(str::to_string);
        if let Some(target) = config.section_mut(engine) {
            target.providers = providers;
            target.current = current;
        }
    }
    let _ = write_config(&config);
}

fn is_official_provider(id: &str) -> bool {
    id.is_empty() || id == LOCAL_PROVIDER_ID || id == LEGACY_LOCAL_CONFIG_TOML_ID
}

/// Helper to find a provider in a section by exact id or by plugin prefix/suffix match.
/// For example, "custom_123" matches "plugin_model-switcher_custom_123",
/// and "plugin_model-switcher_custom_123" matches "custom_123".
/// More than one fuzzy candidate is an error: picking by insertion order
/// could silently send the conversation to the wrong endpoint.
pub(crate) fn find_provider<'a>(
    section: &'a ProviderSection,
    id: &str,
) -> Result<Option<(&'a str, &'a Value)>, String> {
    if let Some((k, v)) = section.providers.get_key_value(id) {
        return Ok(Some((k.as_str(), v)));
    }
    // Fuzzy both ways: a key ending with "_<id>" (caller passed the id
    // without its plugin prefix), or the id ending with "_<key>" (caller
    // passed it with an extra prefix).
    let mut matches = section
        .providers
        .iter()
        .filter(|(k, _)| k.ends_with(&format!("_{id}")) || id.ends_with(&format!("_{k}")));
    let first = matches.next();
    if let Some((second, _)) = matches.next() {
        let first_key = first.map(|(k, _)| k.as_str()).unwrap_or("");
        return Err(format!(
            "provider id {id} is ambiguous: matches {first_key} and {second}"
        ));
    }
    Ok(first.map(|(k, v)| (k.as_str(), v)))
}

/// Env a spawn should inject for `provider_id` on `engine`. Official / empty
/// / legacy-disabled ids yield an empty map (the program's own files apply).
pub fn resolve_provider_env(
    engine: &str,
    provider_id: Option<&str>,
) -> Result<HashMap<String, String>, String> {
    resolve_provider(engine, provider_id)?
        .map(|provider| crate::provider_files::channel_env(engine, &provider))
        .unwrap_or_else(|| Ok(HashMap::new()))
}

/// Read one channel snapshot for the whole launch (env and native overrides).
pub(crate) fn resolve_provider(
    engine: &str,
    provider_id: Option<&str>,
) -> Result<Option<Value>, String> {
    let config = read_config()?;
    let section = config
        .section(engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    crate::provider_files::migrate_legacy(engine, section)?;
    let explicit = provider_id.map(str::trim).filter(|s| !s.is_empty());
    let id = explicit.unwrap_or_else(|| section.current.as_deref().unwrap_or("").trim());
    if id == DISABLED_PROVIDER_ID || is_official_provider(id) {
        return Ok(None);
    }

    if let Some((_matched_key, provider)) = find_provider(section, id)? {
        return Ok(Some(provider.clone()));
    }

    if explicit.is_some() {
        // An explicitly chosen channel that no longer resolves must not
        // silently reroute the conversation to whatever channel is current:
        // the user picked an endpoint. Fail the send so they can re-pick.
        return Err(format!("provider {id} not found for engine {engine}"));
    }

    // Only the stored current id may be stale (the channel was deleted out
    // from under the config): fall back to the official config rather than
    // fail every send.
    eprintln!("[config] current provider {id} not found for {engine}, falling back to official config");
    Ok(None)
}

// ==================== Commands ====================

/// Historical configs may still sit on the legacy 停用 marker; it means
/// "official config" now. Normalize the view handed to the UI so it never
/// shows a dead id (the stored file is rewritten on the next user edit).
fn normalize_legacy_state(config: &mut CliConfig) {
    for engine in ENGINES {
        if let Some(section) = config.section_mut(engine) {
            if section.current.as_deref() == Some(DISABLED_PROVIDER_ID) {
                section.current = None;
            }
        }
    }
}

#[tauri::command]
pub fn get_cli_config() -> Result<CliConfig, String> {
    let mut config = read_config()?;
    normalize_legacy_state(&mut config);
    Ok(config)
}

/// Lock-free core of mutate_section: callers that already hold the
/// ConfigStore lock (the legacy provider import) use this directly.
pub(crate) fn mutate_section_unlocked(
    engine: &str,
    mutate: impl FnOnce(&mut ProviderSection) -> Result<(), String>,
) -> Result<(), String> {
    let mut config = read_config()?;
    let section = config
        .section_mut(engine)
        .ok_or_else(|| format!("unknown engine: {engine}"))?;
    let previous = section.clone();
    mutate(section)?;
    crate::provider_files::migrate_legacy(engine, &previous)?;
    write_config(&config)
}

/// Lock the store, apply `mutate` to one engine's section, persist. A
/// `mutate` error aborts before the write, leaving the config untouched.
fn mutate_section(
    store: &ConfigStore,
    engine: &str,
    mutate: impl FnOnce(&mut ProviderSection) -> Result<(), String>,
) -> Result<(), String> {
    let _guard = store.0.lock().map_err(|e| e.to_string())?;
    mutate_section_unlocked(engine, mutate)
}

#[tauri::command]
pub fn upsert_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
    json: Value,
) -> Result<(), String> {
    upsert_provider_inner(&store, engine, id, json)
}

fn upsert_provider_inner(
    store: &ConfigStore,
    engine: String,
    id: String,
    json: Value,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        section.providers.insert(id.clone(), json);
        Ok(())
    })
}

#[tauri::command]
pub fn delete_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    delete_provider_inner(&store, engine, id)
}

fn delete_provider_inner(store: &ConfigStore, engine: String, id: String) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        section.providers.remove(&id);
        if section.current.as_deref() == Some(id.as_str()) {
            // Fall back to 官方配置: spawn injects nothing for official.
            section.current = None;
        }
        Ok(())
    })
}

#[tauri::command]
pub fn set_current_provider(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    id: String,
) -> Result<(), String> {
    set_current_provider_inner(&store, engine, id)
}

fn set_current_provider_inner(
    store: &ConfigStore,
    engine: String,
    id: String,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        if id != LOCAL_PROVIDER_ID && id != LEGACY_LOCAL_CONFIG_TOML_ID {
            if let Some((matched_key, _)) = find_provider(section, &id)? {
                section.current = Some(matched_key.to_string());
                return Ok(());
            }
            return Err(format!("provider {id} not found for {engine}"));
        }
        // Session-scoped: this is the default for new chats. Existing sessions
        // keep the provider they remembered; spawn injects env, never writes
        // the CLI's own config file.
        section.current = Some(id.clone());
        Ok(())
    })
}

#[tauri::command]
pub fn reorder_providers(
    store: tauri::State<'_, ConfigStore>,
    engine: String,
    ids: Vec<String>,
) -> Result<(), String> {
    mutate_section(&store, &engine, |section| {
        // Rebuild map in requested order; keep unknown ids at the end.
        let mut ordered = serde_json::Map::new();
        let mut remaining: Vec<(String, Value)> =
            std::mem::take(&mut section.providers).into_iter().collect();
        for id in &ids {
            if let Some(pos) = remaining.iter().position(|(k, _)| k == id) {
                let (k, v) = remaining.remove(pos);
                ordered.insert(k, v);
            }
        }
        for (k, v) in remaining {
            ordered.insert(k, v);
        }
        section.providers = ordered;
        Ok(())
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    // Process-global env is steered by tests in several modules; the lock
    // is shared across all of them (test_support) to keep them serialized.
    use crate::test_support::HOME_ENV_LOCK as ENV_LOCK;

    struct Scratch {
        dir: std::path::PathBuf,
        prev_home: Option<std::ffi::OsString>,
        prev_profile: Option<std::ffi::OsString>,
        engine_homes: Vec<(&'static str, Option<std::ffi::OsString>)>,
        _lock: parking_lot::MutexGuard<'static, ()>,
    }
    impl Scratch {
        fn new() -> Self {
            let lock = ENV_LOCK.lock();
            let dir = std::env::temp_dir()
                .join(format!("hzkcode-config-test-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            let prev_home = std::env::var_os("HOME");
            let prev_profile = std::env::var_os("USERPROFILE");
            std::env::set_var("HOME", &dir);
            std::env::set_var("USERPROFILE", &dir);
            let engine_homes = [
                "HZKCODE_CONFIG_DIR",
                "CODEX_HOME",
                "KIMI_CODE_HOME",
                "GROK_HOME",
                "GROK_CONFIG_PATH",
                "GROK_AUTH_PATH",
                "ANTIGRAVITY_HOME",
            ]
            .into_iter()
            .map(|key| {
                let previous = std::env::var_os(key);
                let path = match key {
                    "GROK_CONFIG_PATH" => dir.join("grok-override/config.toml"),
                    "GROK_AUTH_PATH" => dir.join("grok-override/auth.json"),
                    _ => dir.join(key),
                };
                std::env::set_var(key, path);
                (key, previous)
            })
            .collect();
            Self {
                dir,
                prev_home,
                prev_profile,
                engine_homes,
                _lock: lock,
            }
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            for (key, previous) in &self.engine_homes {
                match previous {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
            match &self.prev_home {
                Some(v) => std::env::set_var("HOME", v),
                None => std::env::remove_var("HOME"),
            }
            match &self.prev_profile {
                Some(v) => std::env::set_var("USERPROFILE", v),
                None => std::env::remove_var("USERPROFILE"),
            }
            let _ = std::fs::remove_dir_all(&self.dir);
        }
    }

    fn seed_channel(engine: &str, id: &str, current: Option<&str>, provider: Value) {
        crate::paths::ensure_dirs().unwrap();
        let mut config = CliConfig::default();
        let section = config.section_mut(engine).unwrap();
        section.providers.insert(id.to_string(), provider);
        section.current = current.map(str::to_string);
        write_config(&config).unwrap();
    }

    #[test]
    fn resolve_provider_env_official_is_empty_and_claude_injects() {
        let _scratch = Scratch::new();
        seed_channel(
            "claude",
            "chan-a",
            Some("chan-a"),
            json!({
                "baseUrl": "https://a.example",
                "apiKey": "sk-a",
                "model": "m-a",
            }),
        );
        let env = resolve_provider_env("claude", Some("chan-a")).unwrap();
        assert_eq!(
            env.get("HZKCODE_BASE_URL").map(String::as_str),
            Some("https://a.example")
        );
        assert_eq!(env.get("HZKCODE_API_KEY").map(String::as_str), Some("sk-a"));
        assert_eq!(env.get("HZKCODE_MODEL").map(String::as_str), Some("m-a"));

        let official = resolve_provider_env("claude", Some(LOCAL_PROVIDER_ID)).unwrap();
        assert!(official.is_empty());
        let empty = resolve_provider_env("claude", Some("")).unwrap();
        // Empty id falls back to section.current (chan-a).
        assert_eq!(
            empty.get("HZKCODE_BASE_URL").map(String::as_str),
            Some("https://a.example")
        );
    }

    #[test]
    fn normalize_legacy_state_maps_disabled_current_to_official() {
        let mut config = CliConfig::default();
        let section = config.section_mut("claude").unwrap();
        section.providers.insert("chan-a".into(), json!({}));
        section.current = Some(DISABLED_PROVIDER_ID.into());
        normalize_legacy_state(&mut config);
        assert_eq!(config.section("claude").unwrap().current, None);
    }

    #[test]
    fn resolve_provider_env_legacy_disabled_is_official() {
        let _scratch = Scratch::new();
        seed_channel("claude", "chan-a", Some(DISABLED_PROVIDER_ID), json!({}));
        // Historical configs still carrying the 停用 marker launch with the
        // official config: nothing injected, no error.
        let env = resolve_provider_env("claude", Some(DISABLED_PROVIDER_ID)).unwrap();
        assert!(env.is_empty());
        // Bare sends fall back to the stored current id, same result.
        let bare = resolve_provider_env("claude", None).unwrap();
        assert!(bare.is_empty());
    }

    #[test]
    fn resolve_provider_env_matches_plugin_prefix_and_falls_back() {
        let _scratch = Scratch::new();
        seed_channel(
            "claude",
            "plugin_model-switcher_custom_1789366959743",
            Some("plugin_model-switcher_custom_1789366959743"),
            json!({
                "baseUrl": "https://tobapi.example.com",
                "apiKey": "sk-test",
            }),
        );
        // Suffix match: caller passes unprefixed id from plugin
        let env = resolve_provider_env("claude", Some("custom_1789366959743")).unwrap();
        assert_eq!(
            env.get("HZKCODE_BASE_URL").map(String::as_str),
            Some("https://tobapi.example.com")
        );
        assert_eq!(env.get("HZKCODE_API_KEY").map(String::as_str), Some("sk-test"));

        // A stale explicit id must fail, not silently reroute the
        // conversation to whatever channel happens to be current.
        let stale = resolve_provider_env("claude", Some("deleted_channel_123"));
        assert!(stale.is_err(), "stale explicit provider id must error");
        assert!(stale.unwrap_err().contains("deleted_channel_123"));
    }

    #[test]
    fn find_provider_fails_on_ambiguous_suffix_match() {
        let _scratch = Scratch::new();
        let mut section = ProviderSection::default();
        section.providers.insert(
            "plugin_a_custom_1".to_string(),
            json!({"baseUrl": "https://a.example"}),
        );
        section.providers.insert(
            "plugin_b_custom_1".to_string(),
            json!({"baseUrl": "https://b.example"}),
        );
        assert!(find_provider(&section, "custom_1").is_err());
        // Exact id still wins over fuzzy candidates.
        section
            .providers
            .insert("custom_1".to_string(), json!({"baseUrl": "https://exact.example"}));
        let (key, _) = find_provider(&section, "custom_1").unwrap().unwrap();
        assert_eq!(key, "custom_1");
    }

    #[test]
    fn set_current_provider_does_not_write_native_files() {
        let _scratch = Scratch::new();
        let store = ConfigStore::default();
        for engine in ENGINES {
            seed_channel(
                engine,
                "chan-a",
                None,
                json!({"baseUrl":"https://a.example", "apiKey":"sk-a"}),
            );
            let paths = crate::provider_files::provider_file_paths(engine.into());
            for path in &paths {
                std::fs::create_dir_all(std::path::Path::new(path).parent().unwrap()).unwrap();
                // Intentionally arbitrary bytes: switching must not parse/reformat
                // an existing native file when there is no legacy migration.
                std::fs::write(path, "# user's own config\n中文 🧪\n").unwrap();
            }
            for id in ["chan-a", LOCAL_PROVIDER_ID, "chan-a"] {
                set_current_provider_inner(&store, engine.into(), id.into()).unwrap();
                assert_eq!(
                    read_config()
                        .unwrap()
                        .section(engine)
                        .unwrap()
                        .current
                        .as_deref(),
                    Some(id)
                );
            }
            assert!(set_current_provider_inner(&store, engine.into(), "missing".into()).is_err());
            upsert_provider_inner(
                &store,
                engine.into(),
                "chan-a".into(),
                json!({"apiKey":"updated"}),
            )
            .unwrap();
            delete_provider_inner(&store, engine.into(), "chan-a".into()).unwrap();
            for path in &paths {
                assert_eq!(
                    std::fs::read_to_string(path).unwrap(),
                    "# user's own config\n中文 🧪\n",
                    "{engine}: {path}"
                );
                std::fs::remove_file(path).unwrap();
            }
            upsert_provider_inner(
                &store,
                engine.into(),
                "chan-a".into(),
                json!({"apiKey":"new"}),
            )
            .unwrap();
            set_current_provider_inner(&store, engine.into(), "chan-a".into()).unwrap();
            for path in paths {
                assert!(!std::path::Path::new(&path).exists());
            }
        }
    }
}
