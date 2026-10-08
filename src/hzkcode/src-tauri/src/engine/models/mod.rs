//! Model catalog for the composer's model picker.
//!
//! Claude runs entirely on the CLI's own configuration: the catalog is
//! the built-in aliases `claude --model` resolves (the /model menu's
//! entries) in menu order; the configured default from ~/.hzkcode/settings.json is named
//! in the "default" row's subtitle, and each alias names the concrete model
//! id the CLI binary's embedded registry resolves it to. No
//! relay probe: the /model menu is built into the CLI binary. The app's
//! provider channels never feed it.

mod claude;
mod wsl;

/// Claude launch-time model resolution: picker alias → the custom id its
/// capability tier's override maps to (pass-through when
/// unmapped), so the request carries the model the picker displayed even
/// when the CLI build skips its own env remap.
pub(crate) fn resolve_claude_launch_model(selector: &str) -> String {
    claude::resolve_launch_model(selector)
}

/// The model-name context suffix the CLI retired in 3.1.2 (`model[1m]` /
/// `model[2m]`; the CLI itself now only strips it as input tolerance).
/// Transcripts, channel configs and identity definitions may still carry it,
/// so every read path normalizes through here.
pub(crate) fn strip_context_suffix(model: &str) -> String {
    static SUFFIX_RE: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)(\[(1|2)m\])+$").expect("context-suffix pattern")
    });
    SUFFIX_RE.replace(model.trim(), "").trim().to_string()
}

/// The 3.1.1 tier rename: the old family aliases (opus/sonnet/haiku) became
/// high/mid/low with no alias kept. Tier spells match case-insensitively
/// (the CLI lowercases before matching) and normalize to their lowercase
/// spell; whole-value match only, so real model ids that merely contain a
/// family word (`claude-sonnet-4-6`) are untouched.
pub(crate) fn normalize_tier_alias(model: &str) -> String {
    let trimmed = model.trim();
    match trimmed.to_ascii_lowercase().as_str() {
        "opus" => "high".to_string(),
        "sonnet" => "mid".to_string(),
        "haiku" => "low".to_string(),
        "high" => "high".to_string(),
        "mid" => "mid".to_string(),
        "low" => "low".to_string(),
        _ => trimmed.to_string(),
    }
}

use serde::Serialize;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineModel {
    /// Selector accepted by `--model` ("provider/model").
    pub id: String,
    /// Display name when the catalog carries one (JSON probe only).
    pub name: Option<String>,
    /// Secondary line under the name (e.g. "Custom High model"), mirroring
    /// the CLI's own /model menu descriptions.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    pub provider: String,
    /// Context window parsed from the table ("131.1K" -> 131_100).
    pub context_window: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineCatalog {
    pub models: Vec<EngineModel>,
    /// True when `models` is exactly what the CLI's model flag resolves
    /// (config/registry/binary-derived). A stored pick outside it cannot
    /// run, so the frontend resets it to the leading entry.
    pub authoritative: bool,
    /// True when the catalog was produced for a remote workspace (WSL
    /// distro): the frontend must NOT merge local provider/custom models
    /// into it — only the distro CLI's own list is runnable there.
    #[serde(default)]
    pub remote: bool,
}

impl EngineCatalog {
    fn authoritative(models: Vec<EngineModel>) -> Self {
        Self {
            models,
            authoritative: true,
            remote: false,
        }
    }

    /// Catalog sourced from inside a remote workspace; even when empty it
    /// suppresses the frontend's local-config fallback.
    fn authoritative_remote(models: Vec<EngineModel>) -> Self {
        Self {
            models,
            authoritative: true,
            remote: true,
        }
    }
}

#[tauri::command]
pub async fn list_engine_models(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    workspace: Option<String>,
) -> Result<EngineCatalog, String> {
    // WSL 工作区:模型目录必须来自发行版内的 CLI(探针 bin),不是本机。
    if let Some(ws) = workspace.as_deref() {
        if let Some(transport) =
            crate::engine::wsl_transport::transport_for_workspace(&state.db, ws)
        {
            if engine == "claude" {
                return Ok(wsl::claude_catalog_remote(&transport).await);
            }
            // 未知引擎暂无远程 catalog 命令形态:空目录 + remote 旗标,
            // 前端不掺本机配置 —— 发行版里的 CLI 用自己配置里的默认模型。
            return Ok(EngineCatalog::authoritative_remote(Vec::new()));
        }
    }
    if engine == "claude" {
        return Ok(claude_catalog());
    }
    // Unknown engine: no CLI-sourced catalog — the frontend fills the
    // picker from the configured provider channels.
    Ok(EngineCatalog::authoritative(Vec::new()))
}

fn claude_catalog() -> EngineCatalog {
    // CLI-sourced, and every entry is something `claude --model`
    // resolves — authoritative, so the frontend resets stale stored
    // picks (e.g. leftovers from the removed channel probe). The binary
    // path feeds the embedded-registry read (alias → concrete model id).
    let settings = crate::settings::read_settings().unwrap_or_default();
    let bin = super::engine_bin(&settings, "claude");
    let bin_path = super::resolve::find_cli_binary("claude", Some(&bin));
    EngineCatalog::authoritative(claude::claude_models(bin_path.as_deref()))
}

