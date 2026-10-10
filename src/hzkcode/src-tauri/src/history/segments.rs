//! Session segment chains (CLI 3.1.0 会话分段).
//!
//! After every compaction the CLI archives the pre-compaction transcript as a
//! segment file under `<project>/<sessionId>/segments/seg-<seq>.jsonl` and
//! starts the post-compaction content as a new active segment; the active
//! segment always keeps living at `<project>/<sessionId>.jsonl` and the
//! manifest sits at `<project>/<sessionId>/segments.json`. Reading must walk
//! the manifest's parent chain from root to active so the GUI shows the same
//! full history a pre-segmentation single file carried.
//!
//! This module is strictly read-only. It mirrors the CLI's crash
//! reconciliation (`decideRotationRecovery`) just far enough to pick the
//! effective head segment of an in-flight rotation; on any ambiguity it falls
//! back to plain single-file reading, and unreadable ancestor segments are
//! skipped rather than failing the whole parse.

use serde::Deserialize;
use std::collections::HashSet;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};

const MANIFEST_VERSION: u32 = 1;
const MANIFEST_FILE: &str = "segments.json";
/// Chain length cap: a hand-edited manifest must not walk forever.
const MAX_CHAIN: usize = 256;
const FIRST_UUID_MAX_BYTES: usize = 8 * 1024 * 1024;

/// 转录消息类型白名单，与 CLI 的 `isTranscriptMessage` 对齐：只有这些行的
/// uuid 参与首/尾判定，会话级元数据行（custom-title 等）即使带 uuid 也不算。
const TRANSCRIPT_TYPES: [&str; 4] = ["user", "assistant", "attachment", "system"];

/// Segment kinds the CLI writes; a record with any other value makes the
/// whole manifest invalid (mirroring the CLI's `isSegmentRecord`).
const SEGMENT_KINDS: [&str; 3] = ["root", "compact", "branch"];

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SegmentRecord {
    id: String,
    seq: i64,
    file: String,
    kind: String,
    #[serde(default)]
    parent: Option<String>,
    #[serde(default)]
    last_message_uuid: Option<String>,
}

/// 与 CLI `isSegmentRecord` 对齐并收紧（非空 id、非负 seq、非空且无穿越
/// 组件的相对 file）：任一记录不合法时整份清单按无效处理、回退单文件。
fn is_valid_record(record: &SegmentRecord) -> bool {
    if record.id.trim().is_empty()
        || record.seq < 0
        || record.file.trim().is_empty()
        || !SEGMENT_KINDS.contains(&record.kind.as_str())
    {
        return false;
    }
    let rel = Path::new(&record.file);
    !rel.is_absolute()
        && rel
            .components()
            .all(|c| matches!(c, std::path::Component::Normal(_)))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Rotation {
    from: SegmentRecord,
    next: SegmentRecord,
    #[serde(default)]
    from_first_message_uuid: Option<String>,
    next_first_message_uuid: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u32,
    session_id: String,
    #[serde(default)]
    active_segment: Option<String>,
    #[serde(default)]
    segments: Vec<SegmentRecord>,
    #[serde(default)]
    rotation: Option<Rotation>,
}

fn session_dir_and_stem(active_path: &Path) -> Option<(PathBuf, String)> {
    let dir = active_path.parent()?.to_path_buf();
    let stem = active_path.file_stem()?.to_string_lossy().to_string();
    if stem.is_empty() {
        return None;
    }
    Some((dir, stem))
}

fn manifest_path(active_path: &Path) -> Option<PathBuf> {
    let (dir, stem) = session_dir_and_stem(active_path)?;
    Some(dir.join(stem).join(MANIFEST_FILE))
}

/// Resolve one record's archived file under `<project>/<sessionId>/`.
/// Relative `file` values only; traversal components are refused.
fn record_archive_path(active_path: &Path, record: &SegmentRecord) -> Option<PathBuf> {
    let (dir, stem) = session_dir_and_stem(active_path)?;
    let rel = Path::new(&record.file);
    if rel.is_absolute()
        || rel
            .components()
            .any(|c| !matches!(c, std::path::Component::Normal(_)))
    {
        return None;
    }
    Some(dir.join(stem).join(rel))
}

fn read_manifest(active_path: &Path) -> Option<Manifest> {
    let path = manifest_path(active_path)?;
    let content = std::fs::read_to_string(path).ok()?;
    let manifest: Manifest = serde_json::from_str(&content).ok()?;
    let (_, stem) = session_dir_and_stem(active_path)?;
    if manifest.version != MANIFEST_VERSION || manifest.session_id != stem {
        return None;
    }
    // Record validation mirrors the CLI's `every(isSegmentRecord)`; ids must
    // be unique within `segments`. Rotation records may legitimately repeat a
    // listed id (they are the sealed/next versions of it), so uniqueness
    // applies inside `segments` and between the two rotation records only.
    let mut seen: HashSet<&str> = HashSet::new();
    for record in &manifest.segments {
        if !is_valid_record(record) || !seen.insert(record.id.as_str()) {
            return None;
        }
    }
    if let Some(rotation) = &manifest.rotation {
        if !is_valid_record(&rotation.from)
            || !is_valid_record(&rotation.next)
            || rotation.from.id == rotation.next.id
        {
            return None;
        }
    }
    Some(manifest)
}

fn parse_transcript_uuid(line: &str) -> Option<String> {
    let value: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    let uuid = value.get("uuid")?.as_str()?;
    let line_type = value.get("type")?.as_str()?;
    TRANSCRIPT_TYPES
        .contains(&line_type)
        .then(|| uuid.to_string())
}

/// First uuid-carrying transcript message of a file (session-level metadata
/// lines are skipped). Read failures and no-hit both return None.
fn read_first_transcript_uuid(path: &Path) -> Option<String> {
    let file = std::fs::File::open(path).ok()?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    let mut consumed = 0usize;
    loop {
        line.clear();
        let read = reader.read_line(&mut line).ok()?;
        if read == 0 {
            return None;
        }
        consumed += read;
        if consumed > FIRST_UUID_MAX_BYTES {
            return None;
        }
        if let Some(uuid) = parse_transcript_uuid(&line) {
            return Some(uuid);
        }
    }
}

/// Last uuid-carrying transcript message of a file, scanned from the tail
/// with an expanding window so a trailing oversized line is still found.
fn read_last_transcript_uuid(path: &Path) -> Option<String> {
    let mut file = std::fs::File::open(path).ok()?;
    let size = file.metadata().ok()?.len();
    if size == 0 {
        return None;
    }
    let mut window = std::cmp::min(256 * 1024, size);
    loop {
        let start = size - window;
        file.seek(SeekFrom::Start(start)).ok()?;
        let mut buf = vec![0u8; (size - start) as usize];
        file.read_exact(&mut buf).ok()?;
        let text = String::from_utf8_lossy(&buf);
        let mut lines: Vec<&str> = text.split('\n').collect();
        // A window that starts mid-file may begin inside a line; drop it.
        if start > 0 && !lines.is_empty() {
            lines.remove(0);
        }
        for line in lines.iter().rev() {
            if let Some(uuid) = parse_transcript_uuid(line) {
                return Some(uuid);
            }
        }
        if start == 0 {
            return None;
        }
        window = std::cmp::min(window * 4, size);
    }
}

/// The effective head segment plus where its file lives.
struct Head {
    record: SegmentRecord,
    file: PathBuf,
}

fn find_record<'a>(base: &'a [SegmentRecord], rotation: Option<&'a Rotation>, id: &str) -> Option<&'a SegmentRecord> {
    if let Some(record) = base.iter().find(|r| r.id == id) {
        return Some(record);
    }
    let rotation = rotation?;
    if rotation.from.id == id {
        return Some(&rotation.from);
    }
    if rotation.next.id == id {
        return Some(&rotation.next);
    }
    None
}

/// Pick the read head, mirroring the CLI's `decideRotationRecovery` in a
/// read-only way. None means the state cannot be confirmed — callers fall
/// back to plain single-file reading.
fn effective_head(active_path: &Path, manifest: &Manifest) -> Option<Head> {
    let base = &manifest.segments;
    let Some(rotation) = manifest.rotation.as_ref() else {
        let id = manifest.active_segment.as_deref()?;
        let record = find_record(base, None, id)?.clone();
        return Some(Head {
            record,
            file: active_path.to_path_buf(),
        });
    };

    let from_archive = record_archive_path(active_path, &rotation.from);
    let from_exists = from_archive.as_ref().is_some_and(|p| p.exists());
    let active_exists = active_path.exists();
    let active_first = if active_exists {
        read_first_transcript_uuid(active_path)
    } else {
        None
    };
    let active_is_next = active_exists
        && active_first.as_deref() == Some(rotation.next_first_message_uuid.as_str())
        && match rotation.next.last_message_uuid.as_deref() {
            Some(last) => {
                read_last_transcript_uuid(active_path).as_deref() == Some(last)
            }
            None => true,
        };
    let active_is_from = active_exists
        && rotation.from_first_message_uuid.as_deref().is_some()
        && active_first.as_deref() == rotation.from_first_message_uuid.as_deref();

    if !from_exists {
        // Archive missing: the CLI halts with the transition kept for manual
        // handling. `clear-rotation` (active still the original segment) maps
        // back to the manifest view; a verified next-segment active file is
        // read on a best-effort basis; anything else is left alone.
        if active_is_from {
            let record = manifest
                .active_segment
                .as_deref()
                .and_then(|id| find_record(base, Some(rotation), id))
                .cloned()
                .unwrap_or_else(|| rotation.from.clone());
            return Some(Head {
                record,
                file: active_path.to_path_buf(),
            });
        }
        if active_is_next {
            return Some(Head {
                record: rotation.next.clone(),
                file: active_path.to_path_buf(),
            });
        }
        return None;
    }

    if !active_exists {
        // Rollback not performed yet: the archived from-segment is the head.
        return Some(Head {
            record: rotation.from.clone(),
            file: from_archive?,
        });
    }
    if active_is_next {
        // Roll-forward: the new segment is already active; the manifest just
        // has not been rewritten.
        return Some(Head {
            record: rotation.next.clone(),
            file: active_path.to_path_buf(),
        });
    }
    // Rollback-quarantine not performed yet: the active file failed its
    // identity check and belongs to no segment; read the archived from-segment.
    Some(Head {
        record: rotation.from.clone(),
        file: from_archive?,
    })
}

/// Session files to read, in root → active order. Returns just the active
/// file for unsegmented sessions and for every unconfirmable state.
pub(crate) fn session_files_for_read(engine: &str, active_path: &Path) -> Vec<PathBuf> {
    let single = || vec![active_path.to_path_buf()];
    if engine != "claude" {
        return single();
    }
    let Some(manifest) = read_manifest(active_path) else {
        return single();
    };
    let Some(head) = effective_head(active_path, &manifest) else {
        return single();
    };

    // Collect the parent chain (head → root), then flip it to root → head.
    let mut records: Vec<SegmentRecord> = vec![head.record.clone()];
    let mut seen: HashSet<String> = HashSet::from([head.record.id.clone()]);
    let mut cursor = head.record.parent.clone();
    while let Some(parent_id) = cursor {
        let Some(record) = find_record(&manifest.segments, manifest.rotation.as_ref(), &parent_id)
        else {
            break;
        };
        if !seen.insert(record.id.clone()) || records.len() >= MAX_CHAIN {
            break;
        }
        cursor = record.parent.clone();
        records.push(record.clone());
    }
    records.reverse();

    let head_id = &head.record.id;
    let mut files: Vec<PathBuf> = Vec::with_capacity(records.len());
    for record in &records {
        if record.id == *head_id {
            files.push(head.file.clone());
            continue;
        }
        // Ancestor segments live under the archived path; a missing file is a
        // chain hole — skip it but keep walking.
        if let Some(path) = record_archive_path(active_path, record) {
            if path.exists() {
                files.push(path);
            }
        }
    }
    if files.is_empty() {
        return single();
    }
    files
}

/// FNV-1a style deterministic mix. A plain sum would collide when one segment
/// grows while another shrinks; the mix keeps each file's identity (path,
/// size, mtime) order-sensitively in the value. The mix is only ever compared
/// with itself (same function both sides), so its exact algorithm is free to
/// change as long as `CACHE_VERSION` moves with it.
fn mix(acc: u64, bytes: &[u8]) -> u64 {
    let mut acc = acc;
    for byte in bytes {
        acc ^= *byte as u64;
        acc = acc.wrapping_mul(0x0000_0100_0000_01B3);
    }
    acc
}

fn mix_num(acc: u64, value: i64) -> u64 {
    mix(acc, &value.to_le_bytes())
}

const MIX_OFFSET_BASIS: u64 = 0xcbf2_9ce4_8422_2325;

/// Signature for change detection. Without a manifest it is exactly the
/// active file's (size, mtime) — unchanged from the pre-segmentation app.
/// With one, the `size` slot carries an order-sensitive deterministic mix of
/// the manifest and every chain file (path + size + mtime) and the `mtime`
/// slot takes the max over them — so rotations and any rewrite of the chain
/// (even one that preserves a file's mtime, or offsets one segment's growth
/// against another's shrink) still invalidate cached parses and scans. Only
/// this module compares the values, so the folded slot stays internally
/// consistent as long as every reader uses it.
pub(crate) fn session_stat_signature(engine: &str, path: &Path) -> Option<(i64, i64)> {
    let (active_size, active_mtime) = super::stat_signature(path)?;
    let mut acc = MIX_OFFSET_BASIS;
    acc = mix_num(acc, active_size);
    acc = mix_num(acc, active_mtime);
    let mut mtime = active_mtime;
    let mut folded = false;
    if let Some(manifest) = manifest_path(path) {
        if let Some((manifest_size, manifest_mtime)) = super::stat_signature(&manifest) {
            acc = mix_num(acc, manifest_size);
            acc = mix_num(acc, manifest_mtime);
            mtime = mtime.max(manifest_mtime);
            folded = true;
        }
    }
    for file in session_files_for_read(engine, path) {
        if file.as_path() == path {
            continue;
        }
        if let Some((size, file_mtime)) = super::stat_signature(&file) {
            acc = mix(acc, file.to_string_lossy().as_bytes());
            acc = mix_num(acc, size);
            acc = mix_num(acc, file_mtime);
            mtime = mtime.max(file_mtime);
            folded = true;
        }
    }
    if !folded {
        return Some((active_size, active_mtime));
    }
    Some(((acc & 0x7FFF_FFFF_FFFF_FFFF) as i64, mtime))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Scratch(PathBuf);
    impl Scratch {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!(
                "hzkcode-segments-{}",
                uuid::Uuid::new_v4()
            ));
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn write(&self, rel: &str, content: &str) {
            let path = self.0.join(rel);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, content).unwrap();
        }
    }
    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    fn user_line(uuid: &str) -> String {
        format!(
            "{{\"type\":\"user\",\"uuid\":\"{uuid}\",\"message\":{{\"role\":\"user\",\"content\":\"hi\"}}}}\n"
        )
    }

    fn meta_line() -> String {
        "{\"type\":\"custom-title\",\"customTitle\":\"t\",\"uuid\":\"meta-uuid\"}\n".to_string()
    }

    fn files_of(root: &Path, rel: &str) -> Vec<String> {
        let active = root.join(rel);
        session_files_for_read("claude", &active)
            .into_iter()
            .map(|p| {
                p.strip_prefix(root)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .to_string()
            })
            .collect()
    }

    #[test]
    fn no_manifest_reads_single_file() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("a1"));
        assert_eq!(files_of(&scratch.0, "proj/sess-1.jsonl"), ["proj/sess-1.jsonl"]);
    }

    #[test]
    fn segmented_chain_reads_root_to_active() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("root-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-2","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"}]}"#,
        );
        assert_eq!(
            files_of(&scratch.0, "proj/sess-1.jsonl"),
            ["proj/sess-1/segments/seg-1.jsonl", "proj/sess-1.jsonl"]
        );
    }

    #[test]
    fn multi_compact_chain_keeps_order() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("root-1"));
        scratch.write("proj/sess-1/segments/seg-2.jsonl", &user_line("mid-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-3","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"},
                {"id":"seg-3","seq":3,"file":"segments/seg-3.jsonl","kind":"compact","parent":"seg-2"}]}"#,
        );
        assert_eq!(
            files_of(&scratch.0, "proj/sess-1.jsonl"),
            [
                "proj/sess-1/segments/seg-1.jsonl",
                "proj/sess-1/segments/seg-2.jsonl",
                "proj/sess-1.jsonl"
            ]
        );
    }

    #[test]
    fn roll_forward_pending_reads_new_active_with_archive() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("next-1"));
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("from-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":null,"segments":[],
                "rotation":{"from":{"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                "next":{"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"},
                "fromFirstMessageUuid":"from-1","nextFirstMessageUuid":"next-1"}}"#,
        );
        assert_eq!(
            files_of(&scratch.0, "proj/sess-1.jsonl"),
            ["proj/sess-1/segments/seg-1.jsonl", "proj/sess-1.jsonl"]
        );
    }

    #[test]
    fn rollback_pending_reads_archived_from() {
        let scratch = Scratch::new();
        // Active file gone (renamed away); only the archive remains.
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("from-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-1","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null}],
                "rotation":{"from":{"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null,"endedAt":"2026-10-04T09:00:00Z","endReason":"compact"},
                "next":{"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"},
                "fromFirstMessageUuid":"from-1","nextFirstMessageUuid":"next-1"}}"#,
        );
        assert_eq!(
            files_of(&scratch.0, "proj/sess-1.jsonl"),
            ["proj/sess-1/segments/seg-1.jsonl"]
        );
    }

    #[test]
    fn clear_rotation_reads_active_segment() {
        let scratch = Scratch::new();
        // First rotation crashed before archiving: active file still the
        // original segment, no archive exists.
        scratch.write("proj/sess-1.jsonl", &user_line("from-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":null,"segments":[],
                "rotation":{"from":{"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                "next":{"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"},
                "fromFirstMessageUuid":"from-1","nextFirstMessageUuid":"next-1"}}"#,
        );
        assert_eq!(files_of(&scratch.0, "proj/sess-1.jsonl"), ["proj/sess-1.jsonl"]);
    }

    #[test]
    fn halt_ambiguous_falls_back_to_single_file() {
        let scratch = Scratch::new();
        // Archive lost and the active file matches neither side.
        scratch.write("proj/sess-1.jsonl", &user_line("other-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-1","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null}],
                "rotation":{"from":{"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                "next":{"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"},
                "fromFirstMessageUuid":"from-1","nextFirstMessageUuid":"next-1"}}"#,
        );
        assert_eq!(files_of(&scratch.0, "proj/sess-1.jsonl"), ["proj/sess-1.jsonl"]);
    }

    #[test]
    fn missing_ancestor_segment_is_skipped() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        // seg-1 file is gone; seg-2 (the head's parent) survives.
        scratch.write("proj/sess-1/segments/seg-2.jsonl", &user_line("mid-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-3","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"},
                {"id":"seg-3","seq":3,"file":"segments/seg-3.jsonl","kind":"compact","parent":"seg-2"}]}"#,
        );
        assert_eq!(
            files_of(&scratch.0, "proj/sess-1.jsonl"),
            ["proj/sess-1/segments/seg-2.jsonl", "proj/sess-1.jsonl"]
        );
    }

    #[test]
    fn first_and_last_uuid_skip_metadata_lines() {
        let scratch = Scratch::new();
        scratch.write(
            "proj/sess-1.jsonl",
            &format!("{}{}{}{}", meta_line(), user_line("u1"), "\n", user_line("u2")),
        );
        let path = scratch.0.join("proj/sess-1.jsonl");
        assert_eq!(read_first_transcript_uuid(&path).as_deref(), Some("u1"));
        assert_eq!(read_last_transcript_uuid(&path).as_deref(), Some("u2"));
    }

    #[test]
    fn segmented_signature_differs_from_plain_stat_and_covers_mtimes() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("a1"));
        let active = scratch.0.join("proj/sess-1.jsonl");
        let active_sig = super::super::stat_signature(&active).unwrap();
        // No manifest: the signature stays the plain stat (unsegmented
        // sessions must not re-scan on upgrade).
        assert_eq!(session_stat_signature("claude", &active), Some(active_sig));
        // Manifest + archived segment: the signature folds them in.
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("root-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-2","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"}]}"#,
        );
        let manifest_m = super::super::stat_signature(&scratch.0.join("proj/sess-1/segments.json"))
            .unwrap()
            .1;
        let segment_m =
            super::super::stat_signature(&scratch.0.join("proj/sess-1/segments/seg-1.jsonl"))
                .unwrap()
                .1;
        let sig = session_stat_signature("claude", &active).unwrap();
        assert_ne!(sig, active_sig);
        assert!(sig.1 >= manifest_m && sig.1 >= segment_m);
    }

    #[test]
    fn signature_detects_opposite_size_changes_with_restored_mtimes() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("aaaa"));
        scratch.write("proj/sess-1/segments/seg-2.jsonl", &user_line("bbbb"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-3","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"},
                {"id":"seg-3","seq":3,"file":"segments/seg-3.jsonl","kind":"compact","parent":"seg-2"}]}"#,
        );
        let active = scratch.0.join("proj/sess-1.jsonl");
        let before = session_stat_signature("claude", &active).unwrap();
        let seg1 = scratch.0.join("proj/sess-1/segments/seg-1.jsonl");
        let seg2 = scratch.0.join("proj/sess-1/segments/seg-2.jsonl");
        let seg1_mtime = std::fs::metadata(&seg1).unwrap().modified().unwrap();
        let seg2_mtime = std::fs::metadata(&seg2).unwrap().modified().unwrap();
        // One segment grows by a byte, the other shrinks by a byte: the total
        // stays the same and both mtimes are restored afterwards.
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("aaaaa"));
        scratch.write("proj/sess-1/segments/seg-2.jsonl", &user_line("bbb"));
        std::fs::File::options()
            .write(true)
            .open(&seg1)
            .unwrap()
            .set_modified(seg1_mtime)
            .unwrap();
        std::fs::File::options()
            .write(true)
            .open(&seg2)
            .unwrap()
            .set_modified(seg2_mtime)
            .unwrap();
        let after = session_stat_signature("claude", &active).unwrap();
        assert_eq!(before.1, after.1, "premise: mtimes restored");
        assert_ne!(before, after, "offsetting size changes must invalidate the signature");
    }

    #[test]
    fn invalid_kind_falls_back_to_single_file() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("root-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-2","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"garbage","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"}]}"#,
        );
        assert_eq!(files_of(&scratch.0, "proj/sess-1.jsonl"), ["proj/sess-1.jsonl"]);
    }

    #[test]
    fn invalid_file_paths_fall_back_to_single_file() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        for bad in ["../evil.jsonl", "/etc/passwd", ""] {
            scratch.write(
                "proj/sess-1/segments.json",
                &format!(
                    r#"{{"version":1,"sessionId":"sess-1","activeSegment":"seg-1","segments":[
                        {{"id":"seg-1","seq":1,"file":"{bad}","kind":"root","parent":null}}]}}"#
                ),
            );
            assert_eq!(
                files_of(&scratch.0, "proj/sess-1.jsonl"),
                ["proj/sess-1.jsonl"],
                "file={bad:?} must invalidate the manifest"
            );
        }
    }

    #[test]
    fn duplicate_segment_ids_fall_back_to_single_file() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-2","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-1","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"}]}"#,
        );
        assert_eq!(files_of(&scratch.0, "proj/sess-1.jsonl"), ["proj/sess-1.jsonl"]);
    }

    #[test]
    fn missing_seq_falls_back_to_single_file() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-1","segments":[
                {"id":"seg-1","file":"segments/seg-1.jsonl","kind":"root","parent":null}]}"#,
        );
        assert_eq!(files_of(&scratch.0, "proj/sess-1.jsonl"), ["proj/sess-1.jsonl"]);
    }

    #[test]
    fn signature_changes_when_archive_segment_rewritten_without_mtime_change() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("root-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-2","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"}]}"#,
        );
        let active = scratch.0.join("proj/sess-1.jsonl");
        let segment = scratch.0.join("proj/sess-1/segments/seg-1.jsonl");
        let before = session_stat_signature("claude", &active).unwrap();
        let old_mtime = std::fs::metadata(&segment).unwrap().modified().unwrap();
        // Shorter content (size change) with the old mtime restored: the
        // signature must still notice.
        scratch.write("proj/sess-1/segments/seg-1.jsonl", &user_line("x"));
        std::fs::File::options()
            .write(true)
            .open(&segment)
            .unwrap()
            .set_modified(old_mtime)
            .unwrap();
        let after = session_stat_signature("claude", &active).unwrap();
        assert_eq!(before.1, after.1, "premise: mtime restored");
        assert_ne!(before, after, "size change must invalidate the signature");
    }

    #[test]
    fn negative_seq_falls_back_to_single_file() {
        let scratch = Scratch::new();
        scratch.write("proj/sess-1.jsonl", &user_line("active-1"));
        scratch.write(
            "proj/sess-1/segments.json",
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-1","segments":[
                {"id":"seg-1","seq":-1,"file":"segments/seg-1.jsonl","kind":"root","parent":null}]}"#,
        );
        assert_eq!(files_of(&scratch.0, "proj/sess-1.jsonl"), ["proj/sess-1.jsonl"]);
    }
}
