//! Smoke: spawn each engine CLI with a tiny prompt, stream NDJSON through the
//! real parse_line, print the event sequence. Verifies spawn args + parsing
//! against the installed CLIs.
//!
//!   cargo run --example engine_smoke -- [claude]

use hzkcode_lib::engine::{engine_by_id, EngineEvent, SendRequest};
use std::path::PathBuf;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

#[tokio::main]
async fn main() {
    let engines: Vec<String> = std::env::args().skip(1).collect();
    let engines = if engines.is_empty() {
        vec!["claude".into()]
    } else {
        engines
    };
    let workspace = std::env::temp_dir().join("hzkcode-engine-smoke");
    std::fs::create_dir_all(&workspace).unwrap();

    for engine_id in engines {
        println!("=== {engine_id} ===");
        if let Err(e) = run_one(&engine_id, &workspace).await {
            println!("FAILED: {e}");
        }
    }
}

async fn run_one(engine_id: &str, workspace: &PathBuf) -> Result<(), String> {
    let engine = engine_by_id(engine_id).ok_or("unknown engine")?;
    let req = SendRequest {
        session_id: None,
        workspace: workspace.clone(),
        prompt: "Reply with exactly: ok".to_string(),
        images: Vec::new(),
        model: None,
        effort: None,
        permission: None,
        additional_dirs: Vec::new(),
        provider_id: None,
        agent_name: None,
        agents_json: None,
        proxy_enabled: None,
        second_brain_enabled: None,
    };
    let bin = which::which(engine_id)
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_else(|_| engine_id.to_string());
    let built = engine.build_command(&req, &bin)?;
    let mut command = built.command;
    command
        .stdin(if built.stdin_payload.is_some() {
            std::process::Stdio::piped()
        } else {
            std::process::Stdio::null()
        })
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .current_dir(workspace);
    let mut child = command.spawn().map_err(|e| format!("spawn: {e}"))?;
    if let Some(payload) = built.stdin_payload {
        let mut stdin = child.stdin.take().unwrap();
        tokio::spawn(async move {
            let _ = stdin.write_all(payload.as_bytes()).await;
            let _ = stdin.write_all(b"\n").await;
        });
    }
    let stdout = child.stdout.take().unwrap();
    let stderr = child.stderr.take().unwrap();
    let stderr_task = tokio::spawn(async move {
        let mut buf = String::new();
        let mut reader = BufReader::new(stderr);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line).await {
                Ok(0) | Err(_) => break,
                Ok(_) => buf.push_str(&line),
            }
        }
        buf
    });

    let mut reader = BufReader::new(stdout);
    let mut line = String::new();
    let mut deltas = String::new();
    let mut session_id: Option<String> = None;
    let mut done = false;
    let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(90);
    while tokio::time::Instant::now() < deadline && !done {
        line.clear();
        let read = tokio::time::timeout(
            deadline - tokio::time::Instant::now(),
            reader.read_line(&mut line),
        )
        .await;
        match read {
            Ok(Ok(0)) => break,
            Ok(Ok(_)) => {}
            Ok(Err(e)) => return Err(format!("read: {e}")),
            Err(_) => break,
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let mut events = Vec::new();
        engine.parse_line(trimmed, &mut events);
        for event in events {
            match event {
                EngineEvent::Delta(text) => deltas.push_str(&text),
                EngineEvent::Thinking(_) => {}
                EngineEvent::Message { role, text, .. } => {
                    println!("  message[{role}]: {:.60}", text.replace('\n', " "))
                }
                EngineEvent::SessionId(id) => {
                    println!("  session: {id}");
                    session_id = Some(id);
                }
                EngineEvent::MessageUuid(uuid) => println!("  message uuid: {uuid}"),
                EngineEvent::Model(m) => println!("  model: {m}"),
                EngineEvent::Usage(u) => println!("  usage: {u}"),
                EngineEvent::Error(e) => println!("  ERROR: {e}"),
                EngineEvent::Warn(e) => println!("  warn: {e}"),
                EngineEvent::Notice { level, text } => {
                    println!("  notice[{level}]: {text}");
                }
                EngineEvent::Retry { attempt, max, message } => {
                    println!("  retry {attempt}/{max}: {message}");
                }
                EngineEvent::AttemptEnd { error } => {
                    if let Some(error) = error {
                        println!("  attempt failed (CLI may recover): {error}");
                    }
                }
                EngineEvent::PermissionDenied { tool, path, .. } => {
                    println!("  permission denied: tool={tool:?} path={path:?}")
                }
                EngineEvent::Question { request_id, .. } => {
                    println!("  question parked: {request_id}")
                }
                EngineEvent::QuestionSettled { request_id } => {
                    println!("  question settled: {request_id}")
                }
                EngineEvent::PermissionAsk { tool_name, .. } => {
                    println!("  permission ask parked: {tool_name}")
                }
                EngineEvent::Commands(names) => {
                    println!("  commands: {names:?}")
                }
                EngineEvent::CommandOutput(text) => {
                    println!("  command output: {:.60}", text.replace('\n', " "))
                }
                EngineEvent::TaskNotification { status, summary } => {
                    println!("  task notification [{status}]: {summary}")
                }
                EngineEvent::Done { usage, .. } => {
                    println!("  done (usage: {})", usage.is_some());
                    done = true;
                }
            }
        }
    }
    if !done {
        let _ = child.start_kill();
    }
    let status = child.wait().await.map_err(|e| e.to_string())?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    println!(
        "  exit={status} stream_text={:?} session={:?} stderr_tail={}",
        deltas.chars().take(80).collect::<String>(),
        session_id,
        stderr_tail.trim().chars().take(600).collect::<String>()
    );
    Ok(())
}
