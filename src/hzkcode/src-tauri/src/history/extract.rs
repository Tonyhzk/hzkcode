use super::{content_text, parse_ts_ms_str, Message};
use serde_json::Value;
use std::collections::HashMap;
use std::io::BufRead;
use std::path::Path;

pub struct ParsedSession {
    pub messages: Vec<Message>,
}

/// Parse a native session file into the minimal message list. Bad lines are
/// skipped individually. A segmented (compacted) session is parsed as its
/// whole root → active segment chain, so the full history stays visible the
/// way the pre-segmentation single file carried it.
pub fn parse_session_file(engine: &str, path: &Path) -> Result<ParsedSession, String> {
    let files = super::segments::session_files_for_read(engine, path);
    let extract = extractor_for(engine, ImageMode::Collect);
    let mut rows: Vec<LineRow> = Vec::new();
    for file in &files {
        let reader = match open_line_reader(file) {
            Ok(reader) => reader,
            // The primary (active) file surfaces its real error; an unreadable
            // archive segment only trims history and must not fail the parse.
            Err(error) if file.as_path() == path => return Err(error),
            Err(_) => continue,
        };
        walk_lines(reader, &extract, |row| rows.push(row));
    }
    Ok(fold_rows(rows))
}

/// Everything the sidebar needs from a scan: title/preview/timestamps/count.
/// Derived in one streaming pass without materializing the message list or
/// any image data URLs.
pub struct ScanSummary {
    pub title: String,
    pub preview: String,
    pub first_ts: Option<i64>,
    pub last_ts: Option<i64>,
    pub message_count: i64,
}

/// The scan-time parse: same line walk as `parse_session_file`, but folds
/// each row into a bounded accumulator instead of a Vec<Message>. Image-only
/// user turns (whose data URLs are skipped here) fall out of the count —
/// the sidebar counts text, and the reader path stays authoritative.
/// Segmented sessions fold the whole root → active chain.
pub fn scan_summary_file(engine: &str, path: &Path) -> Result<ScanSummary, String> {
    let files = super::segments::session_files_for_read(engine, path);
    let extract = extractor_for(engine, ImageMode::SkipDataUrls);
    let mut acc = ScanAcc::default();
    for file in &files {
        let reader = match open_line_reader(file) {
            Ok(reader) => reader,
            Err(error) if file.as_path() == path => return Err(error),
            Err(_) => continue,
        };
        walk_lines(reader, &extract, |row| {
            acc.accept(row);
        });
    }
    Ok(acc.finish())
}

/// Session files are plain NDJSON.
fn open_line_reader(path: &Path) -> Result<Box<dyn BufRead>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("open {}: {e}", path.display()))?;
    Ok(Box::new(std::io::BufReader::new(file)))
}

/// Image payloads: the reader renders them, the scanner must not build them.
#[derive(Clone, Copy, PartialEq)]
enum ImageMode {
    Collect,
    SkipDataUrls,
}

type LineExtractor<'a> = Box<dyn Fn(&Value) -> LineRows + 'a>;

fn extractor_for(engine: &str, images: ImageMode) -> LineExtractor<'static> {
    let engine = engine.to_string();
    Box::new(move |value| extract_line_messages(&engine, value, images))
}

/// Line-loop skeleton shared by the full parse and the scan summary: decode
/// one NDJSON line, extract rows, normalize, hand each to `consume`.
fn walk_lines(reader: impl BufRead, extract: &LineExtractor<'_>, mut consume: impl FnMut(LineRow)) {
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("\"type\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        for row in extract(&value) {
            let Some(row) = normalize_extracted_row(row) else {
                continue;
            };
            consume(row);
        }
    }
}

/// Shared fold over extracted rows (usage markers, tool-result pairing,
/// durations, seq numbering) — opencode feeds it from its storage-tree walk
/// instead of an NDJSON line reader.
fn fold_rows(rows: Vec<LineRow>) -> ParsedSession {
    let mut messages = Vec::<Message>::new();
    let mut seq = 0i64;
    let mut last_user_ts: Option<i64> = None;
    // tool call id -> index in `messages`. Results arrive in completion order,
    // so pairing them back up by the latest row still missing one mislabels
    // parallel calls; the id is what actually names the call.
    let mut call_rows: HashMap<String, usize> = HashMap::new();
    for row in rows {
        // Usage-only marker (codex token_count or claude compact_boundary): fold
        // onto the last assistant message instead of creating an empty row.
        if row.role == "__usage__" {
            if let Some(last) = messages.iter_mut().rev().find(|m| m.role == "assistant") {
                let mut new_usage = row.usage;
                if let (Some(prev), Some(next)) = (last.usage.as_ref(), new_usage.as_mut()) {
                    if let (Some(mcw), Some(obj)) = (prev.get("model_context_window"), next.as_object_mut()) {
                        if !obj.contains_key("model_context_window") {
                            obj.insert("model_context_window".to_string(), mcw.clone());
                        }
                    }
                }
                last.usage = new_usage;
            }
            continue;
        }
        // Tool result marker: fold onto its named call when the transcript
        // carries toolCallId, else retain the legacy latest-unresolved
        // fallback used by Claude transcripts.
        if row.role == "__tool_result__" {
            if let Some(res) = row.result {
                let index = match row.tool_call_id.as_deref() {
                    Some(id) => call_rows
                        .get(id)
                        .copied()
                        .filter(|index| messages[*index].result.is_none()),
                    None => messages
                        .iter()
                        .rposition(|m| m.role == "tool" && m.result.is_none()),
                };
                if let Some(index) = index {
                    messages[index].result = Some(res);
                }
            }
            continue;
        }
        if row.text.trim().is_empty() && row.images.is_empty() {
            continue;
        }
        let parsed_ts = row.ts.as_deref().and_then(super::parse_ts_ms_str);
        if row.role == "user" {
            last_user_ts = parsed_ts;
        }
        let duration_ms = row.duration_ms.or_else(|| {
            if row.role == "assistant" {
                if let (Some(u_ts), Some(a_ts)) = (last_user_ts, parsed_ts) {
                    if a_ts >= u_ts && a_ts - u_ts < 24 * 3600 * 1000 {
                        return Some(a_ts - u_ts);
                    }
                }
            }
            None
        });
        seq += 1;
        let call_id = row.tool_call_id;
        messages.push(Message {
            seq,
            role: row.role,
            text: row.text,
            ts: row.ts,
            uuid: row.uuid,
            path: row.path,
            args: row.args,
            result: row.result,
            todos: row.todos,
            usage: row.usage,
            model: row.model,
            effort: row.effort,
            duration_ms,
            images: row.images,
            level: row.level,
        });
        if let Some(id) = call_id {
            call_rows.insert(id, messages.len() - 1);
        }
    }
    ParsedSession { messages }
}

/// Bounded scan accumulator: keeps only what the sessions table stores.
#[derive(Default)]
struct ScanAcc {
    count: i64,
    first_ts: Option<String>,
    last_ts: Option<String>,
    title: Option<String>,
    first_user_text: Option<String>,
    last_assistant_text: Option<String>,
}

impl ScanAcc {
    fn accept(&mut self, row: LineRow) {
        if row.role == "__usage__" {
            return;
        }
        if row.text.trim().is_empty() && row.images.is_empty() {
            return;
        }
        if self.count == 0 {
            self.first_ts = row.ts.clone();
        }
        self.count += 1;
        self.last_ts = row.ts.clone();
        match row.role.as_str() {
            "user" => {
                // Mirrors strip_title_noise: first non-noise user body wins, the
                // first user row (even noise) is the fallback.
                if self.title.is_none() {
                    let body = super::strip_title_noise(&row.text);
                    if !body.is_empty() {
                        self.title = Some(super::truncate_chars(&body, 80));
                    }
                }
                if self.first_user_text.is_none() {
                    self.first_user_text = Some(row.text);
                }
            }
            "assistant" => self.last_assistant_text = Some(row.text),
            _ => {}
        }
    }

    fn finish(self) -> ScanSummary {
        let title = self
            .title
            .or_else(|| self.first_user_text.map(|t| super::truncate_chars(&t, 80)))
            .unwrap_or_default();
        ScanSummary {
            title,
            preview: self
                .last_assistant_text
                .map(|t| super::truncate_chars(&t, 120))
                .unwrap_or_default(),
            first_ts: self.first_ts.as_deref().and_then(parse_ts_ms_str),
            last_ts: self.last_ts.as_deref().and_then(parse_ts_ms_str),
            message_count: self.count,
        }
    }
}

/// Claude image content block -> data URL for direct WebView rendering.
fn claude_image_data_url(block: &Value) -> Option<String> {
    let source = block.get("source")?;
    let data = source.get("data").and_then(Value::as_str)?;
    if data.is_empty() {
        return None;
    }
    let mime = source
        .get("media_type")
        .and_then(Value::as_str)
        .unwrap_or("image/png");
    Some(format!("data:{mime};base64,{data}"))
}

/// `value["type"]` as a string slice, empty when absent.
fn type_str(value: &Value) -> &str {
    value.get("type").and_then(Value::as_str).unwrap_or("")
}

/// First string-valued timestamp among `keys` (engines disagree on the
/// field name; grok alone has used three).
fn ts_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter()
        .find_map(|k| value.get(k).and_then(Value::as_str))
        .map(str::to_string)
}

/// One extracted row from a native session line.
struct LineRow {
    role: String,
    text: String,
    ts: Option<String>,
    /// The source entry's uuid (claude transcript lines); None elsewhere.
    uuid: Option<String>,
    path: Option<String>,
    args: Option<Value>,
    tool_call_id: Option<String>,
    result: Option<Value>,
    todos: Option<crate::engine::TodosPayload>,
    usage: Option<Value>,
    model: Option<String>,
    effort: Option<String>,
    duration_ms: Option<i64>,
    images: Vec<String>,
    level: Option<String>,
}

impl LineRow {
    /// A plain row without usage/model metadata.
    fn new(role: &str, text: String, ts: Option<String>) -> Self {
        Self {
            role: role.to_string(),
            text,
            ts,
            uuid: None,
            path: None,
            args: None,
            tool_call_id: None,
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
}

type LineRows = Vec<LineRow>;

/// Drop injected context turns and unwrap `<user_query>` so every engine's
/// message list (and therefore titles) share one envelope cleaner.
fn normalize_extracted_row(mut row: LineRow) -> Option<LineRow> {
    if row.role != "user" {
        return Some(row);
    }
    let text = super::clean_user_turn(&row.text);
    if super::is_injected_user_context(&text) {
        return None;
    }
    if text.trim().is_empty() && row.images.is_empty() {
        return None;
    }
    row.text = text;
    Some(row)
}

/// Per-engine NDJSON line -> zero or more (role, text, ts, usage, model) tuples.
fn extract_line_messages(engine: &str, value: &Value, images: ImageMode) -> LineRows {
    match engine {
        "claude" => extract_claude_line(value, images),
        _ => Vec::new(),
    }
}

/// Flush buffered claude text as a row carrying the line's usage/model/effort.
fn claude_flush_text(
    out: &mut LineRows,
    text: &mut String,
    role: &str,
    ts: &Option<String>,
    usage: &Option<Value>,
    model: &Option<String>,
    effort: &Option<String>,
) {
    if !text.trim().is_empty() {
        out.push(LineRow {
            usage: usage.clone(),
            model: model.clone(),
            effort: effort.clone(),
            ..LineRow::new(role, std::mem::take(text), ts.clone())
        });
    }
}

/// One claude content block; text accumulates, thinking/tool_use flush it.
fn claude_block_rows(
    block: &Value,
    images: ImageMode,
    out: &mut LineRows,
    text: &mut String,
    collected_images: &mut Vec<String>,
    role: &str,
    ts: &Option<String>,
    usage: &Option<Value>,
    model: &Option<String>,
    effort: &Option<String>,
) {
    match block.get("type").and_then(Value::as_str) {
        Some("thinking") => {
            claude_flush_text(out, text, role, ts, usage, model, effort);
            if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                out.push(LineRow::new("thinking", t.to_string(), ts.clone()));
            }
        }
        Some("tool_use") => {
            claude_flush_text(out, text, role, ts, usage, model, effort);
            let name = block
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or("tool")
                .to_string();
            let input = block.get("input");
            out.push(LineRow {
                path: input.and_then(crate::engine::tool_path_arg),
                args: input.and_then(crate::engine::parse_tool_args_value),
                todos: input.and_then(crate::engine::parse_todo_args),
                ..LineRow::new("tool", name, ts.clone())
            });
        }
        Some("tool_result") => {
            let res = block.get("content").cloned();
            out.push(LineRow {
                result: res,
                ..LineRow::new("__tool_result__", String::new(), ts.clone())
            });
        }
        Some("image") => {
            if images == ImageMode::Collect {
                if let Some(url) = claude_image_data_url(block) {
                    collected_images.push(url);
                }
            }
        }
        _ => {
            if let Some(t) = block.get("text").and_then(Value::as_str) {
                text.push_str(t);
            }
        }
    }
}

/// Inner text of a `<local-command-stdout>…</local-command-stdout>` user
/// message, when the content is exactly that wrapper (mirrors the engine's
/// live parser).
fn local_command_stdout_text(content: &str) -> Option<String> {
    let inner = content
        .trim()
        .strip_prefix("<local-command-stdout>")?
        .strip_suffix("</local-command-stdout>")?
        .trim();
    (!inner.is_empty()).then(|| inner.to_string())
}

/// Summary of a `<task-notification>…</task-notification>` user row (the CLI
/// delivers background-task bookends as XML user messages). None when the
/// row carries no `<summary>` — there is nothing to show then.
fn task_notification_summary(content: &str) -> Option<String> {
    let inner = content.trim().strip_prefix("<task-notification>")?;
    let start = inner.find("<summary>")? + "<summary>".len();
    let rest = &inner[start..];
    let end = rest.find("</summary>")?;
    let text = rest[..end].trim();
    (!text.is_empty()).then(|| text.to_string())
}

fn extract_claude_line(value: &Value, images: ImageMode) -> LineRows {
    let line_type = type_str(value);
    if line_type == "system" {
        let subtype = value.get("subtype").and_then(Value::as_str);
        if subtype == Some("compact_boundary") {
            let post_tokens = value
                .get("compactMetadata")
                .and_then(|m| m.get("postTokens").or_else(|| m.get("post_tokens")))
                .and_then(Value::as_i64);
            if let Some(tokens) = post_tokens {
                let ts = ts_string(value, &["timestamp"]);
                let usage = serde_json::json!({
                    "input_tokens": tokens,
                    "total_tokens": tokens,
                });
                return vec![LineRow {
                    usage: Some(usage),
                    ..LineRow::new("__usage__", String::new(), ts)
                }];
            }
        }
        // User-facing notice (second-brain advice and call failures,
        // personal-memory notes, model fallback): the terminal prints
        // warning/error notices and the timeline mirrors them. Info-level
        // notices stay hidden, matching the REPL default.
        if subtype == Some("informational") {
            let level = value.get("level").and_then(Value::as_str).unwrap_or("info");
            let content = value.get("content").and_then(Value::as_str).unwrap_or("");
            if level != "info" && !content.trim().is_empty() {
                let ts = ts_string(value, &["timestamp"]);
                return vec![LineRow {
                    level: Some(level.to_string()),
                    ..LineRow::new("notice", content.to_string(), ts)
                }];
            }
        }
        return Vec::new();
    }
    if line_type != "user" && line_type != "assistant" {
        return Vec::new();
    }
    // Slash-command expansions and other CLI-internal turns are logged with
    // `isMeta`; Claude Code itself never renders them in the transcript.
    if value.get("isMeta").and_then(Value::as_bool) == Some(true) {
        return Vec::new();
    }
    let Some(message) = value.get("message") else {
        return Vec::new();
    };
    let role = message
        .get("role")
        .and_then(Value::as_str)
        .unwrap_or(line_type)
        .to_string();
    let ts = ts_string(value, &["timestamp"]);
    // The entry's uuid: the branch action forks from a message by it.
    let uuid = value
        .get("uuid")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_string);
    let usage = message.get("usage").cloned();
    let model = message
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_string);
    let effort = value
        .get("effort")
        .or_else(|| message.get("effort"))
        .and_then(Value::as_str)
        .map(str::to_string);
    let content = message.get("content");
    // Synthetic assistant snapshots carry local command output (/cost,
    // /context): mirror the live path — keep their text as an assistant row.
    if line_type == "assistant"
        && model.as_deref().map(|m| m.starts_with('<')).unwrap_or(false)
    {
        let text = content_text(content);
        return if text.trim().is_empty() {
            Vec::new()
        } else {
            vec![LineRow::new("assistant", text, ts)]
        };
    }
    // Local command confirmations (`<local-command-stdout>…</local-command-stdout>`
    // user rows): the live renderer shows them as assistant rows; match that.
    if line_type == "user" {
        if let Some(Value::String(raw)) = content {
            if let Some(inner) = local_command_stdout_text(raw) {
                return vec![LineRow::new("assistant", inner, ts)];
            }
        }
    }
    // Background-task bookends arrive as `<task-notification>` XML user rows
    // (Claude Code: they look like user messages but are not). Surface the
    // summary as a notice row instead of leaking raw XML into the view.
    if line_type == "user" {
        if let Some(Value::String(raw)) = content {
            if raw.trim_start().starts_with("<task-notification>") {
                return match task_notification_summary(raw) {
                    Some(summary) => vec![LineRow {
                        level: Some("info".to_string()),
                        ..LineRow::new("notice", summary, ts)
                    }],
                    None => Vec::new(),
                };
            }
        }
    }
    let mut out = Vec::new();
    match content {
        Some(Value::Array(blocks)) => {
            // Walk content blocks in order so thinking and tool calls land
            // where they actually happened relative to the text.
            let mut text = String::new();
            let mut collected: Vec<String> = Vec::new();
            for block in blocks {
                claude_block_rows(
                    block,
                    images,
                    &mut out,
                    &mut text,
                    &mut collected,
                    &role,
                    &ts,
                    &usage,
                    &model,
                    &effort,
                );
            }
            if !text.trim().is_empty() {
                out.push(LineRow {
                    usage,
                    model,
                    effort,
                    images: collected,
                    uuid: uuid.clone(),
                    ..LineRow::new(&role, text, ts)
                });
            } else if !collected.is_empty() {
                out.push(LineRow {
                    images: collected,
                    uuid: uuid.clone(),
                    ..LineRow::new(&role, String::new(), ts)
                });
            }
        }
        _ => {
            let text = content_text(content);
            if !text.trim().is_empty() {
                out.push(LineRow {
                    usage,
                    model,
                    effort,
                    uuid,
                    ..LineRow::new(&role, text, ts)
                });
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn claude_line_extracts_thinking_and_tool_in_order() {
        let line: Value = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "thinking", "thinking": "ponder", "signature": "sig"},
                    {"type": "text", "text": "reply"},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "ls"}}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        let roles: Vec<&str> = rows.iter().map(|r| r.role.as_str()).collect();
        assert_eq!(roles, ["thinking", "assistant", "tool"]);
        assert_eq!(rows[0].text, "ponder");
        assert_eq!(rows[1].text, "reply");
        assert_eq!(rows[2].text, "Bash");
        assert_eq!(rows[2].args, Some(serde_json::json!({"command": "ls"})));
    }

    #[test]
    fn claude_tool_use_row_carries_todowrite_snapshot() {
        let line: Value = serde_json::json!({
            "type": "assistant",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "tool_use", "name": "TodoWrite", "input": {"todos": [
                        {"content": "scan files", "status": "completed"},
                        {"content": "write code", "status": "in_progress"},
                        {"content": "run tests", "status": "pending"},
                        {"content": "deploy", "status": "blocked"}
                    ]}}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "tool");
        let todos = rows[0].todos.as_ref().expect("todos payload");
        assert!(todos.replace);
        let statuses: Vec<&str> = todos.items.iter().map(|i| i.status.as_str()).collect();
        assert_eq!(statuses, ["complete", "active", "pending", "blocked"]);
        assert_eq!(todos.items[1].content, "write code");
    }

    #[test]
    fn claude_line_drops_is_meta_command_expansion() {
        let expansion: Value = serde_json::json!({
            "type": "user",
            "isMeta": true,
            "timestamp": "2026-09-08T10:00:00.000Z",
            "message": {
                "role": "user",
                "content": [{"type": "text", "text": "# 代码审查\n对未提交更改进行全面的安全和质量审查"}]
            }
        });
        assert!(extract_claude_line(&expansion, ImageMode::Collect).is_empty());
    }

    #[test]
    fn claude_user_image_block_becomes_data_url() {
        let line: Value = serde_json::json!({
            "type": "user",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/png", "data": "aGk="}},
                    {"type": "text", "text": "这是什么?"}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].text, "这是什么?");
        assert_eq!(rows[0].images, ["data:image/png;base64,aGk="]);

        // Image-only message still yields a row.
        let image_only: Value = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": [
                    {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": "eGk="}}
                ]
            }
        });
        let rows = extract_claude_line(&image_only, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].images, ["data:image/jpeg;base64,eGk="]);
    }

    #[test]
    fn claude_synthetic_assistant_keeps_command_output() {
        let line: Value = serde_json::json!({
            "type": "assistant",
            "message": {
                "role": "assistant",
                "model": "<synthetic>",
                "content": [{ "type": "text", "text": "Total cost: $0.0000" }]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "assistant");
        assert_eq!(rows[0].text, "Total cost: $0.0000");
    }

    #[test]
    fn claude_local_command_stdout_row_becomes_an_assistant_row() {
        let line: Value = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "<local-command-stdout>Compacted Context: ~8 → ~52 tokens</local-command-stdout>"
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "assistant");
        assert_eq!(rows[0].text, "Compacted Context: ~8 → ~52 tokens");
    }

    #[test]
    fn claude_task_notification_row_becomes_a_notice() {
        let line: Value = serde_json::json!({
            "type": "user",
            "isSidechain": false,
            "message": {
                "role": "user",
                "content": "<task-notification>\n<task-id>t1</task-id>\n<status>completed</status>\n<summary>修完了 3 个文件</summary>\n</task-notification>"
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "notice");
        assert_eq!(rows[0].level.as_deref(), Some("info"));
        assert_eq!(rows[0].text, "修完了 3 个文件");

        // Without a summary there is nothing to show — the row is dropped.
        let bare: Value = serde_json::json!({
            "type": "user",
            "message": {
                "role": "user",
                "content": "<task-notification>\n<task-id>t2</task-id>\n<status>completed</status>\n</task-notification>"
            }
        });
        assert!(extract_claude_line(&bare, ImageMode::Collect).is_empty());
    }

    #[test]
    fn claude_informational_line_becomes_a_levelled_notice() {
        let line: Value = serde_json::json!({
            "type": "system",
            "subtype": "informational",
            "content": "[第二大脑] 指导意见：核对测试覆盖",
            "level": "warning",
            "timestamp": "2026-09-20T14:32:00.571Z"
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "notice");
        assert_eq!(rows[0].text, "[第二大脑] 指导意见：核对测试覆盖");
        assert_eq!(rows[0].level.as_deref(), Some("warning"));

        // Info-level notices match the REPL default and stay out of history.
        let info: Value = serde_json::json!({
            "type": "system",
            "subtype": "informational",
            "content": "Session completed successfully",
            "level": "info"
        });
        assert!(extract_claude_line(&info, ImageMode::Collect).is_empty());
    }

    #[test]
    fn claude_compact_boundary_extracts_post_tokens_into_usage() {
        let line: Value = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "timestamp": "2026-09-10T05:55:55.956Z",
            "compactMetadata": {
                "preTokens": 30190,
                "postTokens": 8038,
                "durationMs": 4207
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].role, "__usage__");
        let usage = rows[0].usage.as_ref().expect("usage object");
        assert_eq!(usage.get("input_tokens").and_then(Value::as_i64), Some(8038));
        assert_eq!(usage.get("total_tokens").and_then(Value::as_i64), Some(8038));
    }

    #[test]
    fn parse_session_file_concatenates_segment_chain_root_to_active() {
        let dir = std::env::temp_dir().join(format!(
            "hzkcode-extract-{}",
            uuid::Uuid::new_v4()
        ));
        let session = dir.join("proj");
        std::fs::create_dir_all(session.join("sess-1/segments")).unwrap();
        let write = |rel: &str, content: &str| {
            std::fs::write(session.join(rel), content).unwrap();
        };
        write(
            "sess-1/segments/seg-1.jsonl",
            concat!(
                r#"{"type":"user","uuid":"u1","timestamp":"2026-10-05T01:00:00.000Z","message":{"role":"user","content":"第一条问题"}}"#,
                "\n",
                r#"{"type":"assistant","uuid":"a1","timestamp":"2026-10-05T01:00:01.000Z","message":{"role":"assistant","content":[{"type":"text","text":"第一条回答"}]}}"#,
                "\n"
            ),
        );
        write(
            "sess-1.jsonl",
            concat!(
                r#"{"type":"user","uuid":"u2","timestamp":"2026-10-05T01:01:00.000Z","message":{"role":"user","content":"第二条问题"}}"#,
                "\n"
            ),
        );
        write(
            "sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-2","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"}]}"#,
        );
        let parsed = parse_session_file("claude", &session.join("sess-1.jsonl")).unwrap();
        let texts: Vec<String> = parsed.messages.iter().map(|m| m.text.clone()).collect();
        let seqs: Vec<i64> = parsed.messages.iter().map(|m| m.seq).collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(texts, ["第一条问题", "第一条回答", "第二条问题"]);
        // seq numbering is 1-based and stays continuous across files.
        assert_eq!(seqs, [1, 2, 3]);
    }
}
