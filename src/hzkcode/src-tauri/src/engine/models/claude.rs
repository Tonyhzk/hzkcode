//! Claude's catalog comes from the CLI's own configuration, not the app's
//! provider channels: `claude --model` resolves the built-in aliases the
//! /model menu lists, and the CLI's configured default lives in
//! ~/.hzkcode/settings.json (settings.local.json overrides it). The concrete
//! model id each alias resolves to is read from the registry the CLI embeds
//! in its own binary, so the picker names the real model instead of the
//! bare family name. No relay probe: the /model menu is built into the CLI
//! binary, so a channel's /v1/models would list ids the CLI never offers.

use std::path::PathBuf;

use super::EngineModel;
/// The model registry the CLI embeds in its binary (native build or cli.js
/// bundle alike): the tier config table (`ALL_MODEL_CONFIGS`: key →
/// `CLAUDE_*_CONFIG` constant), each constant's first-party model id
/// (`firstParty:`), and the public display names the CLI's
/// `getPublicModelDisplayName` switch maps them to. Extracted from raw
/// bytes; the JS source survives bundling verbatim.
#[derive(Clone, Debug, Default)]
pub(super) struct EmbeddedRegistry {
    /// Config key → first-party model id ("opus47" → "claude-opus-4-7").
    config_ids: std::collections::HashMap<String, String>,
    /// Model id → human name ("claude-opus-4-7" → "Opus 4.7").
    display_names: std::collections::HashMap<String, String>,
}

impl EmbeddedRegistry {
    /// "Opus 4.7 · claude-opus-4-7" for a known selector (tier spell or model
    /// id, with or without a retired context suffix); the selector verbatim
    /// when the registry can't resolve it. A bare tier spell falls back to the
    /// first-party default — callers that know the provider resolve the tier
    /// through [`tier_default_id`] first.
    fn display_line(&self, selector: &str) -> String {
        let bare = super::normalize_tier_alias(&super::strip_context_suffix(selector));
        let id = match bare.as_str() {
            "high" => self.config_ids.get("opus47"),
            "mid" => self.config_ids.get("sonnet46"),
            "low" => self.config_ids.get("haiku45"),
            _ => None,
        }
        .map(String::as_str)
        .unwrap_or(bare.as_str());
        match self.display_names.get(id) {
            Some(name) => format!("{name} · {id}"),
            None => id.to_string(),
        }
    }
}

/// Parse the embedded registry out of the binary's raw bytes.
fn parse_registry(bytes: &[u8]) -> EmbeddedRegistry {
    use regex::bytes::Regex;
    let mut registry = EmbeddedRegistry::default();
    // `CLAUDE_OPUS_4_7_CONFIG = {\n    firstParty: "claude-opus-4-7",` — the
    // first-party id of every config constant.
    let const_re =
        Regex::new(r#"(CLAUDE_[\w]+_CONFIG) = \{\s*firstParty: "([^"]+)""#).unwrap();
    // The table itself: `opus47: CLAUDE_OPUS_4_7_CONFIG` (trailing entries may
    // lack the comma, so no line-tail anchor).
    let table_re = Regex::new(r"(\w+): (CLAUDE_[\w]+_CONFIG)").unwrap();
    // `case getModelStrings2().opus47:\n      return "Opus 4.7";` — the public
    // display names.
    let name_re = Regex::new(r#"getModelStrings2\(\)\.(\w+):\s*return "([^"]+)""#).unwrap();

    let mut config_ids: std::collections::HashMap<String, String> = Default::default();
    for c in const_re.captures_iter(bytes) {
        config_ids.insert(
            String::from_utf8_lossy(&c[1]).into_owned(),
            String::from_utf8_lossy(&c[2]).into_owned(),
        );
    }
    let mut key_ids: std::collections::HashMap<String, String> = Default::default();
    for m in table_re.captures_iter(bytes) {
        let key = String::from_utf8_lossy(&m[1]).into_owned();
        let cname = String::from_utf8_lossy(&m[2]).into_owned();
        if let Some(id) = config_ids.get(&cname) {
            key_ids.insert(key, id.clone());
        }
    }
    for m in name_re.captures_iter(bytes) {
        let key = String::from_utf8_lossy(&m[1]).into_owned();
        let name = String::from_utf8_lossy(&m[2]).into_owned();
        if let Some(id) = key_ids.get(&key) {
            registry.display_names.insert(id.clone(), name);
        }
    }
    registry.config_ids.extend(key_ids);
    registry
}

/// Read the CLI binary's embedded registry, cached per binary content: the
/// picker re-queries on every open and the scan reads the whole binary.
/// None for shims/old builds without an extractable registry — the catalog
/// then degrades to bare family names.
fn embedded_registry(bin: &std::path::Path) -> Option<EmbeddedRegistry> {
    struct CacheEntry {
        len: u64,
        modified: Option<std::time::SystemTime>,
        registry: Option<EmbeddedRegistry>,
    }
    static CACHE: std::sync::LazyLock<parking_lot::Mutex<Option<CacheEntry>>> =
        std::sync::LazyLock::new(|| parking_lot::Mutex::new(None));
    let meta = std::fs::metadata(bin).ok()?;
    let (len, modified) = (meta.len(), meta.modified().ok());
    if let Some(entry) = CACHE.lock().as_ref() {
        if entry.len == len && entry.modified == modified {
            return entry.registry.clone();
        }
    }
    let registry = std::fs::read(bin)
        .ok()
        .map(|bytes| parse_registry(&bytes))
        .filter(|r| !r.config_ids.is_empty());
    *CACHE.lock() = Some(CacheEntry {
        len,
        modified,
        registry: registry.clone(),
    });
    registry
}

/// Selectors the picker offers, in menu order, carrying the app's display
/// names: "default" is this app's own row (it sends no explicit tier and lets
/// the CLI pick), and the three capability tiers surface as High/Mid/Low —
/// since 3.1.1 these are the CLI's own alias spell (the old
/// opus/sonnet/haiku family names no longer resolve). The catalog is
/// advisory: an unresolvable pick fails at launch with the CLI's own error.
const CLI_ALIASES: &[(&str, &str)] = &[
    ("default", "Default"),
    ("high", "High"),
    ("mid", "Mid"),
    ("low", "Low"),
];

/// The CLI's config root: `$HZKCODE_CONFIG_DIR` when set, else `~/.hzkcode`
/// — the same root the history scanner and the channel file editor use.
fn claude_config_dir() -> PathBuf {
    crate::engine::engine_home(Some("HZKCODE_CONFIG_DIR"), ".hzkcode")
}

/// env keys that remap a capability tier to a custom model id (the CLI's
/// /model menu "Custom <tier> model" rows), with the tier's display name.
const FAMILY_ENV_KEYS: &[(&str, &str, &str)] = &[
    // (tier, env key, display name)
    ("high", "HZKCODE_DEFAULT_HIGH_MODEL", "High"),
    ("mid", "HZKCODE_DEFAULT_MID_MODEL", "Mid"),
    ("low", "HZKCODE_DEFAULT_LOW_MODEL", "Low"),
];

/// The CLI's model configuration from ~/.hzkcode/settings.json, merged per
/// field with settings.local.json winning (the CLI's own precedence).
#[derive(Default)]
struct CliModelConfig {
    /// env.HZKCODE_MODEL — the CLI's effective default model id.
    env_model: Option<String>,
    /// Top-level `model` key (an alias like "mid" or a raw id).
    model_key: Option<String>,
    /// The capability tiers' model overrides, keyed by tier.
    overrides: std::collections::HashMap<String, String>,
    /// env.HZKCODE_PROVIDER — the provider brand, when set.
    provider: Option<String>,
    /// env.HZKCODE_API_MODE — the API format, when set.
    api_mode: Option<String>,
    /// Top-level `modelType` — the stored provider kind, when set.
    model_type: Option<String>,
}

impl CliModelConfig {
    /// The custom id a capability tier resolves to, when overridden.
    fn override_for(&self, tier: &str) -> Option<&str> {
        self.overrides.get(tier).map(String::as_str)
    }

    /// The CLI's effective default model id: env.HZKCODE_MODEL beats the
    /// `model` key (the CLI applies settings env as real environment
    /// variables); a bare tier alias there resolves through its override.
    /// Legacy family aliases and retired context suffixes normalize first, so
    /// a config written for an older CLI still names the right model.
    fn resolved_default(&self) -> Option<String> {
        let raw = self.env_model.as_deref().or(self.model_key.as_deref())?;
        let bare = super::normalize_tier_alias(&super::strip_context_suffix(raw));
        Some(self.override_for(&bare).unwrap_or(&bare).to_string())
    }

    /// The API provider the CLI would resolve (getAPIProvider): an explicit
    /// brand wins, then the API format, then the stored modelType; with
    /// nothing configured 3.1.2 defaults to the OpenAI-compatible channel.
    fn provider_kind(&self) -> &'static str {
        if let Some(kind) = self.provider.as_deref() {
            match kind {
                "anthropic" => return "firstParty",
                "openai" => return "openai",
                "gemini" => return "gemini",
                "grok" => return "grok",
                "bedrock" => return "bedrock",
                "vertex" => return "vertex",
                "foundry" => return "foundry",
                _ => {}
            }
        }
        if let Some(mode) = self.api_mode.as_deref() {
            match mode {
                "anthropic" => return "firstParty",
                "responses" | "chat_completions" => return "openai",
                _ => {}
            }
        }
        if let Some(kind) = self.model_type.as_deref() {
            match kind {
                "anthropic" => return "firstParty",
                "openai" => return "openai",
                "gemini" => return "gemini",
                "grok" => return "grok",
                "bedrock" => return "bedrock",
                "vertex" => return "vertex",
                "foundry" => return "foundry",
                _ => {}
            }
        }
        "openai"
    }

    /// The OpenAI-compatible channels' primary model (the CLI's
    /// getProviderPrimaryModel reading HZKCODE_MODEL): the tier fallback
    /// chain uses it before the hardcoded family defaults. Tiers spelled as
    /// bare aliases are not concrete models and are ignored; the grok
    /// channel's own variable is not one the app configures.
    fn primary_model(&self) -> Option<String> {
        let kind = self.provider_kind();
        if kind != "openai" && kind != "gemini" {
            return None;
        }
        let raw = self.env_model.as_deref()?;
        let bare = super::normalize_tier_alias(&super::strip_context_suffix(raw));
        if matches!(bare.as_str(), "high" | "mid" | "low") {
            return None;
        }
        Some(bare)
    }
}

/// The model id a tier resolves to when the channel carries no mapping: the
/// CLI's getDefaultHigh/Mid/LowModel chain — the OpenAI-compatible channels'
/// primary model first, then the family defaults. High and low resolve to
/// the same config on every provider; mid is firstParty-only sonnet46, every
/// other channel falls back to sonnet45.
fn tier_default_id(
    config: &CliModelConfig,
    registry: &EmbeddedRegistry,
    tier: &str,
) -> Option<String> {
    if let Some(primary) = config.primary_model() {
        return Some(primary);
    }
    let key = match (tier, config.provider_kind()) {
        ("high", _) => "opus47",
        ("mid", "firstParty") => "sonnet46",
        ("mid", _) => "sonnet45",
        ("low", _) => "haiku45",
        _ => return None,
    };
    registry.config_ids.get(key).cloned()
}

/// A tier's actual model line: the channel's tier mapping
/// (`HZKCODE_DEFAULT_<TIER>_MODEL`) when set, else the CLI's default chain.
fn tier_effective_line(
    config: &CliModelConfig,
    registry: Option<&EmbeddedRegistry>,
    tier: &str,
) -> Option<String> {
    if let Some(custom) = config.override_for(tier) {
        let custom = super::strip_context_suffix(custom);
        return Some(match registry {
            Some(r) => r.display_line(&custom),
            None => custom,
        });
    }
    let registry = registry?;
    let id = tier_default_id(config, registry, tier)?;
    Some(registry.display_line(&id))
}

/// The "default" row's subtitle: the CLI's configured default when one
/// exists (a bare tier spell runs that tier's chain), else the mid tier the
/// CLI falls back to when nothing is configured — the mid tier's own mapping
/// wins there too. None without a registry and without a configured value.
fn default_line(
    config: &CliModelConfig,
    registry: Option<&EmbeddedRegistry>,
    resolved_default: Option<&str>,
) -> Option<String> {
    let line = match resolved_default {
        Some(value) if matches!(value, "high" | "mid" | "low") => {
            tier_effective_line(config, registry, value)?
        }
        Some(value) => match registry {
            Some(r) => r.display_line(value),
            None => value.to_string(),
        },
        None => tier_effective_line(config, registry, "mid")?,
    };
    Some(format!("Use the default model (currently {line})"))
}

fn read_cli_config() -> CliModelConfig {
    read_cli_config_from(&claude_config_dir())
}

/// The model id a picker selector actually runs, for launch: a family alias
/// resolves through its capability tier's override
/// (`HZKCODE_DEFAULT_HIGH/MID/LOW_MODEL`), "default"
/// through the CLI's configured default; anything unmapped passes through
/// for the CLI to resolve itself. Relay setups depend on the env remap,
/// which some CLI builds/shims skip — launching with the id the picker
/// names makes the request match the display regardless.
pub(crate) fn resolve_launch_model(selector: &str) -> String {
    resolve_launch_model_from(&read_cli_config(), selector)
}

fn resolve_launch_model_from(config: &CliModelConfig, selector: &str) -> String {
    let bare = super::normalize_tier_alias(&super::strip_context_suffix(selector));
    if bare == "default" {
        // 3.1.2 的默认档是 mid（getDefaultMainLoopModelSetting），"default"
        // 本身不再是 CLI 别名（会作为字面模型名发出去），因此无配置时收口
        // 到 mid；有配置时照旧走 CLI 的默认模型链。
        return config.resolved_default().unwrap_or_else(|| "mid".to_string());
    }
    config
        .override_for(&bare)
        .map(str::to_string)
        .unwrap_or(bare)
}

fn read_cli_config_from(dir: &std::path::Path) -> CliModelConfig {
    let mut config = CliModelConfig::default();
    // User settings first so the local file overrides per field.
    for name in ["settings.json", "settings.local.json"] {
        if let Ok(content) = std::fs::read_to_string(dir.join(name)) {
            merge_settings_json(&mut config, &content);
        }
    }
    config
}

/// Per-field settings merge (settings.local.json wins), shared by the local
/// read and the remote (WSL distro) variant.
fn merge_settings_json(config: &mut CliModelConfig, content: &str) {
    let pick = |value: Option<&serde_json::Value>| {
        value
            .and_then(|m| m.as_str())
            .map(str::trim)
            .filter(|m| !m.is_empty())
            .map(str::to_string)
    };
    let Ok(v) = serde_json::from_str::<serde_json::Value>(content) else {
        return;
    };
    let env = v.get("env");
    if let Some(m) = pick(env.and_then(|e| e.get("HZKCODE_MODEL"))) {
        config.env_model = Some(m);
    }
    if let Some(m) = pick(v.get("model")) {
        config.model_key = Some(m);
    }
    if let Some(m) = pick(env.and_then(|e| e.get("HZKCODE_PROVIDER"))) {
        config.provider = Some(m);
    }
    if let Some(m) = pick(env.and_then(|e| e.get("HZKCODE_API_MODE"))) {
        config.api_mode = Some(m);
    }
    if let Some(m) = pick(v.get("modelType")) {
        config.model_type = Some(m);
    }
    for (tier, key, _) in FAMILY_ENV_KEYS {
        if let Some(m) = pick(env.and_then(|e| e.get(key))) {
            config.overrides.insert(tier.to_string(), m);
        }
    }
}

/// Remote (WSL distro) catalog from the distro's `$HZKCODE_CONFIG_DIR`
/// settings contents (fetched via ssh by the caller). Aliases are CLI
/// built-ins; only the per-field overrides come from config, so the distro
/// settings reproduce its own /model menu.
pub(super) fn claude_models_remote(user_json: &str, local_json: &str) -> Vec<EngineModel> {
    let mut config = CliModelConfig::default();
    merge_settings_json(&mut config, user_json);
    merge_settings_json(&mut config, local_json);
    claude_models_from(config, None)
}

/// Claude's picker catalog: the CLI's built-in aliases, default row first.
/// Aliases remapped via their capability tier display the custom
/// id as the name with the CLI menu's "Custom <Family> model" subtitle;
/// unremapped aliases name the concrete model the CLI's embedded registry
/// resolves them to, so the picker shows what a request actually runs.
pub(super) fn claude_models(bin: Option<&std::path::Path>) -> Vec<EngineModel> {
    claude_models_from(
        read_cli_config(),
        bin.and_then(embedded_registry).as_ref(),
    )
}

fn claude_models_from(
    config: CliModelConfig,
    registry: Option<&EmbeddedRegistry>,
) -> Vec<EngineModel> {
    let resolved_default = config.resolved_default();
    CLI_ALIASES
        .iter()
        .map(|(id, name)| {
            let display = FAMILY_ENV_KEYS
                .iter()
                .find(|(f, _, _)| *f == *id)
                .map(|(_, _, d)| *d);
            let custom = config.override_for(id).map(super::strip_context_suffix);
            let (name, description) = match (display, custom) {
                (Some(display), Some(custom)) => (
                    Some(custom),
                    Some(format!("Custom {display} model")),
                ),
                _ if *id == "default" => (
                    Some(name.to_string()),
                    default_line(&config, registry, resolved_default.as_deref()),
                ),
                _ => (
                    Some(name.to_string()),
                    // The custom branch above already claimed a mapped tier,
                    // so this resolves through the default chain.
                    tier_effective_line(&config, registry, id),
                ),
            };
            EngineModel {
                id: id.to_string(),
                name,
                description,
                // No source label: every alias comes from the app's single
                // engine, so a provider tag would only render as a one-item
                // section header in the picker.
                provider: String::new(),
                context_window: None,
            }
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn aliases_cover_the_cli_model_menu() {
        let ids: Vec<&str> = CLI_ALIASES.iter().map(|(id, _)| *id).collect();
        assert_eq!(ids, vec!["default", "high", "mid", "low"]);
    }

    #[test]
    fn cli_config_local_overrides_user_per_field() {
        let dir = std::env::temp_dir().join(format!("hzkcode-claude-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","env":{"HZKCODE_MODEL":"sonnet","HZKCODE_DEFAULT_HIGH_MODEL":"grok-4.5"}}"#,
        )
        .unwrap();
        std::fs::write(dir.join("settings.local.json"), r#"{"model":"haiku"}"#).unwrap();
        let config = read_cli_config_from(&dir);
        std::fs::remove_dir_all(&dir).ok();
        // Local `model` wins its field; the user file's env fields survive.
        // Stored values keep their spelling — normalization happens on read.
        assert_eq!(config.model_key.as_deref(), Some("haiku"));
        assert_eq!(config.env_model.as_deref(), Some("sonnet"));
        assert_eq!(config.override_for("high"), Some("grok-4.5"));
        assert_eq!(config.override_for("mid"), None);
    }

    #[test]
    fn launch_model_resolves_overrides_and_passes_the_rest_through() {
        let dir = std::env::temp_dir().join(format!("hzkcode-claude-test4-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","env":{"HZKCODE_DEFAULT_HIGH_MODEL":"gemini-3.8-flash"}}"#,
        )
        .unwrap();
        let config = read_cli_config_from(&dir);
        std::fs::remove_dir_all(&dir).ok();
        // Tier alias → custom id (what the picker names it).
        assert_eq!(resolve_launch_model_from(&config, "high"), "gemini-3.8-flash");
        // A legacy family alias and a retired context suffix normalize first.
        assert_eq!(resolve_launch_model_from(&config, "opus"), "gemini-3.8-flash");
        assert_eq!(resolve_launch_model_from(&config, "opus[1m]"), "gemini-3.8-flash");
        // "default" → the CLI's configured default, override applied.
        assert_eq!(resolve_launch_model_from(&config, "default"), "gemini-3.8-flash");
        // Unmapped aliases normalize to the 3.1.2 spell; raw ids pass through.
        assert_eq!(resolve_launch_model_from(&config, "sonnet"), "mid");
        assert_eq!(resolve_launch_model_from(&config, "claude-opus-5"), "claude-opus-5");
        // Nothing configured: "default" collapses to the CLI's mid tier —
        // the literal word is no longer an alias the CLI resolves.
        assert_eq!(
            resolve_launch_model_from(&CliModelConfig::default(), "default"),
            "mid"
        );
    }

    #[test]
    fn cli_config_reads_env_when_no_local_file() {
        let dir = std::env::temp_dir().join(format!("hzkcode-claude-test2-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","env":{"HZKCODE_MODEL":"k3"}}"#,
        )
        .unwrap();
        let config = read_cli_config_from(&dir);
        std::fs::remove_dir_all(&dir).ok();
        // env.HZKCODE_MODEL outranks the `model` key within one file.
        assert_eq!(config.resolved_default().as_deref(), Some("k3"));
    }

    #[test]
    fn catalog_labels_overridden_tiers_like_the_cli_menu() {
        let dir = std::env::temp_dir().join(format!("hzkcode-claude-test3-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(
            dir.join("settings.json"),
            r#"{"model":"opus","env":{
                "HZKCODE_MODEL":"grok-4.5",
                "HZKCODE_DEFAULT_HIGH_MODEL":"grok-4.5",
                "HZKCODE_DEFAULT_MID_MODEL":"grok-4.5",
                "HZKCODE_DEFAULT_LOW_MODEL":"grok-4.5"
            }}"#,
        )
        .unwrap();
        let config = read_cli_config_from(&dir);
        std::fs::remove_dir_all(&dir).ok();
        // The /model menu's main label is the resolved custom id, with the
        // "Custom <tier> model" subtitle the CLI shows.
        let models = claude_models_from(config, None);
        let by_id = |id: &str| models.iter().find(|m| m.id == id).unwrap();
        let high = by_id("high");
        assert_eq!(high.name.as_deref(), Some("grok-4.5"));
        assert_eq!(high.description.as_deref(), Some("Custom High model"));
        let default = by_id("default");
        assert_eq!(default.name.as_deref(), Some("Default"));
        assert_eq!(
            default.description.as_deref(),
            Some("Use the default model (currently grok-4.5)")
        );
        // The app's own "default" row plus the CLI's three tier aliases —
        // no extra "configured" row, no suffix variants.
        assert_eq!(models.len(), 4);
        assert_eq!(models[0].id, "default");
    }

    #[test]
    fn resolved_default_maps_alias_through_override() {
        let config = CliModelConfig {
            env_model: None,
            model_key: Some("opus[1m]".to_string()),
            overrides: [("high".to_string(), "grok-4.5".to_string())]
                .into_iter()
                .collect(),
            ..CliModelConfig::default()
        };
        assert_eq!(config.resolved_default().as_deref(), Some("grok-4.5"));
        // A raw id passes through untouched.
        let config = CliModelConfig {
            env_model: Some("k3".to_string()),
            ..CliModelConfig::default()
        };
        assert_eq!(config.resolved_default().as_deref(), Some("k3"));
        // A legacy family alias with no override normalizes to its tier.
        let config = CliModelConfig {
            env_model: Some("sonnet".to_string()),
            ..CliModelConfig::default()
        };
        assert_eq!(config.resolved_default().as_deref(), Some("mid"));
    }

    /// A registry snippet shaped exactly like the CLI binary's embedded
    /// source: the config constants, the ALL_MODEL_CONFIGS table, then the
    /// public display-name switch.
    fn fake_registry() -> EmbeddedRegistry {
        parse_registry(
            br#"CLAUDE_OPUS_4_7_CONFIG = {
    firstParty: "claude-opus-4-7",
    bedrock: "us.anthropic.claude-opus-4-7-v1",
    vertex: "claude-opus-4-7"
  };
  CLAUDE_SONNET_4_6_CONFIG = {
    firstParty: "claude-sonnet-4-6",
    bedrock: "us.anthropic.claude-sonnet-4-6-v1"
  };
  CLAUDE_SONNET_4_5_CONFIG = {
    firstParty: "claude-sonnet-4-5-20250929",
    bedrock: "us.anthropic.claude-sonnet-4-5-20250929-v1:0"
  };
  CLAUDE_HAIKU_4_5_CONFIG = {
    firstParty: "claude-haiku-4-5-20251001",
    bedrock: "us.anthropic.claude-haiku-4-5-20251001-v1:0"
  };
  ALL_MODEL_CONFIGS = {
    haiku45: CLAUDE_HAIKU_4_5_CONFIG,
    sonnet45: CLAUDE_SONNET_4_5_CONFIG,
    sonnet46: CLAUDE_SONNET_4_6_CONFIG,
    opus47: CLAUDE_OPUS_4_7_CONFIG
  };
  getPublicModelDisplayName(model) {
  switch (model) {
    case getModelStrings2().opus47:
      return "Opus 4.7";
    case getModelStrings2().sonnet46:
      return "Sonnet 4.6";
    case getModelStrings2().sonnet45:
      return "Sonnet 4.5";
    case getModelStrings2().haiku45:
      return "Haiku 4.5";
    default:
      return null;
  }
}"#,
        )
    }

    #[test]
    fn parse_registry_extracts_config_ids_and_display_names() {
        let registry = fake_registry();
        assert_eq!(
            registry.config_ids.get("opus47").map(String::as_str),
            Some("claude-opus-4-7")
        );
        assert_eq!(
            registry.config_ids.get("sonnet46").map(String::as_str),
            Some("claude-sonnet-4-6")
        );
        assert_eq!(
            registry.config_ids.get("sonnet45").map(String::as_str),
            Some("claude-sonnet-4-5-20250929")
        );
        assert_eq!(
            registry.config_ids.get("haiku45").map(String::as_str),
            Some("claude-haiku-4-5-20251001")
        );
        assert_eq!(
            registry
                .display_names
                .get("claude-opus-4-7")
                .map(String::as_str),
            Some("Opus 4.7")
        );
        // Noise without the registry's shape contributes nothing.
        assert!(parse_registry(br#"aliases:Qn(N(),cyg()),foo:{default:32000}"#)
            .config_ids
            .is_empty());
    }

    #[test]
    fn display_line_resolves_tiers_suffixes_and_unknowns() {
        let registry = fake_registry();
        // A bare tier spell falls back to the first-party default.
        assert_eq!(registry.display_line("high"), "Opus 4.7 · claude-opus-4-7");
        assert_eq!(registry.display_line("mid"), "Sonnet 4.6 · claude-sonnet-4-6");
        // Legacy aliases and retired context suffixes normalize first.
        assert_eq!(registry.display_line("opus"), "Opus 4.7 · claude-opus-4-7");
        assert_eq!(
            registry.display_line("opus[1m]"),
            "Opus 4.7 · claude-opus-4-7"
        );
        // A raw id resolves to its display name; an unknown selector passes
        // through verbatim.
        assert_eq!(
            registry.display_line("claude-sonnet-4-6"),
            "Sonnet 4.6 · claude-sonnet-4-6"
        );
        assert_eq!(registry.display_line("k3"), "k3");
    }

    #[test]
    fn tier_defaults_follow_provider_branches() {
        let registry = fake_registry();
        let description = |models: &[EngineModel], id: &str| {
            models
                .iter()
                .find(|m| m.id == id)
                .unwrap()
                .description
                .clone()
        };
        // The default channel (3.1.2 falls back to the OpenAI-compatible
        // provider when nothing is configured): mid runs sonnet45, not 46.
        let models = claude_models_from(CliModelConfig::default(), Some(&registry));
        assert_eq!(
            description(&models, "high").as_deref(),
            Some("Opus 4.7 · claude-opus-4-7")
        );
        assert_eq!(
            description(&models, "mid").as_deref(),
            Some("Sonnet 4.5 · claude-sonnet-4-5-20250929")
        );
        assert_eq!(
            description(&models, "low").as_deref(),
            Some("Haiku 4.5 · claude-haiku-4-5-20251001")
        );
        // firstParty: mid runs sonnet46.
        let config = CliModelConfig {
            api_mode: Some("anthropic".to_string()),
            ..CliModelConfig::default()
        };
        let models = claude_models_from(config, Some(&registry));
        assert_eq!(
            description(&models, "mid").as_deref(),
            Some("Sonnet 4.6 · claude-sonnet-4-6")
        );
        // OpenAI-compatible channels fall back to the primary model
        // (HZKCODE_MODEL) before the family defaults.
        let config = CliModelConfig {
            api_mode: Some("responses".to_string()),
            env_model: Some("deepseek-v4-pro".to_string()),
            ..CliModelConfig::default()
        };
        let models = claude_models_from(config, Some(&registry));
        for tier in ["high", "mid", "low"] {
            assert_eq!(description(&models, tier).as_deref(), Some("deepseek-v4-pro"));
        }
        // A bare tier spell is not a concrete primary: the family default
        // stands instead of echoing the alias back.
        let config = CliModelConfig {
            api_mode: Some("responses".to_string()),
            env_model: Some("mid".to_string()),
            ..CliModelConfig::default()
        };
        let models = claude_models_from(config, Some(&registry));
        assert_eq!(
            description(&models, "mid").as_deref(),
            Some("Sonnet 4.5 · claude-sonnet-4-5-20250929")
        );
    }

    #[test]
    fn catalog_default_row_follows_a_configured_tier_spell() {
        let registry = fake_registry();
        let config = CliModelConfig {
            model_key: Some("high".to_string()),
            ..CliModelConfig::default()
        };
        let models = claude_models_from(config, Some(&registry));
        let default = models.iter().find(|m| m.id == "default").unwrap();
        assert_eq!(
            default.description.as_deref(),
            Some("Use the default model (currently Opus 4.7 · claude-opus-4-7)")
        );
    }

    #[test]
    fn catalog_names_tiers_by_app_language() {
        let models = claude_models_from(CliModelConfig::default(), None);
        let name = |id: &str| {
            models
                .iter()
                .find(|m| m.id == id)
                .unwrap()
                .name
                .clone()
        };
        assert_eq!(name("high").as_deref(), Some("High"));
        assert_eq!(name("mid").as_deref(), Some("Mid"));
        assert_eq!(name("low").as_deref(), Some("Low"));
    }

    #[test]
    fn catalog_defaults_to_mid_when_unconfigured() {
        let registry = fake_registry();
        // Unconfigured default = the mid tier chain (default channel →
        // sonnet45).
        let models = claude_models_from(CliModelConfig::default(), Some(&registry));
        let default = models.iter().find(|m| m.id == "default").unwrap();
        assert_eq!(
            default.description.as_deref(),
            Some("Use the default model (currently Sonnet 4.5 · claude-sonnet-4-5-20250929)")
        );
        // Without a registry an unconfigured default stays silent.
        let models = claude_models_from(CliModelConfig::default(), None);
        assert_eq!(models[0].description, None);
    }

    #[test]
    fn catalog_default_row_names_a_mapped_mid_tier() {
        let registry = fake_registry();
        // Only the mid tier is mapped: the CLI's default chain starts at
        // getDefaultMidModel, which uses the mapping — the default row must
        // name it, not the built-in Sonnet.
        let mid_only = || CliModelConfig {
            overrides: [("mid".to_string(), "custom-mid".to_string())]
                .into_iter()
                .collect(),
            ..CliModelConfig::default()
        };
        let models = claude_models_from(mid_only(), Some(&registry));
        let default = models.iter().find(|m| m.id == "default").unwrap();
        assert_eq!(
            default.description.as_deref(),
            Some("Use the default model (currently custom-mid)")
        );
        // Without a registry the mapped value still shows verbatim.
        let models = claude_models_from(mid_only(), None);
        let default = models.iter().find(|m| m.id == "default").unwrap();
        assert_eq!(
            default.description.as_deref(),
            Some("Use the default model (currently custom-mid)")
        );
    }
}

