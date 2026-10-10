//! 消息删除（「删除」按钮）：经 CLI 隐藏参数 `--delete-message <uuid>` 把一条
//! 转录条目就地移除——子链重接（子节点 parentUuid 指向被删条目的父）、被删
//! 条目自己的 tool_result 子条目随删、归档段（压缩前历史）同样可删，均由 CLI
//! 的会话存储层负责（`sessionMessageEdit.ts` 的定位/锁/快照与段语义）。
//!
//! 命令形态与 `--edit-message` 一致：一次性 `-p --resume <会话ID> --delete-message
//! <uuid> --output-format stream-json`，退出即止、不调用模型、不跑 hooks。
//! CLI 打一条机器结果行（`message_uuid` / `error_code` / `archived`），失败时
//! 细分原因在 `errors[]`；本命令把它解包为 `DeleteMessageOutcome` 供前端映射
//! 文案，错误码判定与 `edit_message` 的 `parse_edit_result` 同款严格。

use crate::engine::engine_bin;
use crate::engine::is_uuid_shaped;

/// One deleted message's outcome (the CLI's stream-json result line unwrapped).
#[derive(Debug, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeleteMessageOutcome {
    /// The CLI's failure code: None on success, else one of invalid_session /
    /// session_live / rotation_pending / not_found / not_deletable /
    /// file_changed / write_failed / unsupported_platform.
    pub error_code: Option<String>,
    /// True when the message lived in an archived pre-compaction segment.
    pub archived: bool,
    /// Human-readable detail from the CLI (success note or failure text).
    pub detail: String,
}

/// Delete one message (the CLI's hidden `--delete-message <message-uuid>`,
/// which requires `--resume`): a one-shot CLI run that exits right after the
/// rewrite, touching no hooks, history or model. A live session is refused up
/// front (this app's process registry) and again by the CLI (session_live).
#[tauri::command]
pub async fn delete_message(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    workspace_path: String,
    message_id: String,
) -> Result<DeleteMessageOutcome, String> {
    if engine != "claude" {
        return Err(format!("delete_message: unknown engine {engine}"));
    }
    let session_id = session_id.trim().to_string();
    let message_id = message_id.trim().to_string();
    if !is_uuid_shaped(&session_id) || !is_uuid_shaped(&message_id) {
        return Err("delete_message: invalid session or message id".into());
    }
    if !std::path::Path::new(&workspace_path).is_dir() {
        return Err("delete_message: workspace not found".into());
    }
    if state
        .processes
        .0
        .lock()
        .map_err(|e| e.to_string())?
        .get(&session_id)
        .is_some()
    {
        return Err("该会话仍在运行，回合结束后再删除这条消息".into());
    }
    let workspace = workspace_path.clone();
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let settings = crate::settings::read_settings().unwrap_or_default();
        let bin = engine_bin(&settings, &engine);
        // A one-shot transcript operation: no model calls, no hooks.
        let output = std::process::Command::new(&bin)
            .current_dir(&workspace)
            // The dev CLI keys the session's project directory off this
            // variable (see the send path); without it the resume may look
            // in the launcher's cwd instead of the workspace.
            .env("HZKCODE_DEV_CALLER_CWD", &workspace)
            .arg("-p")
            .arg("--resume")
            .arg(&session_id)
            .arg("--delete-message")
            .arg(&message_id)
            .arg("--output-format")
            .arg("stream-json")
            .stdin(std::process::Stdio::null())
            .output()
            .map_err(|e| format!("delete message: {e}"))?;
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);
        match parse_delete_result(&stdout, &message_id, output.status.success()) {
            Ok(outcome) => Ok(outcome),
            Err(reason) => Err(if stderr.trim().is_empty() {
                format!("delete message: {reason}")
            } else {
                stderr.trim().to_string()
            }),
        }
    })
    .await
    .map_err(|e| e.to_string())??;
    if outcome.error_code.is_none() {
        // The transcript on disk changed: every window re-reads the session
        // list (the first message doubles as the list summary), the same
        // notification the other file-level session operations send.
        state.sink.emit_sessions_changed();
    }
    Ok(outcome)
}

/// Unwrap the CLI's delete result line. The line must name the deleted message
/// (`message_uuid`) so a result from any other flow can never be mistaken for
/// this delete's verdict; a classified failure (`error_code`) is returned as
/// an outcome, while everything else that is not an explicit success
/// (`is_error:false` + `subtype:"success"` + a zero exit) is an error.
fn parse_delete_result(
    stdout: &str,
    message_id: &str,
    exit_ok: bool,
) -> Result<DeleteMessageOutcome, String> {
    let Some(value) = stdout
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|v| {
            v.get("type").and_then(|t| t.as_str()) == Some("result")
                && v.get("message_uuid").and_then(|u| u.as_str()) == Some(message_id)
        })
    else {
        return Err("no delete result line".into());
    };
    let detail = value
        .get("result")
        .and_then(|v| v.as_str())
        .map(str::to_string)
        .or_else(|| {
            value
                .get("errors")
                .and_then(|v| v.as_array())
                .and_then(|list| list.first())
                .and_then(|v| v.as_str())
                .map(str::to_string)
        })
        .unwrap_or_default();
    if let Some(code) = value.get("error_code").and_then(|v| v.as_str()) {
        return Ok(DeleteMessageOutcome {
            error_code: Some(code.to_string()),
            archived: value
                .get("archived")
                .and_then(|v| v.as_bool())
                .unwrap_or(false),
            detail,
        });
    }
    let is_error = value.get("is_error").and_then(|v| v.as_bool());
    let subtype = value.get("subtype").and_then(|v| v.as_str());
    if is_error != Some(false) || subtype != Some("success") {
        return Err(if detail.is_empty() {
            "delete did not succeed".into()
        } else {
            detail
        });
    }
    if !exit_ok {
        return Err("delete reported success but exited non-zero".into());
    }
    Ok(DeleteMessageOutcome {
        error_code: None,
        archived: value
            .get("archived")
            .and_then(|v| v.as_bool())
            .unwrap_or(false),
        detail,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn result_line(value: serde_json::Value) -> String {
        value.to_string()
    }

    #[test]
    fn parses_a_success_line_with_the_matching_message_uuid() {
        let stdout = format!(
            "{}\n",
            result_line(serde_json::json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "message_uuid": "m-1",
                "error_code": null,
                "archived": true,
                "result": "Deleted message m-1",
            }))
        );
        let outcome = parse_delete_result(&stdout, "m-1", true).unwrap();
        assert!(outcome.error_code.is_none());
        assert!(outcome.archived);
        assert_eq!(outcome.detail, "Deleted message m-1");
    }

    #[test]
    fn parses_a_classified_failure_with_its_detail() {
        let stdout = format!(
            "{}\n",
            result_line(serde_json::json!({
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": true,
                "message_uuid": "m-1",
                "error_code": "not_deletable",
                "archived": null,
                "errors": ["保留切片内，暂不支持删除"],
            }))
        );
        let outcome = parse_delete_result(&stdout, "m-1", false).unwrap();
        assert_eq!(outcome.error_code.as_deref(), Some("not_deletable"));
        assert_eq!(outcome.detail, "保留切片内，暂不支持删除");
    }

    #[test]
    fn ignores_a_result_line_for_another_message() {
        let stdout = format!(
            "{}\n",
            result_line(serde_json::json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "message_uuid": "m-2",
                "error_code": null,
            }))
        );
        let err = parse_delete_result(&stdout, "m-1", true).unwrap_err();
        assert!(err.contains("no delete result line"), "{err}");
    }

    #[test]
    fn treats_a_non_success_result_without_code_as_error() {
        let stdout = format!(
            "{}\n",
            result_line(serde_json::json!({
                "type": "result",
                "subtype": "error_during_execution",
                "is_error": true,
                "message_uuid": "m-1",
                "errors": ["引擎异常"],
            }))
        );
        let err = parse_delete_result(&stdout, "m-1", false).unwrap_err();
        assert_eq!(err, "引擎异常");
    }

    #[test]
    fn rejects_success_with_nonzero_exit() {
        let stdout = format!(
            "{}\n",
            result_line(serde_json::json!({
                "type": "result",
                "subtype": "success",
                "is_error": false,
                "message_uuid": "m-1",
                "error_code": null,
            }))
        );
        let err = parse_delete_result(&stdout, "m-1", false).unwrap_err();
        assert!(err.contains("exited non-zero"), "{err}");
    }
}
