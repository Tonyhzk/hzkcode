//! 消息删除：把一条转录条目从会话的活跃段文件里移除，保留其余行的顺序
//! 与原始字节，并把它的直接子节点重接（`parentUuid` 指向被删条目的父）。
//!
//! 语义（对应 GUI 消息行的「删除」按钮）：
//! - 只作用于活跃段文件（`<会话ID>.jsonl`）。压缩前的归档段与压缩保留
//!   切片不提供删除：任何跨段/保留结构的引用都拒绝，而不是猜测。
//! - 被删条目连同它自己的工具结果子条目一起移除——工具结果依附于产它
//!   的调用条目，留下会成为引用不存在 tool_use 的孤儿块，下一次模型请求
//!   会被 API 拒绝；这是该条目不可分割的结构部分，不是连带删除。
//! - 其余指向被删集合的子节点重接到被删条目的 `parentUuid`，链保持连续，
//!   更早与更晚的历史都不受影响。写入前还会在内存里校验「原链上的其他
//!   条目在新内容里全部仍然可达」，任何拓扑意外都在这里被拦下。
//!
//! 写回：同目录临时文件 + rename 原子替换；写入前后以 (大小, mtime,
//! inode) 快照复核；以与 CLI 编辑共用的内核文件锁（`<文件>.edit.lock`
//! 的 O_EXLOCK）与其他改写者互斥。持锁前先拒绝仍然存活的会话：本进程
//! 注册表由命令层核对，跨进程（终端 CLI）经 CLI 的 PID 注册表核对。

use super::extract::{
    preserved_slice_uuids, segment_chain, segment_kept_uuids, segment_known_uuids,
    segment_references_into,
};
use super::reader::{session_file_path, session_files_by_id};
use crate::engine::is_uuid_shaped;
use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;

/// 删除一条消息（活跃段文件的就地改写）。同步体，由命令层
/// spawn_blocking 调用。
pub(crate) fn delete_message_blocking(
    db: &crate::db::Db,
    engine: &str,
    session_id: &str,
    message_id: &str,
) -> Result<(), String> {
    if engine != "claude" {
        return Err(format!("delete_message: unknown engine {engine}"));
    }
    if !is_uuid_shaped(session_id) || !is_uuid_shaped(message_id) {
        return Err("delete_message: invalid session or message id".into());
    }
    // 活跃段：db 记录优先，未入库的会话按 id 全目录兜底（同删除会话的定位）。
    let active = session_file_path(db, engine, session_id)
        .ok()
        .filter(|path| path.is_file())
        .or_else(|| session_files_by_id(engine, session_id).into_iter().next())
        .ok_or_else(|| "没有找到可删除的会话文件".to_string())?;
    // 分段/旋转进行中的布局无法确认：拒绝改写（清单损坏同样拒绝）。
    if super::segments::rotation_pending(&active)? {
        return Err("会话正在整理历史文件，稍后重试".into());
    }
    delete_with_guards(&active, session_id, message_id)
}

/// 平台分派：macOS 走完整的存活检查 + 改写；其它平台缺少可靠的内核
/// 文件锁（O_EXLOCK），不降级到协作式锁，直接拒绝。
#[cfg(target_os = "macos")]
fn delete_with_guards(active: &Path, session_id: &str, message_id: &str) -> Result<(), String> {
    // 同一会话的进程（另一个 GUI 轮次或终端 CLI）可能正在追加写入：
    // 拒绝。注册表确认不了时同样拒绝——宁可拦下也不能冒并发改写的险；
    // 能确认没有会话时才放行。
    if session_is_live(session_id)? {
        return Err("该会话仍在运行，回合结束后再删除这条消息".into());
    }
    delete_in_active_file(active, message_id)
}

#[cfg(not(target_os = "macos"))]
fn delete_with_guards(
    _active: &Path,
    _session_id: &str,
    _message_id: &str,
) -> Result<(), String> {
    Err("当前平台暂不支持删除消息".into())
}

/// The GUI-side half of the liveness guard, covering sessions this process
/// does not own: another window of this app and the user's terminal CLI both
/// register a PID file (`<pid>.json`, carrying the session id) under the
/// CLI's `sessions/` directory while they run. A missing registry directory
/// means no session ever registered (nothing is running); a registry that
/// cannot be read, and a live PID whose file cannot be parsed, are failures
/// to confirm — refuse rather than risk writing over a running session.
#[cfg(target_os = "macos")]
fn session_is_live(session_id: &str) -> Result<bool, String> {
    let dir = crate::engine::engine_home(Some("HZKCODE_CONFIG_DIR"), ".hzkcode").join("sessions");
    let entries = match std::fs::read_dir(&dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => {
            return Err(format!("无法确认会话的运行状态（{error}），请稍后重试"));
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            return Err("无法确认会话的运行状态，请稍后重试".into());
        };
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Some(pid) = name
            .strip_suffix(".json")
            .and_then(|raw| raw.parse::<i32>().ok())
        else {
            continue;
        };
        if pid <= 1 || unsafe { libc::kill(pid, 0) } != 0 {
            continue;
        }
        let Ok(raw) = std::fs::read_to_string(entry.path()) else {
            return Err("无法确认会话的运行状态，请稍后重试".into());
        };
        let Ok(value) = serde_json::from_str::<Value>(&raw) else {
            return Err("无法确认会话的运行状态，请稍后重试".into());
        };
        if value.get("sessionId").and_then(Value::as_str) == Some(session_id) {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(target_os = "macos")]
fn delete_in_active_file(active: &Path, message_id: &str) -> Result<(), String> {
    // 快照 1（读取之前）→ 内容 → 复核：内容必须对应这份快照。
    let before = FileSnapshot::of(active)?;
    let content = std::fs::read_to_string(active).map_err(|e| format!("读取会话文件失败：{e}"))?;
    if FileSnapshot::of(active)? != before {
        return Err("会话文件已被其他程序改动，请刷新后重试".into());
    }

    // 活跃段的链索引（CLI resume 的口径：仅沿 parentUuid；并行工具恢复与
    // 保留切片重接与读取端同源）。其它链文件（归档段）提供「已知 uuid」
    // 集合与跨段引用检查。
    let segment = segment_chain(std::io::BufReader::new(content.as_bytes()));
    let mut anywhere = segment_known_uuids(&segment);
    let mut others: Vec<super::extract::SegmentChain> = Vec::new();
    for file in super::segments::session_files_for_read("claude", active) {
        if file == active {
            continue;
        }
        let Ok(handle) = std::fs::File::open(&file) else {
            continue;
        };
        let chain = segment_chain(std::io::BufReader::new(handle));
        anywhere.extend(segment_known_uuids(&chain));
        others.push(chain);
    }

    // CLI resume 视角的链上集合；布局无法确认（悬空引用、环）时拒绝。
    let Some(kept) = segment_kept_uuids(&segment, &anywhere, false, true) else {
        return Err("无法确认这条会话的历史结构，暂不支持删除".into());
    };
    // 压缩保留切片靠 relink 的 tail → head 走链闭合承载：切片内的条目
    // 不能移除，无法确认切片时同样拒绝。
    match preserved_slice_uuids(&segment) {
        None => return Err("无法确认这条会话的历史结构，暂不支持删除".into()),
        Some(slice) if slice.contains(message_id) => {
            return Err("这条消息属于压缩保留的历史片段，暂不支持删除".into());
        }
        Some(_) => {}
    }
    // 目标行：活跃段内唯一，且是用户消息或助手回复（工具结果记录没有
    // 界面入口，防御性拒绝）。压缩前归档段里的消息不在活跃段：明确报
    // 不支持，而不是含糊的「找不到」。
    let in_active = content.lines().any(|raw| {
        serde_json::from_str::<Value>(raw.trim())
            .ok()
            .and_then(|value| {
                value
                    .get("uuid")
                    .and_then(Value::as_str)
                    .map(|uuid| uuid == message_id)
            })
            .unwrap_or(false)
    });
    if !in_active && anywhere.contains(message_id) {
        return Err("这条消息在压缩前的历史里，暂不支持删除".into());
    }
    let target_parent = locate_target(&content, message_id)?;
    if !kept.contains(message_id) {
        return Err("这条消息不在当前对话的链上，无法删除".into());
    }

    // 移除集合：目标本身 + 它自己的工具结果子条目（依附于产它的调用条目）。
    let mut removed: HashSet<String> = HashSet::new();
    removed.insert(message_id.to_string());
    for raw in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(raw.trim()) else {
            continue;
        };
        let Some(uuid) = value.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        let Some(parent) = value.get("parentUuid").and_then(Value::as_str) else {
            continue;
        };
        if parent == message_id && uuid != message_id && is_tool_result_entry(&value) {
            removed.insert(uuid.to_string());
        }
    }
    // 其它段引用被删集合（parent / logicalParentUuid）：本次改写够不到
    // 跨段结构，拒绝而不是留下悬空引用。
    if others.iter().any(|chain| segment_references_into(chain, &removed)) {
        return Err("这条消息与压缩前的历史关联，暂不支持删除".into());
    }
    // 活跃段内其它行的 logicalParentUuid 指向被删集合（保留切片的边界
    // 回指等）：同样拒绝。
    for raw in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(raw.trim()) else {
            continue;
        };
        let Some(uuid) = value.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        let Some(logical) = value.get("logicalParentUuid").and_then(Value::as_str) else {
            continue;
        };
        if !removed.contains(uuid) && removed.contains(logical) {
            return Err("这条消息被压缩边界引用，暂不支持删除".into());
        }
    }

    // 生成新内容：移除集合的行整体去掉，其余行里 parentUuid 指向移除
    // 集合的重接到目标的 parent（null 或 uuid 按原值保留）。
    let mut rewritten = String::with_capacity(content.len());
    for raw in content.split_inclusive('\n') {
        let (body, newline) = match raw.strip_suffix('\n') {
            Some(rest) => (rest, true),
            None => (raw, false),
        };
        let trimmed = body.trim();
        if trimmed.is_empty() || !trimmed.starts_with('{') {
            rewritten.push_str(raw);
            continue;
        }
        let Ok(mut value) = serde_json::from_str::<Value>(trimmed) else {
            rewritten.push_str(raw);
            continue;
        };
        let uuid = value.get("uuid").and_then(Value::as_str).map(str::to_string);
        if uuid.as_deref().is_some_and(|u| removed.contains(u)) {
            continue;
        }
        let reconnect = value
            .get("parentUuid")
            .and_then(Value::as_str)
            .is_some_and(|parent| removed.contains(parent));
        if !reconnect {
            rewritten.push_str(raw);
            continue;
        }
        let Some(object) = value.as_object_mut() else {
            rewritten.push_str(raw);
            continue;
        };
        match &target_parent {
            Some(parent) => {
                object.insert("parentUuid".into(), Value::String(parent.clone()));
            }
            None => {
                object.insert("parentUuid".into(), Value::Null);
            }
        }
        rewritten.push_str(&serde_json::to_string(&value).map_err(|e| e.to_string())?);
        if newline {
            rewritten.push('\n');
        }
    }

    // 写入前的最后一道门：新内容里「原链上（两个视角）除被删者外的每个
    // 条目」都必须仍然可达。并行块、保留结构或任何没料到的拓扑都在这里
    // 被拦下，而不是写进文件。
    let new_segment = segment_chain(std::io::BufReader::new(rewritten.as_bytes()));
    let mut anywhere_new: HashSet<String> = others
        .iter()
        .flat_map(|chain| segment_known_uuids(chain))
        .collect();
    anywhere_new.extend(segment_known_uuids(&new_segment));
    let unreachable = |uuids: &HashSet<String>, new_kept: &HashSet<String>| {
        uuids
            .iter()
            .any(|uuid| !removed.contains(uuid) && !new_kept.contains(uuid))
    };
    let Some(new_kept) = segment_kept_uuids(&new_segment, &anywhere_new, false, true) else {
        return Err("这条消息的删除会破坏对话结构，暂不支持删除".into());
    };
    if unreachable(&kept, &new_kept) {
        return Err("这条消息的删除会破坏对话结构，暂不支持删除".into());
    }
    let Some(old_logical) = segment_kept_uuids(&segment, &anywhere, true, true) else {
        return Err("无法确认这条会话的历史结构，暂不支持删除".into());
    };
    let Some(new_logical) = segment_kept_uuids(&new_segment, &anywhere_new, true, true) else {
        return Err("这条消息的删除会破坏对话结构，暂不支持删除".into());
    };
    if unreachable(&old_logical, &new_logical) {
        return Err("这条消息的删除会破坏对话结构，暂不支持删除".into());
    }

    // 写回：与 CLI 编辑共用内核文件锁，锁内复核快照，临时文件原子替换。
    let Some(lock) = acquire_edit_lock(active)? else {
        return Err("会话文件正被其他程序编辑，请稍后重试".into());
    };
    let result = replace_active_file(active, &rewritten, &before);
    drop(lock);
    result
}

#[cfg(target_os = "macos")]
fn replace_active_file(
    active: &Path,
    rewritten: &str,
    expected: &FileSnapshot,
) -> Result<(), String> {
    let file_name = active
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_else(|| "session".to_string());
    let tmp = active.with_file_name(format!(".{file_name}.delete-{}.tmp", uuid::Uuid::new_v4()));
    #[cfg(test)]
    crate::test_support::guard_test_write(&tmp)?;
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut handle = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&tmp)
            .map_err(|e| format!("写入会话文件失败：{e}"))?;
        if let Err(error) = handle.write_all(rewritten.as_bytes()) {
            drop(handle);
            let _ = std::fs::remove_file(&tmp);
            return Err(format!("写入会话文件失败：{error}"));
        }
    }
    // 复核紧贴 rename：写入期间文件若被其他进程改动，放弃替换。
    match FileSnapshot::of(active) {
        Ok(snapshot) if snapshot == *expected => {}
        _ => {
            let _ = std::fs::remove_file(&tmp);
            return Err("会话文件已被其他程序改动，请刷新后重试".into());
        }
    }
    if let Err(error) = std::fs::rename(&tmp, active) {
        let _ = std::fs::remove_file(&tmp);
        return Err(format!("替换会话文件失败：{error}"));
    }
    Ok(())
}

/// 与 CLI 编辑共用的内核文件锁（`<文件>.edit.lock`，O_EXLOCK）：锁随进程
/// 退出（含崩溃）自动释放，拿不到（2 秒内）按「请重试」处理——与 CLI 的
/// sessionMessageEdit.ts 同一协议。非 macOS 平台在上层直接拒绝，不降级
/// 到不可靠的协作式锁。
#[cfg(target_os = "macos")]
fn acquire_edit_lock(file: &Path) -> Result<Option<std::fs::File>, String> {
    use std::os::unix::fs::OpenOptionsExt;
    let lock_path = format!("{}.edit.lock", file.display());
    let deadline = std::time::Instant::now() + std::time::Duration::from_millis(2_000);
    loop {
        let attempt = std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .mode(0o600)
            .custom_flags(libc::O_EXLOCK | libc::O_NONBLOCK | libc::O_NOFOLLOW)
            .open(&lock_path);
        match attempt {
            Ok(handle) => {
                let is_file = handle
                    .metadata()
                    .map(|meta| meta.is_file())
                    .unwrap_or(false);
                return Ok(is_file.then_some(handle));
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if std::time::Instant::now() >= deadline {
                    return Ok(None);
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
            Err(_) => return Ok(None),
        }
    }
}

/// (大小, mtime, inode) 三元快照：任何一项变化都说明文件被其他进程改动。
#[cfg(target_os = "macos")]
#[derive(PartialEq)]
struct FileSnapshot {
    size: u64,
    mtime_sec: i64,
    mtime_nsec: i64,
    inode: u64,
}

#[cfg(target_os = "macos")]
impl FileSnapshot {
    fn of(path: &Path) -> Result<Self, String> {
        use std::os::unix::fs::MetadataExt;
        let meta =
            std::fs::metadata(path).map_err(|e| format!("读取会话文件失败：{e}"))?;
        Ok(Self {
            size: meta.len(),
            mtime_sec: meta.mtime(),
            mtime_nsec: meta.mtime_nsec(),
            inode: meta.ino(),
        })
    }
}

/// 定位目标行并校验其形态；返回它的 `parentUuid`（字符串 uuid 或 null）。
#[cfg(target_os = "macos")]
fn locate_target(content: &str, message_id: &str) -> Result<Option<String>, String> {
    let mut found: Option<Option<String>> = None;
    for raw in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(raw.trim()) else {
            continue;
        };
        let Some(uuid) = value.get("uuid").and_then(Value::as_str) else {
            continue;
        };
        if uuid != message_id {
            continue;
        }
        if found.is_some() {
            return Err("会话文件里出现重复的消息，暂不支持删除".into());
        }
        if !matches!(
            value.get("type").and_then(Value::as_str),
            Some("user") | Some("assistant")
        ) {
            return Err("这条消息不支持删除".into());
        }
        if is_tool_result_entry(&value) {
            return Err("工具结果记录不支持删除".into());
        }
        found = Some(
            value
                .get("parentUuid")
                .and_then(Value::as_str)
                .map(str::to_string),
        );
    }
    found.ok_or_else(|| "在会话里找不到这条消息".to_string())
}

#[cfg(target_os = "macos")]
fn is_tool_result_entry(value: &Value) -> bool {
    value.get("type").and_then(Value::as_str) == Some("user")
        && value
            .pointer("/message/content")
            .and_then(Value::as_array)
            .is_some_and(|blocks| {
                blocks
                    .iter()
                    .any(|block| block.get("type").and_then(Value::as_str) == Some("tool_result"))
            })
}

/// 删除一条消息（「删除」按钮）：把该条目从活跃段移除并把直接子链重接。
#[tauri::command]
pub async fn delete_message(
    state: tauri::State<'_, crate::AppState>,
    engine: String,
    session_id: String,
    message_id: String,
) -> Result<(), String> {
    if engine != "claude" {
        return Err(format!("delete_message: unknown engine {engine}"));
    }
    let session_id = session_id.trim().to_string();
    let message_id = message_id.trim().to_string();
    // 本进程注册表里的运行中会话直接拒绝（终端或其他窗口里的同一会话由
    // 改写侧的 PID 注册表检查兜底）。
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
    let db = std::sync::Arc::clone(&state.db);
    let blocking_db = std::sync::Arc::clone(&state.db);
    tauri::async_runtime::spawn_blocking(move || {
        delete_message_blocking(&blocking_db, &engine, &session_id, &message_id)
    })
    .await
    .map_err(|e| e.to_string())??;
    // 转录已改写：重扫让列表、摘要与读取缓存跟上（扫描发现变化时自行广播）。
    crate::history::scanner::spawn_scan(db, std::sync::Arc::clone(&state.sink));
    Ok(())
}

#[cfg(all(test, target_os = "macos"))]
mod tests {
    use super::*;
    use serde_json::json;
    use std::path::PathBuf;

    const SESSION: &str = "sess-fixed";
    /// 形状合法的 uuid：delete_message_blocking 会做 36 位 uuid 形状校验。
    const U1: &str = "11111111-1111-4111-8111-111111111111";
    const A1: &str = "22222222-2222-4222-8222-222222222222";
    const U2: &str = "33333333-3333-4333-8333-333333333333";
    const A2: &str = "44444444-4444-4444-8444-444444444444";
    const U3: &str = "55555555-5555-4555-8555-555555555555";
    const B1: &str = "66666666-6666-4666-8666-666666666666";
    const TR1: &str = "77777777-7777-4777-8777-777777777777";
    const TR2: &str = "88888888-8888-4888-8888-888888888888";

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir =
                std::env::temp_dir().join(format!("hzkcode-delete-{}", uuid::Uuid::new_v4()));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    /// Steers HZKCODE_CONFIG_DIR (what `engine_home` reads) at the scratch;
    /// shares the process-wide env lock with the other modules' tests.
    struct ConfigDirGuard {
        _lock: parking_lot::MutexGuard<'static, ()>,
        prev: Option<std::ffi::OsString>,
    }
    impl ConfigDirGuard {
        fn set(dir: &Path) -> Self {
            let lock = crate::test_support::HOME_ENV_LOCK.lock();
            let prev = std::env::var_os("HZKCODE_CONFIG_DIR");
            std::env::set_var("HZKCODE_CONFIG_DIR", dir);
            Self { _lock: lock, prev }
        }
    }
    impl Drop for ConfigDirGuard {
        fn drop(&mut self) {
            match &self.prev {
                Some(value) => std::env::set_var("HZKCODE_CONFIG_DIR", value),
                None => std::env::remove_var("HZKCODE_CONFIG_DIR"),
            }
        }
    }

    struct Fixture {
        _scratch: Scratch,
        _guard: ConfigDirGuard,
        db: crate::db::Db,
        project: PathBuf,
        file: PathBuf,
        session_id: String,
    }

    fn fixture(lines: &[serde_json::Value]) -> Fixture {
        let scratch = Scratch::new();
        let db = crate::db::Db::open_at(&scratch.0.join("app.db")).unwrap();
        let config_dir = scratch.0.join("cli");
        let project = config_dir.join("projects").join("-ws");
        std::fs::create_dir_all(&project).unwrap();
        let session_id = uuid::Uuid::new_v4().to_string();
        let file = project.join(format!("{session_id}.jsonl"));
        let content: String = lines.iter().map(|line| format!("{line}\n")).collect();
        std::fs::write(&file, content).unwrap();
        db.0.lock()
            .execute(
                "INSERT INTO sessions(engine,session_id,workspace_path,file_path,file_size,file_mtime_ms,title) VALUES('claude',?1,'/ws',?2,1,1,'t')",
                rusqlite::params![&session_id, file.to_string_lossy().to_string()],
            )
            .unwrap();
        let guard = ConfigDirGuard::set(&config_dir);
        Fixture {
            _scratch: scratch,
            _guard: guard,
            db,
            project,
            file,
            session_id,
        }
    }

    fn user(parent: Option<&str>, uuid: &str, text: &str) -> serde_json::Value {
        json!({
            "parentUuid": parent,
            "type": "user",
            "uuid": uuid,
            "sessionId": SESSION,
            "message": {"role": "user", "content": text},
            "timestamp": "2026-10-10T00:00:00.000Z",
        })
    }

    fn assistant(parent: Option<&str>, uuid: &str, blocks: serde_json::Value) -> serde_json::Value {
        json!({
            "parentUuid": parent,
            "type": "assistant",
            "uuid": uuid,
            "sessionId": SESSION,
            "message": {"role": "assistant", "model": "m", "content": blocks},
            "timestamp": "2026-10-10T00:00:01.000Z",
        })
    }

    fn tool_result(parent: &str, uuid: &str) -> serde_json::Value {
        json!({
            "parentUuid": parent,
            "type": "user",
            "uuid": uuid,
            "sessionId": SESSION,
            "message": {"role": "user", "content": [
                {"type": "tool_result", "tool_use_id": "t1", "content": "ok"}
            ]},
            "timestamp": "2026-10-10T00:00:02.000Z",
        })
    }

    fn parse_lines(path: &Path) -> Vec<serde_json::Value> {
        std::fs::read_to_string(path)
            .unwrap()
            .lines()
            .filter(|line| !line.trim().is_empty())
            .map(|line| serde_json::from_str(line).unwrap())
            .collect()
    }

    fn find<'a>(values: &'a [serde_json::Value], uuid: &str) -> Option<&'a serde_json::Value> {
        values
            .iter()
            .find(|value| value.get("uuid").and_then(Value::as_str) == Some(uuid))
    }

    #[test]
    fn deletes_a_middle_message_and_relinks_children() {
        let f = fixture(&[
            user(None, U1, "一问"),
            assistant(Some(U1), A1, json!([{"type": "text", "text": "答一"}])),
            user(Some(A1), U2, "二问"),
            assistant(Some(U2), A2, json!([{"type": "text", "text": "答二"}])),
        ]);
        delete_message_blocking(&f.db, "claude", &f.session_id, A1).unwrap();
        let values = parse_lines(&f.file);
        assert!(find(&values, A1).is_none());
        assert_eq!(
            find(&values, U2)
                .unwrap()
                .get("parentUuid")
                .and_then(Value::as_str),
            Some(U1)
        );
        assert!(find(&values, U1).is_some());
        assert!(find(&values, A2).is_some());
        assert_eq!(values.len(), 3);
    }

    #[test]
    fn removes_the_targets_tool_result_children_and_relinks() {
        let f = fixture(&[
            user(None, U1, "一问"),
            assistant(
                Some(U1),
                A1,
                json!([{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]),
            ),
            tool_result(A1, TR1),
            assistant(Some(TR1), A2, json!([{"type": "text", "text": "收尾"}])),
            user(Some(A2), U2, "二问"),
        ]);
        delete_message_blocking(&f.db, "claude", &f.session_id, A1).unwrap();
        let values = parse_lines(&f.file);
        assert!(find(&values, A1).is_none());
        assert!(find(&values, TR1).is_none(), "工具结果子随调用条目移除");
        assert_eq!(
            find(&values, A2)
                .unwrap()
                .get("parentUuid")
                .and_then(Value::as_str),
            Some(U1)
        );
        assert!(find(&values, U2).is_some());
    }

    #[test]
    fn removes_multiple_tool_result_children_with_the_target() {
        let f = fixture(&[
            user(None, U1, "一问"),
            assistant(
                Some(U1),
                A1,
                json!([
                    {"type": "tool_use", "id": "t1", "name": "Bash", "input": {}},
                    {"type": "tool_use", "id": "t2", "name": "Bash", "input": {}}
                ]),
            ),
            tool_result(A1, TR1),
            tool_result(A1, TR2),
            user(Some(TR1), U2, "二问"),
        ]);
        delete_message_blocking(&f.db, "claude", &f.session_id, A1).unwrap();
        let values = parse_lines(&f.file);
        assert!(find(&values, A1).is_none());
        assert!(find(&values, TR1).is_none(), "第一个工具结果子随条目移除");
        assert!(find(&values, TR2).is_none(), "第二个工具结果子同样随条目移除");
        assert_eq!(
            find(&values, U2)
                .unwrap()
                .get("parentUuid")
                .and_then(Value::as_str),
            Some(U1)
        );
    }

    #[test]
    fn deletes_a_tail_message() {
        let f = fixture(&[
            user(None, U1, "一问"),
            assistant(Some(U1), A1, json!([{"type": "text", "text": "答一"}])),
            user(Some(A1), U2, "追问"),
        ]);
        delete_message_blocking(&f.db, "claude", &f.session_id, U2).unwrap();
        let values = parse_lines(&f.file);
        assert!(find(&values, U2).is_none());
        assert!(find(&values, A1).is_some());
        assert_eq!(values.len(), 2);
    }

    #[test]
    fn deleting_the_root_prompt_reconnects_children_to_null() {
        let f = fixture(&[
            user(None, U1, "第一问"),
            assistant(Some(U1), A1, json!([{"type": "text", "text": "答一"}])),
            user(Some(A1), U2, "二问"),
        ]);
        delete_message_blocking(&f.db, "claude", &f.session_id, U1).unwrap();
        let values = parse_lines(&f.file);
        assert!(find(&values, U1).is_none());
        assert!(find(&values, A1)
            .unwrap()
            .get("parentUuid")
            .unwrap()
            .is_null());
        assert!(find(&values, U2).is_some());
    }

    #[test]
    fn keeps_unrelated_lines_byte_for_byte() {
        let summary = json!({"type": "summary", "summary": "早先的标题", "leafUuid": U1});
        let fancy = json!({
            "parentUuid": A1,
            "type": "assistant",
            "uuid": A2,
            "sessionId": SESSION,
            "message": {"role": "assistant", "model": "m", "content": [
                {"type": "text", "text": "引号 \" 中文 😀 与\n换行"}
            ]},
            "timestamp": "2026-10-10T00:00:03.000Z",
        });
        let f = fixture(&[
            user(None, U1, "一问"),
            assistant(Some(U1), A1, json!([{"type": "text", "text": "答一"}])),
            fancy.clone(),
            summary.clone(),
            user(Some(A2), U3, "追问"),
        ]);
        delete_message_blocking(&f.db, "claude", &f.session_id, U3).unwrap();
        let after = std::fs::read_to_string(&f.file).unwrap();
        assert!(after.contains(&summary.to_string()), "非消息行原样保留");
        assert!(after.contains(&fancy.to_string()), "无关消息行原样保留");
        assert!(!after.contains(U3));
    }

    #[test]
    fn refuses_a_message_outside_the_chain() {
        // 遗弃分支：B1 挂在 A1 下，但从最新叶子（U3）走链到不了它。
        let f = fixture(&[
            user(None, U1, "一问"),
            assistant(Some(U1), A1, json!([{"type": "text", "text": "答一"}])),
            assistant(Some(A1), B1, json!([{"type": "text", "text": "被遗弃的回复"}])),
            user(Some(A1), U3, "二问"),
        ]);
        let err =
            delete_message_blocking(&f.db, "claude", &f.session_id, B1).unwrap_err();
        assert!(err.contains("链上"), "{err}");
        assert!(find(&parse_lines(&f.file), B1).is_some(), "拒绝时不改文件");
    }

    #[test]
    fn refuses_a_missing_or_tool_result_target() {
        let f = fixture(&[
            user(None, U1, "一问"),
            assistant(
                Some(U1),
                A1,
                json!([{"type": "tool_use", "id": "t1", "name": "Bash", "input": {}}]),
            ),
            tool_result(A1, TR1),
        ]);
        let missing = delete_message_blocking(
            &f.db,
            "claude",
            &f.session_id,
            &uuid::Uuid::new_v4().to_string(),
        );
        assert!(missing.unwrap_err().contains("找不到"));
        let tool = delete_message_blocking(&f.db, "claude", &f.session_id, TR1);
        assert!(tool.unwrap_err().contains("工具结果"));
        assert!(find(&parse_lines(&f.file), TR1).is_some(), "拒绝时不改文件");
    }

    #[test]
    fn refuses_a_corrupt_manifest() {
        let f = fixture(&[user(None, U1, "一问")]);
        let session_dir = f.project.join(&f.session_id);
        std::fs::create_dir_all(&session_dir).unwrap();
        std::fs::write(session_dir.join("segments.json"), "{ not json").unwrap();
        let err = delete_message_blocking(&f.db, "claude", &f.session_id, U1).unwrap_err();
        assert!(err.contains("分段结构"), "{err}");
        assert!(find(&parse_lines(&f.file), U1).is_some(), "拒绝时不改文件");
    }

    #[test]
    fn refuses_when_a_rotation_is_pending() {
        let f = fixture(&[user(None, U1, "一问")]);
        let session_dir = f.project.join(&f.session_id);
        std::fs::create_dir_all(&session_dir).unwrap();
        let manifest = json!({
            "version": 1,
            "sessionId": f.session_id,
            "activeSegment": "seg-2",
            "segments": [
                {"id": "seg-1", "seq": 0, "file": "segments/seg-1.jsonl", "kind": "root"},
                {"id": "seg-2", "seq": 1, "file": "segments/seg-2.jsonl", "kind": "compact", "parent": "seg-1"},
            ],
            "rotation": {
                "from": {"id": "seg-1", "seq": 0, "file": "segments/seg-1.jsonl", "kind": "root"},
                "next": {"id": "seg-2", "seq": 1, "file": "segments/seg-2.jsonl", "kind": "compact", "parent": "seg-1"},
                "nextFirstMessageUuid": "u-9",
            },
        });
        std::fs::write(
            session_dir.join("segments.json"),
            serde_json::to_string(&manifest).unwrap(),
        )
        .unwrap();
        let err = delete_message_blocking(&f.db, "claude", &f.session_id, U1).unwrap_err();
        assert!(err.contains("整理历史文件"), "{err}");
    }

    #[test]
    fn detects_a_live_session_from_the_pid_registry() {
        let scratch = Scratch::new();
        let config_dir = scratch.0.join("cli");
        let sessions = config_dir.join("sessions");
        std::fs::create_dir_all(&sessions).unwrap();
        let _guard = ConfigDirGuard::set(&config_dir);
        let session_id = uuid::Uuid::new_v4().to_string();
        // 活着的进程（本测试进程）注册着该会话 → 视为运行中。
        std::fs::write(
            sessions.join(format!("{}.json", std::process::id())),
            json!({"sessionId": session_id, "cwd": "/ws"}).to_string(),
        )
        .unwrap();
        assert!(session_is_live(&session_id).unwrap());
        assert!(!session_is_live(&uuid::Uuid::new_v4().to_string()).unwrap());
        // 进程早已退出：文件还在（哪怕损坏）也不算活着。
        std::fs::remove_file(sessions.join(format!("{}.json", std::process::id()))).unwrap();
        std::fs::write(sessions.join("999999.json"), "{ not json").unwrap();
        std::fs::write(
            sessions.join("999998.json"),
            json!({"sessionId": session_id}).to_string(),
        )
        .unwrap();
        assert!(!session_is_live(&session_id).unwrap());
        // 活进程的注册文件损坏：无法确认 → 报错而不是放行。
        std::fs::write(
            sessions.join(format!("{}.json", std::process::id())),
            "{ not json",
        )
        .unwrap();
        assert!(session_is_live(&session_id).is_err());
    }
}
