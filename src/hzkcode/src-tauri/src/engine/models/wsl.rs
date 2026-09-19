//! WSL 发行版内的 claude 模型目录:经 wsl_transport 远程读发行版
//! `$CLAUDE_CONFIG_DIR` 下的 settings.json。远程 catalog 都带 remote
//! 旗标:即使为空,前端也不得掺本机配置。

use super::EngineCatalog;

use crate::engine::wsl_transport::WslTransport;

/// Claude 远程目录:CLI 别名是内置常量,逐字段合并发行版
/// `$CLAUDE_CONFIG_DIR` 的 settings.json / settings.local.json(与本机
/// read_cli_config_from 同一合并语义),复现 distro 自己的 /model 菜单。
pub(super) async fn claude_catalog_remote(transport: &WslTransport) -> EngineCatalog {
    // 随机分隔符:固定串可能出现在 settings 内容里(env 值等),split_once
    // 取首次出现会把 user settings 后半截当 local 合并,优先级错乱。
    let sep = format!("=HZKCODE_SEP_{}=", uuid::Uuid::new_v4().simple());
    let script = format!(
        r#"d="${{CLAUDE_CONFIG_DIR:-$HOME/.claude}}"; cat "$d/settings.json" 2>/dev/null; echo "{sep}"; cat "$d/settings.local.json" 2>/dev/null"#
    );
    let out = crate::engine::wsl_transport::run_script_output(transport, &script)
        .await
        .unwrap_or_default();
    let (user, local) = match out.split_once(&sep) {
        Some((u, l)) => (u, l),
        None => (out.as_str(), ""),
    };
    EngineCatalog::authoritative_remote(super::claude::claude_models_remote(user, local))
}

