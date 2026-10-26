//! 离线会话控制（引擎隐藏参数 `--session-control <JSON>`）：一次性进程，
//! 只读或改写会话控制记录，不调用模型、不跑 hooks。查询类操作不创建会话，
//! 修改类操作在没有 `--resume` 时创建一个只含控制记录的新会话。
//!
//! 环境与私有 `--settings` 叠加复用发送路径（应用 cliEnv + 渠道 env + 过滤）
//! 的同一套构建逻辑；基线 `--model` / `--effort` / `--permission-mode` 只填补
//! 调用方没有提供的值。结果行严格校验协议标识、来源/目标关系和退出码，
//! 分类失败（error_code）作为结果返回，解析失败不向调用方回显原始输出。

use super::{claude_channel, engine_bin, engine_by_id, is_uuid_shaped};
use crate::settings::AppSettings;
use serde_json::Value;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

const READONLY_OPERATIONS: &[&str] = &["catalog", "status"];
const MUTATING_OPERATIONS: &[&str] = &["prompt-mode", "identity", "interaction-mode", "api-mode"];

fn is_mutating(operation: &str) -> bool {
    MUTATING_OPERATIONS.contains(&operation)
}

/// 校验请求的稳定部分：operation 必须是已知值，各修改操作必须带合法
/// value / apply（具体组合由引擎再次校验）。只读查询不拒绝额外键，
/// 以便引擎扩展请求字段。
fn validate_request(request: &Value) -> Result<String, String> {
    let object = request
        .as_object()
        .ok_or("session_control: request must be a JSON object")?;
    let operation = object
        .get("operation")
        .and_then(Value::as_str)
        .ok_or("session_control: request is missing an operation")?;
    if !READONLY_OPERATIONS.contains(&operation) && !MUTATING_OPERATIONS.contains(&operation) {
        return Err(format!("session_control: unknown operation {operation}"));
    }
    let apply = object.get("apply").and_then(Value::as_str);
    match operation {
        "prompt-mode" => {
            match object.get("value").and_then(Value::as_str) {
                Some("full" | "compact" | "reset") => {}
                _ => return Err("session_control: prompt-mode needs full, compact or reset".into()),
            }
            if !matches!(apply, Some("current" | "clone")) {
                return Err("session_control: prompt-mode needs apply current or clone".into());
            }
        }
        "identity" => {
            let identity = object
                .get("value")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("session_control: identity needs an agent name or default")?;
            if !matches!(apply, Some("current" | "clone" | "append")) {
                return Err(
                    "session_control: identity needs apply current, clone or append".into(),
                );
            }
            if identity.eq_ignore_ascii_case("default") && apply == Some("append") {
                return Err("session_control: the default identity cannot be appended".into());
            }
        }
        "interaction-mode" => {
            if object
                .get("value")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .is_none()
            {
                return Err(
                    "session_control: interaction-mode needs a mode slug or reset".into(),
                );
            }
        }
        "api-mode" => {
            if !matches!(
                object.get("value").and_then(Value::as_str),
                Some("anthropic" | "responses" | "chat_completions" | "reset")
            ) {
                return Err(
                    "session_control: api-mode needs anthropic, responses, chat_completions or reset"
                        .into(),
                );
            }
        }
        _ => {}
    }
    if let Some(revision) = object.get("expectedRevision") {
        if !revision
            .as_str()
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false)
        {
            return Err("session_control: expectedRevision must be a non-empty string".into());
        }
    }
    Ok(operation.to_string())
}

/// 进程启动失败时同样清理含渠道凭据的临时设置。
struct StagedSettings(Option<PathBuf>);

impl Drop for StagedSettings {
    fn drop(&mut self) {
        if let Some(path) = self.0.take() {
            if let Err(error) = std::fs::remove_file(&path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "[engine] failed to remove session-control staging path {}: {error}",
                        path.display()
                    );
                }
            }
        }
    }
}

/// 先清理继承的渠道变量，再应用功能变量和渠道；私有设置保留显式空值。
fn apply_launch_env(
    command: &mut std::process::Command,
    settings: &AppSettings,
    provider: Option<&Value>,
    channel_env: &HashMap<String, String>,
) {
    for (key, _) in std::env::vars() {
        if crate::provider_files::is_provider_env_key(&key) {
            command.env_remove(&key);
        }
    }
    if provider.is_some() {
        command.env("HZKCODE_PROVIDER_MANAGED_BY_HOST", "1");
    }
    for (key, value) in crate::settings::feature_env(settings) {
        command.env(key, value);
    }
    for (key, value) in channel_env {
        command.env(key, value);
    }
}

fn resolve_baseline_model(
    settings: &AppSettings,
    selected: Option<&str>,
    provider: Option<&Value>,
    channel_env: &HashMap<String, String>,
) -> Option<String> {
    let selected = selected
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| settings.default_models.get("claude").cloned())
        .filter(|value| !value.trim().is_empty());
    claude_channel::resolve_model(selected.as_deref(), provider, channel_env)
}

fn resolve_baseline_effort(settings: &AppSettings, selected: Option<&str>) -> Option<String> {
    selected
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| settings.default_efforts.get("claude").cloned())
        .filter(|value| !value.trim().is_empty())
}

#[allow(clippy::too_many_arguments)]
fn run(
    engine: &str,
    workspace: &str,
    request: &Value,
    operation: &str,
    session_id: Option<&str>,
    provider_id: Option<&str>,
    agents_json: Option<&str>,
    model: Option<&str>,
    effort: Option<&str>,
    permission_mode: Option<&str>,
) -> Result<Value, String> {
    let provider_id = provider_id.filter(|value| !value.trim().is_empty());
    let provider = crate::config::resolve_provider(engine, provider_id)?;
    let channel_env = provider
        .as_ref()
        .map(|provider| crate::provider_files::channel_env(engine, provider))
        .transpose()?
        .unwrap_or_default();
    let settings = crate::settings::read_settings().unwrap_or_default();
    let model = resolve_baseline_model(&settings, model, provider.as_ref(), &channel_env);
    let effort = resolve_baseline_effort(&settings, effort);
    let bin = engine_bin(&settings, engine);

    let mut command = std::process::Command::new(&bin);
    command.current_dir(workspace);
    // 引擎按此路径定位会话，不能继承桌面应用的启动目录。
    command.env("HZKCODE_DEV_CALLER_CWD", workspace);
    apply_launch_env(&mut command, &settings, provider.as_ref(), &channel_env);

    let mut staged = StagedSettings(None);
    if let Some(provider) = provider.as_ref() {
        let path = claude_channel::write_staged_settings(
            provider,
            &channel_env,
            model.as_deref(),
            None,
            &crate::paths::app_home().join("claude-staging"),
        )?;
        command.arg("--settings").arg(&path);
        staged.0 = Some(path);
    }
    command
        .arg("--session-control")
        .arg(serde_json::to_string(request).map_err(|_| "session control: invalid request")?);
    if let Some(session_id) = session_id {
        command.arg("--resume").arg(session_id);
    }
    if let Some(agents_json) = agents_json
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        command.arg("--agents").arg(agents_json);
    }
    if let Some(model) = model.as_deref() {
        command.arg("--model").arg(model);
    }
    if let Some(effort) = effort.as_deref() {
        command.arg("--effort").arg(effort);
    }
    if let Some(permission_mode) = permission_mode
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        let resolved = engine_by_id(engine)
            .ok_or_else(|| format!("session control: unknown engine {engine}"))?
            .resolve_permission(Some(permission_mode));
        command.arg("--permission-mode").arg(if resolved == "bypass" {
            "bypassPermissions"
        } else {
            resolved
        });
    }

    let output = command
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|error| format!("session control: {error}"))?;
    let stdout = String::from_utf8_lossy(&output.stdout);
    let result = parse_session_control_result(
        &stdout,
        operation,
        session_id,
        output.status.success(),
    )?;
    if result["cloned"] == true && request["apply"] != "clone" {
        return Err("session control cloned without an explicit clone request".into());
    }
    Ok(result)
}

fn string_array(value: &Value) -> bool {
    value.as_array().is_some_and(|items| items.iter().all(Value::is_string))
}

fn valid_control_state(state: &Value) -> bool {
    let valid_value = |key: &str, accepts: &dyn Fn(&Value) -> bool| {
        state.get(key).is_some_and(|value| {
            value.get("effective").is_some_and(accepts)
                && value.get("override").is_some_and(|v| v.is_null() || accepts(v))
                && matches!(value["source"].as_str(), Some("session" | "startup"))
        })
    };
    state["hasConversation"].is_boolean()
        && state["identity"].get("base").is_some_and(|v| v.is_null() || v.is_string())
        && state["identity"]["extensions"].as_array().is_some_and(|items| items.iter().all(|item| {
            item["agentType"].is_string()
                && ["tools", "disallowedTools"].iter().all(|key| item.get(key).map_or(true, string_array))
        }))
        && state["availableApplyMethods"]["identity"].as_array().is_some_and(|items| items.iter().all(|v| matches!(v.as_str(), Some("current" | "clone" | "append"))))
        && state["availableApplyMethods"]["promptMode"].as_array().is_some_and(|items| items.iter().all(|v| matches!(v.as_str(), Some("current" | "clone"))))
        && valid_value("promptMode", &|v| matches!(v.as_str(), Some("full" | "compact")))
        && ["interactionMode", "apiMode", "model", "permission"].iter().all(|key| valid_value(key, &Value::is_string))
        && valid_value("effort", &|v| v.is_string() || v.is_number() || v.is_null())
}

fn valid_control_catalog(catalog: &Value) -> bool {
    catalog["identities"].as_array().is_some_and(|items| items.iter().all(|item| {
        ["id", "name", "description", "source"].iter().all(|key| item[key].is_string())
            && item.get("tools").is_some_and(|v| v.is_null() || string_array(v))
            && string_array(&item["disallowedTools"])
            && ["model", "permissionMode"].iter().all(|key| item.get(key).is_some_and(|v| v.is_null() || v.is_string()))
            && item.get("effort").is_some_and(|v| v.is_null() || v.is_string() || v.is_number())
    })) && catalog["interactionModes"].as_array().is_some_and(|items| items.iter().all(|item| {
        ["slug", "name", "description"].iter().all(|key| item[key].is_string())
    }))
}

/// 状态与退出码必须一致；不回显原始输出，防止错误中带出凭据。
fn parse_session_control_result(
    stdout: &str,
    operation: &str,
    source: Option<&str>,
    exit_ok: bool,
) -> Result<Value, String> {
    let mut lines = stdout.lines().filter(|line| !line.trim().is_empty());
    let value: Value = lines.next()
        .and_then(|line| serde_json::from_str(line).ok())
        .filter(|value: &Value| value["type"] == "result")
        .ok_or("no session control result line")?;
    if lines.next().is_some() {
        return Err("session control returned more than one result line".into());
    }
    if value.get("schemaVersion").and_then(Value::as_u64) != Some(1) {
        return Err("session control result has an unsupported schema version".into());
    }
    if value.get("operation").and_then(Value::as_str) != Some(operation) {
        return Err("session control result names another operation".into());
    }
    // 来源解析前失败可能返回 null；已回显的来源必须与请求一致。
    let source_echoed = match value.get("sourceSessionId") {
        Some(Value::Null) => Some(None),
        Some(Value::String(id)) => Some(Some(id.as_str())),
        _ => None,
    };
    let target = match value.get("targetSessionId") {
        Some(Value::Null) => None,
        Some(Value::String(id)) => Some(id.as_str()),
        _ => return Err("session control result has no valid target session".into()),
    };
    if !matches!(value.get("cloned"), Some(Value::Bool(_))) {
        return Err("session control result is missing its clone flag".into());
    }
    let cloned = value
        .get("cloned")
        .and_then(Value::as_bool)
        .expect("clone flag checked");
    let is_error = value
        .get("is_error")
        .and_then(Value::as_bool)
        .ok_or("session control result is missing is_error")?;
    let subtype = value
        .get("subtype")
        .and_then(Value::as_str)
        .ok_or("session control result is missing its subtype")?;
    if is_error {
        if subtype != "error_during_execution" {
            return Err("session control failure has the wrong subtype".into());
        }
        if exit_ok {
            return Err("session control reported a failure but exited zero".into());
        }
        // 失败不采纳目标，但回显的来源仍需匹配。
        match source_echoed {
            Some(None) => {}
            Some(Some(id)) if Some(id) == source => {}
            _ => return Err("session control result names another source session".into()),
        }
    } else {
        if subtype != "success" {
            return Err("session control success has the wrong subtype".into());
        }
        if !exit_ok {
            return Err("session control reported success but exited non-zero".into());
        }
        if source_echoed != Some(source) {
            return Err("session control result names another source session".into());
        }
        match value.get("error_code") {
            Some(Value::Null) | None => {}
            _ => return Err("session control success carries an error code".into()),
        }
        if !matches!(value.get("state"), Some(Value::Object(_))) {
            return Err("session control success is missing its state".into());
        }
        match operation {
            "catalog" => {
                if target.is_some() {
                    return Err("catalog must not create or name a target session".into());
                }
                if !matches!(
                    value.pointer("/catalog/identities"),
                    Some(Value::Array(_))
                ) || !matches!(
                    value.pointer("/catalog/interactionModes"),
                    Some(Value::Array(_))
                ) {
                    return Err("session control catalog result is missing its catalog".into());
                }
            }
            "status" => {
                if target.is_some() {
                    return Err("status must not create or name a target session".into());
                }
            }
            _ => match (source, target) {
                (None, None) => {
                    return Err("session control change did not return a target session".into())
                }
                (None, Some(_)) if cloned => {
                    return Err("a new session cannot also be a clone".into())
                }
                (None, Some(_)) => {}
                (Some(_), None) => {
                    return Err("session control change lost its target session".into())
                }
                (Some(source), Some(target)) if cloned && source == target => {
                    return Err("a cloned change must name a new target session".into())
                }
                (Some(source), Some(target)) if !cloned && source != target => {
                    return Err("an in-place change must keep the source session".into())
                }
                _ => {}
            },
        }
    }
    if !matches!(value.get("session_id"), Some(Value::Null | Value::String(_))) {
        return Err("session control result is missing its session id".into());
    }
    if is_error {
        if target.is_some() || cloned
            || !value["error_code"].as_str().is_some_and(|code| !code.is_empty())
            || value.get("state") != Some(&Value::Null)
            || value.get("revision") != Some(&Value::Null)
        {
            return Err("session control failure carries an invalid outcome".into());
        }
        let echoed = source_echoed.flatten();
        if value.get("session_id") != Some(&Value::Null)
            && value["session_id"].as_str() != echoed
        {
            return Err("session control failure names another session".into());
        }
    } else {
        if cloned && !matches!(operation, "identity" | "prompt-mode") {
            return Err("this session control operation cannot clone".into());
        }
        if target.is_some_and(|id| !is_uuid_shaped(id)) {
            return Err("session control target is not a session UUID".into());
        }
        let expected_id = target.or(source);
        if value.get("session_id") != Some(&serde_json::json!(expected_id)) {
            return Err("session control result has an inconsistent session id".into());
        }
        if !matches!(value.get("revision"), Some(Value::Null | Value::String(_)))
            || (expected_id.is_none() && value.get("revision") != Some(&Value::Null))
            || (expected_id.is_some() && !value["revision"].as_str().is_some_and(|r| !r.is_empty()))
        {
            return Err("session control result has an invalid revision".into());
        }
        if value.get("error_code") != Some(&Value::Null) || !valid_control_state(&value["state"]) {
            return Err("session control result has an invalid state".into());
        }
        if operation == "catalog" && !valid_control_catalog(&value["catalog"]) {
            return Err("session control result has an invalid catalog".into());
        }
    }
    if let Some(scope) = value.get("toolScope") {
        if !string_array(&scope["addedTools"]) || !string_array(&scope["unavailableTools"]) {
            return Err("session control result has an invalid tool scope".into());
        }
    }
    if value.get("errors").is_some_and(|errors| !string_array(errors)) {
        return Err("session control result has invalid errors".into());
    }
    Ok(value)
}

/// 修改成功后在返回前同步登记目标会话的历史索引（纯元数据会话也有文件）；
/// 查询与失败不登记。索引失败时引擎修改已经保存，错误信息必须说明这一点，
/// 不能伪装成回滚。
fn index_control_outcome(
    db: &crate::db::Db,
    workspace: &str,
    outcome: &Value,
    mutating: bool,
) -> Result<(), String> {
    if !mutating || outcome.get("is_error").and_then(Value::as_bool) != Some(false) {
        return Ok(());
    }
    let target = outcome
        .get("targetSessionId")
        .and_then(Value::as_str)
        .ok_or("会话控制修改已保存，但结果没有目标会话，历史索引未登记")?;
    crate::history::scanner::index_session_file(db, workspace, target)
        .map_err(|error| format!("会话控制修改已保存，但历史索引登记失败：{error}"))
}

/// 查询或修改一个会话的离线控制状态。修改成功先同步登记目标会话的历史
/// 索引，再广播会话变更；查询与分类失败不广播。运行中的会话拒绝修改
/// （GUI 侧先拦，CLI 侧还有锁）。
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn session_control(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    workspace_path: String,
    request: Value,
    session_id: Option<String>,
    provider_id: Option<String>,
    agents_json: Option<String>,
    model: Option<String>,
    effort: Option<String>,
    permission_mode: Option<String>,
) -> Result<Value, String> {
    if engine != "claude" {
        return Err(format!("session_control: unknown engine {engine}"));
    }
    if !Path::new(&workspace_path).is_dir() {
        return Err("session_control: workspace not found".into());
    }
    let operation = validate_request(&request)?;
    let session_id = session_id
        .map(|id| id.trim().to_string())
        .filter(|id| !id.is_empty());
    if let Some(id) = session_id.as_deref() {
        if !is_uuid_shaped(id) {
            return Err("session_control: invalid session id".into());
        }
    }
    let mutating = is_mutating(&operation);
    if mutating {
        if let Some(id) = session_id.as_deref() {
            if state
                .processes
                .0
                .lock()
                .map_err(|error| error.to_string())?
                .get(id)
                .is_some()
            {
                return Err("该会话仍在运行，回合结束后再修改会话控制".into());
            }
        }
    }
    let db = std::sync::Arc::clone(&state.db);
    let engine_id = engine.clone();
    let workspace = workspace_path.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let outcome = run(
            &engine_id,
            &workspace,
            &request,
            &operation,
            session_id.as_deref(),
            provider_id.as_deref(),
            agents_json.as_deref(),
            model.as_deref(),
            effort.as_deref(),
            permission_mode.as_deref(),
        )?;
        index_control_outcome(&db, &workspace, &outcome, mutating)?;
        Ok::<Value, String>(outcome)
    })
    .await
    .map_err(|error| error.to_string())??;
    if mutating && outcome.get("is_error").and_then(Value::as_bool) == Some(false) {
        // 仅确认写入与索引登记成功后通知其他窗口刷新，查询与失败不广播。
        state.sink.emit_sessions_changed();
    }
    Ok(outcome)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(value: Value) -> String {
        format!("{}\n", serde_json::to_string(&value).unwrap())
    }

    fn success(operation: &str, source: Option<&str>, target: Option<&str>) -> Value {
        serde_json::json!({
            "type": "result",
            "operation": operation,
            "schemaVersion": 1,
            "sourceSessionId": source,
            "targetSessionId": target,
            "session_id": target.or(source),
            "cloned": false,
            "is_error": false,
            "subtype": "success",
            "error_code": null,
            "revision": target.or(source).map(|_| "r-1"),
            "state": {
                "hasConversation": source.is_some(),
                "availableApplyMethods": {"identity": ["current", "clone", "append"], "promptMode": ["current", "clone"]},
                "identity": {"base": null, "extensions": []},
                "promptMode": {"effective": "full", "override": null, "source": "startup"},
                "interactionMode": {"effective": "default", "override": null, "source": "startup"},
                "apiMode": {"effective": "anthropic", "override": null, "source": "startup"},
                "model": {"effective": "mid", "override": null, "source": "startup"},
                "effort": {"effective": null, "override": null, "source": "startup"},
                "permission": {"effective": "autoContinue", "override": null, "source": "startup"}
            },
        })
    }

    #[test]
    fn rejects_success_lines_with_nonzero_exit() {
        let stdout = line(success("status", Some("11111111-1111-4111-8111-111111111111"), Some("11111111-1111-4111-8111-111111111111")));
        let error = parse_session_control_result(&stdout, "status", Some("11111111-1111-4111-8111-111111111111"), false).unwrap_err();
        assert!(error.contains("exited non-zero"), "{error}");
    }

    #[test]
    fn rejects_a_result_for_another_operation() {
        let stdout = line(success("status", Some("11111111-1111-4111-8111-111111111111"), Some("11111111-1111-4111-8111-111111111111")));
        let error =
            parse_session_control_result(&stdout, "prompt-mode", Some("11111111-1111-4111-8111-111111111111"), true).unwrap_err();
        assert!(error.contains("another operation"), "{error}");
    }

    #[test]
    fn rejects_an_unsupported_schema_version() {
        let mut value = success("status", None, None);
        value["schemaVersion"] = serde_json::json!(2);
        let error = parse_session_control_result(&line(value), "status", None, true).unwrap_err();
        assert!(error.contains("schema version"), "{error}");
    }

    #[test]
    fn rejects_a_mismatched_source_session() {
        let stdout = line(success("status", Some("22222222-2222-4222-8222-222222222222"), Some("22222222-2222-4222-8222-222222222222")));
        let error = parse_session_control_result(&stdout, "status", Some("11111111-1111-4111-8111-111111111111"), true).unwrap_err();
        assert!(error.contains("source session"), "{error}");
    }

    #[test]
    fn accepts_a_classified_failure_as_an_outcome() {
        let stdout = line(serde_json::json!({
            "type": "result",
            "operation": "prompt-mode",
            "schemaVersion": 1,
            "sourceSessionId": "11111111-1111-4111-8111-111111111111",
            "targetSessionId": null,
            "session_id": null,
            "cloned": false,
            "is_error": true,
            "subtype": "error_during_execution",
            "error_code": "file_changed",
            "revision": null,
            "state": null,
        }));
        let value =
            parse_session_control_result(&stdout, "prompt-mode", Some("11111111-1111-4111-8111-111111111111"), false).unwrap();
        assert_eq!(value["error_code"], "file_changed");
    }

    #[test]
    fn a_failure_before_the_source_resolves_may_omit_the_source() {
        let stdout = line(serde_json::json!({
            "type": "result",
            "operation": "status",
            "schemaVersion": 1,
            "sourceSessionId": null,
            "targetSessionId": null,
            "session_id": null,
            "cloned": false,
            "is_error": true,
            "subtype": "error_during_execution",
            "error_code": "invalid_session",
            "revision": null,
            "state": null,
        }));
        let value =
            parse_session_control_result(&stdout, "status", Some("11111111-1111-4111-8111-111111111111"), false).unwrap();
        assert_eq!(value["error_code"], "invalid_session");
    }

    #[test]
    fn rejects_a_failure_line_that_exited_zero() {
        let stdout = line(serde_json::json!({
            "type": "result",
            "operation": "prompt-mode",
            "schemaVersion": 1,
            "sourceSessionId": "11111111-1111-4111-8111-111111111111",
            "targetSessionId": null,
            "session_id": null,
            "cloned": false,
            "is_error": true,
            "subtype": "error_during_execution",
            "error_code": "not_found",
            "revision": null,
            "state": null,
        }));
        let error =
            parse_session_control_result(&stdout, "prompt-mode", Some("11111111-1111-4111-8111-111111111111"), true).unwrap_err();
        assert!(error.contains("exited zero"), "{error}");
    }

    #[test]
    fn rejects_is_error_and_subtype_that_disagree() {
        let mut value = success("status", None, None);
        value["is_error"] = serde_json::json!(true);
        let error = parse_session_control_result(&line(value), "status", None, true).unwrap_err();
        assert!(error.contains("wrong subtype"), "{error}");
    }

    #[test]
    fn accepts_a_catalog_with_identities_and_modes() {
        let mut value = success("catalog", None, None);
        value["catalog"] = serde_json::json!({
            "identities": [],
            "interactionModes": [],
        });
        let parsed = parse_session_control_result(&line(value), "catalog", None, true).unwrap();
        assert_eq!(parsed["operation"], "catalog");
    }

    #[test]
    fn success_requires_a_state_snapshot() {
        let mut value = success("status", None, None);
        value["state"] = Value::Null;
        let error = parse_session_control_result(&line(value), "status", None, true).unwrap_err();
        assert!(error.contains("missing its state"), "{error}");
    }

    #[test]
    fn catalog_must_not_name_a_target_session() {
        let mut value = success("catalog", None, Some("11111111-1111-4111-8111-111111111111"));
        value["catalog"] = serde_json::json!({"identities": [], "interactionModes": []});
        let error = parse_session_control_result(&line(value), "catalog", None, true).unwrap_err();
        assert!(error.contains("must not create"), "{error}");
    }

    #[test]
    fn status_without_a_source_must_not_create_a_session() {
        let stdout = line(success("status", None, Some("11111111-1111-4111-8111-111111111111")));
        let error = parse_session_control_result(&stdout, "status", None, true).unwrap_err();
        assert!(error.contains("must not create"), "{error}");
    }

    #[test]
    fn a_change_without_resume_returns_a_new_target_session() {
        let stdout = line(success("prompt-mode", None, Some("33333333-3333-4333-8333-333333333333")));
        let value = parse_session_control_result(&stdout, "prompt-mode", None, true).unwrap();
        assert_eq!(value["targetSessionId"], "33333333-3333-4333-8333-333333333333");

        let stdout = line(success("prompt-mode", None, None));
        let error = parse_session_control_result(&stdout, "prompt-mode", None, true).unwrap_err();
        assert!(error.contains("did not return"), "{error}");
    }

    #[test]
    fn cloned_changes_must_target_a_different_session() {
        let mut value = success("identity", Some("11111111-1111-4111-8111-111111111111"), Some("22222222-2222-4222-8222-222222222222"));
        value["cloned"] = serde_json::json!(true);
        let stdout = line(value);
        assert!(parse_session_control_result(&stdout, "identity", Some("11111111-1111-4111-8111-111111111111"), true).is_ok());

        let mut same = success("identity", Some("11111111-1111-4111-8111-111111111111"), Some("11111111-1111-4111-8111-111111111111"));
        same["cloned"] = serde_json::json!(true);
        let error =
            parse_session_control_result(&line(same), "identity", Some("11111111-1111-4111-8111-111111111111"), true).unwrap_err();
        assert!(error.contains("new target session"), "{error}");
    }

    #[test]
    fn in_place_changes_must_keep_the_source_session() {
        let stdout = line(success("api-mode", Some("11111111-1111-4111-8111-111111111111"), Some("22222222-2222-4222-8222-222222222222")));
        let error =
            parse_session_control_result(&stdout, "api-mode", Some("11111111-1111-4111-8111-111111111111"), true).unwrap_err();
        assert!(error.contains("keep the source"), "{error}");
    }

    #[test]
    fn missing_result_line_is_rejected_without_echoing_output() {
        let error = parse_session_control_result("boom\n", "status", None, false).unwrap_err();
        assert!(error.contains("no session control result line"), "{error}");
    }

    #[test]
    fn rejects_incomplete_or_inconsistent_success_payloads() {
        let base = success("status", None, None);
        for pointer in [
            "/state/hasConversation", "/state/identity/extensions",
            "/state/availableApplyMethods", "/state/model/effective",
            "/state/effort/source", "/session_id",
        ] {
            let mut value = base.clone();
            *value.pointer_mut(pointer).unwrap() = serde_json::json!({});
            assert!(parse_session_control_result(&line(value), "status", None, true).is_err());
        }
        let mut query_clone = base.clone();
        query_clone["cloned"] = serde_json::json!(true);
        assert!(parse_session_control_result(&line(query_clone), "status", None, true).is_err());
        let mut bad_target = success("identity", None, Some("not-a-uuid"));
        assert!(parse_session_control_result(&line(bad_target.clone()), "identity", None, true).is_err());
        bad_target["targetSessionId"] = serde_json::json!("33333333-3333-4333-8333-333333333333");
        assert!(parse_session_control_result(&line(bad_target), "identity", None, true).is_err());
        let repeated = format!("{}{}", line(base.clone()), line(base));
        assert!(parse_session_control_result(&repeated, "status", None, true).is_err());
    }

    #[test]
    fn failure_must_not_claim_a_target_or_a_successful_mutation() {
        let base = serde_json::json!({
            "type": "result", "schemaVersion": 1, "operation": "identity",
            "sourceSessionId": null, "targetSessionId": null, "session_id": null,
            "cloned": false, "is_error": true, "subtype": "error_during_execution",
            "error_code": "unknown_identity", "revision": null, "state": null,
        });
        assert!(parse_session_control_result(&line(base.clone()), "identity", None, false).is_ok());
        for (key, invalid) in [
            ("cloned", serde_json::json!(true)),
            ("targetSessionId", serde_json::json!("33333333-3333-4333-8333-333333333333")),
            ("error_code", Value::Null),
        ] {
            let mut value = base.clone();
            value[key] = invalid;
            assert!(parse_session_control_result(&line(value), "identity", None, false).is_err());
        }
    }

    #[test]
    fn validate_request_checks_the_stable_matrix() {
        for request in [
            serde_json::json!({"operation": "catalog"}),
            serde_json::json!({"operation": "status"}),
            serde_json::json!({"operation": "prompt-mode", "value": "compact", "apply": "clone"}),
            serde_json::json!({"operation": "identity", "value": "leader", "apply": "append"}),
            serde_json::json!({"operation": "interaction-mode", "value": "lead"}),
            serde_json::json!({"operation": "api-mode", "value": "responses"}),
        ] {
            assert!(validate_request(&request).is_ok(), "{request}");
        }
        for request in [
            serde_json::json!({}),
            serde_json::json!({"operation": "unknown"}),
            serde_json::json!({"operation": "prompt-mode", "value": "compact"}),
            serde_json::json!({"operation": "identity", "value": "default", "apply": "append"}),
            serde_json::json!({"operation": "identity", "value": " ", "apply": "current"}),
            serde_json::json!({"operation": "api-mode", "value": "openai"}),
            serde_json::json!({"operation": "status", "expectedRevision": ""}),
        ] {
            assert!(validate_request(&request).is_err(), "{request}");
        }
    }

    #[test]
    fn mutating_operations_are_the_four_changes() {
        assert!(!is_mutating("catalog"));
        assert!(!is_mutating("status"));
        for operation in ["prompt-mode", "identity", "interaction-mode", "api-mode"] {
            assert!(is_mutating(operation), "{operation}");
        }
    }

    #[test]
    fn successful_changes_index_targets_but_queries_and_failures_do_not() {
        let _lock = crate::test_support::HOME_ENV_LOCK.lock();
        let root = std::env::temp_dir().join(format!(
            "hzkcode-control-index-{}",
            uuid::Uuid::new_v4()
        ));
        crate::test_support::guard_test_write(&root).unwrap();
        std::fs::create_dir_all(&root).unwrap();
        struct RestoreEnv(Option<std::ffi::OsString>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                match &self.0 {
                    Some(value) => std::env::set_var("HZKCODE_CONFIG_DIR", value),
                    None => std::env::remove_var("HZKCODE_CONFIG_DIR"),
                }
            }
        }
        let _restore = RestoreEnv(std::env::var_os("HZKCODE_CONFIG_DIR"));
        let config_dir = root.join("config");
        let workspace = root.join("workspace");
        std::fs::create_dir_all(&workspace).unwrap();
        std::env::set_var("HZKCODE_CONFIG_DIR", &config_dir);
        let encoded = crate::history::claude_encode_project_path(&workspace.to_string_lossy());
        let project_dir = config_dir.join("projects").join(&encoded);
        std::fs::create_dir_all(&project_dir).unwrap();
        let write_metadata = |id: &str, mode: &str| {
            let entry = serde_json::json!({
                "type": "prompt-mode",
                "sessionId": id,
                "mode": mode,
                "timestamp": "2026-10-26T00:00:00.000Z"
            });
            std::fs::write(
                project_dir.join(format!("{id}.jsonl")),
                format!("{}\n", entry),
            )
            .unwrap();
        };
        let db = crate::db::Db::open_at(&root.join("gui.db")).unwrap();
        let workspace_text = workspace.to_str().unwrap();
        let outcome = |target: &str| {
            serde_json::json!({
                "type": "result",
                "targetSessionId": target,
                "is_error": false,
            })
        };
        let count = |id: &str| -> i64 {
            db.0.lock()
                .query_row(
                    "SELECT COUNT(*) FROM sessions WHERE engine='claude' AND session_id=?1",
                    rusqlite::params![id],
                    |row| row.get(0),
                )
                .unwrap()
        };

        let current = "22222222-2222-4222-8222-222222222222";
        let clone = "33333333-3333-4333-8333-333333333333";
        write_metadata(current, "compact");
        write_metadata(clone, "full");

        // 只读操作不登记。
        index_control_outcome(&db, workspace_text, &outcome(current), false).unwrap();
        assert_eq!(count(current), 0);

        // 克隆登记新目标；源会话不因克隆被登记。
        let cloned = serde_json::json!({
            "type": "result",
            "targetSessionId": clone,
            "cloned": true,
            "is_error": false,
        });
        index_control_outcome(&db, workspace_text, &cloned, true).unwrap();
        assert_eq!(count(clone), 1);
        assert_eq!(count(current), 0);

        // 当前会话的新建与原地修改都登记目标；重复登记只更新同一行。
        index_control_outcome(&db, workspace_text, &outcome(current), true).unwrap();
        assert_eq!(count(current), 1);
        write_metadata(current, "full");
        index_control_outcome(&db, workspace_text, &outcome(current), true).unwrap();
        assert_eq!(count(current), 1);

        // 失败的修改不登记。
        let failed = serde_json::json!({
            "type": "result",
            "targetSessionId": current,
            "is_error": true,
            "error_code": "file_changed",
        });
        index_control_outcome(&db, workspace_text, &failed, true).unwrap();
        assert_eq!(count(current), 1);

        // 目标文件缺失时明确报错，同时说明引擎修改已保存。
        let missing = serde_json::json!({
            "type": "result",
            "targetSessionId": "55555555-5555-4555-8555-555555555555",
            "is_error": false,
        });
        assert!(index_control_outcome(&db, workspace_text, &missing, true).is_err());

        std::fs::remove_dir_all(&root).ok();
    }

    #[test]
    #[ignore = "需要 HZKCODE_TEST_CLI 指向实际 3.5.1 引擎"]
    fn real_session_control_roundtrip() {
        let _lock = crate::test_support::HOME_ENV_LOCK.lock();
        let binary = std::env::var("HZKCODE_TEST_CLI").expect("HZKCODE_TEST_CLI");
        let root = std::env::temp_dir().join(format!("hzkcode-control-{}", uuid::Uuid::new_v4()));
        crate::test_support::guard_test_write(&root).unwrap();
        std::fs::create_dir_all(root.join(".hzkcode/gui")).unwrap();
        std::fs::create_dir_all(root.join("workspace")).unwrap();
        struct RestoreEnv(Vec<(&'static str, Option<std::ffi::OsString>)>);
        impl Drop for RestoreEnv {
            fn drop(&mut self) {
                for (key, value) in &self.0 {
                    match value {
                        Some(value) => std::env::set_var(key, value),
                        None => std::env::remove_var(key),
                    }
                }
            }
        }
        let _restore = RestoreEnv(["HOME", "HZKCODE_CONFIG_DIR"].into_iter()
            .map(|key| (key, std::env::var_os(key))).collect());
        std::env::set_var("HOME", &root);
        std::env::set_var("HZKCODE_CONFIG_DIR", root.join(".hzkcode"));
        crate::settings::atomic_write(&root.join(".hzkcode/gui/settings.json"),
            &serde_json::json!({"claudeBin": binary, "defaultModels": {"claude": "old-default"}, "defaultEfforts": {"claude": "max"}}).to_string()).unwrap();
        let launch = super::super::prepare_launch(
            "claude", root.join("workspace").to_str().unwrap(),
            Some("11111111-1111-4111-8111-111111111111".into()), "probe".into(),
            None, None, None, None, Vec::new(), None, None, None, None,
            None, None, None, None,
        ).unwrap();
        assert!(launch.req.model.is_none());
        assert!(launch.req.effort.is_none());
        let args: Vec<_> = launch.built.command.as_std().get_args().collect();
        for flag in ["--model", "--effort", "--permission-mode"] {
            assert!(!args.iter().any(|arg| *arg == std::ffi::OsStr::new(flag)));
        }
        let definitions = serde_json::json!({"gui-probe": {
            "description": "会话控制验证", "prompt": "仅用于隔离验证。", "tools": ["Read"], "model": "mid", "effort": "off"
        }}).to_string();
        let workspace = root.join("workspace");
        let db = crate::db::Db::open_at(&root.join(".hzkcode/gui/history.db")).unwrap();
        let indexed_count = |id: &str| -> i64 {
            db.0.lock()
                .query_row(
                    "SELECT COUNT(*) FROM sessions WHERE engine='claude' AND session_id=?1",
                    rusqlite::params![id],
                    |row| row.get(0),
                )
                .unwrap()
        };
        let invoke = |request: Value, id: Option<&str>| {
            let operation = request["operation"].as_str().unwrap();
            let outcome = run("claude", workspace.to_str().unwrap(), &request,
                operation, id, None,
                Some(&definitions), Some("mid"), Some("off"), Some("readonlyAutoContinue")).unwrap();
            index_control_outcome(
                &db,
                workspace.to_str().unwrap(),
                &outcome,
                is_mutating(operation),
            )
            .unwrap();
            outcome
        };
        let catalog = invoke(serde_json::json!({"operation": "catalog"}), None);
        assert_eq!(catalog["targetSessionId"], Value::Null);
        assert_eq!(catalog["state"]["permission"]["effective"], "readonlyAutoContinue");
        assert!(catalog["catalog"]["identities"].as_array().unwrap().iter().any(|item| item["id"] == "gui-probe"));
        let identity = invoke(serde_json::json!({"operation": "identity", "value": "gui-probe", "apply": "current"}), None);
        let id = identity["targetSessionId"].as_str().unwrap();
        assert_eq!(identity["is_error"], false);
        assert_eq!(identity["state"]["identity"]["base"], "gui-probe");
        assert_eq!(identity["state"]["hasConversation"], false);
        // 纯元数据新会话在返回前已经登记，立即读取应得到空历史而非找不到会话。
        assert_eq!(indexed_count(id), 1);
        let indexed_path = crate::history::reader::session_file_path(&db, "claude", id).unwrap();
        let history = crate::history::parse_session_file("claude", &indexed_path).unwrap();
        assert!(history.messages.is_empty());
        let prompt = invoke(serde_json::json!({"operation": "prompt-mode", "value": "compact", "apply": "clone"}), Some(id));
        assert_eq!(prompt["targetSessionId"], id);
        assert_eq!(prompt["cloned"], false);
        assert_eq!(prompt["state"]["promptMode"]["effective"], "compact");
        let conflict = invoke(serde_json::json!({"operation": "identity", "value": "default", "apply": "current", "expectedRevision": identity["revision"]}), Some(id));
        assert_eq!(conflict["error_code"], "file_changed");
        // 失败与只读操作都不新增或改写登记行。
        assert_eq!(indexed_count(id), 1);
        let status = invoke(serde_json::json!({"operation": "status"}), Some(id));
        assert_eq!(status["state"]["identity"]["base"], "gui-probe");
        assert_eq!(status["state"]["promptMode"]["effective"], "compact");
        assert_eq!(indexed_count(id), 1);
        let mode = invoke(serde_json::json!({"operation": "interaction-mode", "value": "lead"}), Some(id));
        assert_eq!(mode["is_error"], false);
        assert_eq!(mode["state"]["interactionMode"]["effective"], "lead");
        let api = invoke(serde_json::json!({"operation": "api-mode", "value": "responses"}), Some(id));
        assert_eq!(api["state"]["apiMode"]["override"], "responses");
        let reset = invoke(serde_json::json!({"operation": "api-mode", "value": "reset"}), Some(id));
        assert_eq!(reset["state"]["apiMode"]["override"], Value::Null);
        assert_eq!(reset["state"]["apiMode"]["source"], "startup");
        eprintln!("离线控制往返通过，隔离目录：{}", root.display());
    }

    #[test]
    fn launch_env_keeps_an_explicit_empty_endpoint() {
        let settings = AppSettings::default();
        let provider = serde_json::json!({});
        let channel_env = HashMap::from([
            ("HZKCODE_BASE_URL_ENDPOINT".to_string(), String::new()),
            ("HZKCODE_API_MODE".to_string(), "responses".to_string()),
        ]);
        let mut command = std::process::Command::new("claude");
        apply_launch_env(&mut command, &settings, Some(&provider), &channel_env);
        let env: HashMap<_, _> = command
            .get_envs()
            .filter_map(|(key, value)| {
                Some((key.to_string_lossy().to_string(), value?.to_string_lossy().to_string()))
            })
            .collect();
        assert_eq!(env.get("HZKCODE_BASE_URL_ENDPOINT").map(String::as_str), Some(""));
        assert_eq!(env.get("HZKCODE_API_MODE").map(String::as_str), Some("responses"));
        assert_eq!(
            env.get("HZKCODE_PROVIDER_MANAGED_BY_HOST").map(String::as_str),
            Some("1")
        );
    }
}
