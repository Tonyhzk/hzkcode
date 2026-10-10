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
/// way the pre-segmentation single file carried it. Each segment's dead
/// branches (a rewind's abandoned tail) are filtered on its own chain — the
/// CLI restarts every segment from a null parent and only links back through
/// a compact boundary's `logicalParentUuid`, so the filter must not expect
/// message-level links across segment borders (see
/// dead_branch_uuids_for_chain).
pub fn parse_session_file(engine: &str, path: &Path) -> Result<ParsedSession, String> {
    let files = super::segments::session_files_for_read(engine, path);
    let extract = extractor_for(engine, ImageMode::Collect);
    let filter = dead_branch_uuids_for_chain(&files);
    let mut rows: Vec<LineRow> = Vec::new();
    for (file, segment_dead) in files.iter().zip(filter.dead.iter()) {
        let reader = match open_line_reader(file) {
            Ok(reader) => reader,
            // The primary (active) file surfaces its real error; an unreadable
            // archive segment only trims history and must not fail the parse.
            Err(error) if file.as_path() == path => return Err(error),
            Err(_) => continue,
        };
        let drop = (!segment_dead.is_empty()).then_some(segment_dead);
        // Anything read from a file that is not the active one is archived
        // history, and inside the active file only the CLI's own resume
        // chain is addressable (it walks `parentUuid` without bridging
        // compact boundaries): rows outside it keep no rewind entry.
        let archived_file = file.as_path() != path;
        walk_lines(reader, &extract, drop, |mut row| {
            row.archived = archived_file
                || match (&row.uuid, &filter.rewindable) {
                    (Some(uuid), Some(rewindable)) => !rewindable.contains(uuid),
                    _ => false,
                };
            rows.push(row);
        });
    }
    Ok(fold_rows(rows))
}

/// Transcript message types that participate in the chain, mirroring the
/// CLI's `isTranscriptMessage`.
const CHAIN_TYPES: [&str; 4] = ["user", "assistant", "attachment", "system"];

/// Per-segment chain index: the positioned entries of one segment file
/// (uuid → (parentUuid, logicalParentUuid)), its transcript chain nodes in
/// file order, and the parallel-tool topology (assistant siblings by
/// `message.id`, tool results by parent) the recovery pass needs.
pub(super) struct SegmentChain {
    links: HashMap<String, (Option<String>, Option<String>)>,
    order: Vec<String>,
    /// Chain-node uuid → transcript `type` ("user"/"assistant"/…): the
    /// trailing-prompt trim needs to tell an unanswered prompt from a reply.
    node_types: HashMap<String, String>,
    assistants: Vec<(String, String)>,
    tool_results: Vec<(String, String)>,
    boundaries: Vec<String>,
    preserved: Vec<PreservedSegment>,
}

/// A compact boundary that kept a slice of history: the CLI writes the kept
/// entries with their original pre-compact `parentUuid` on disk and relinks
/// them in memory at load (`applyPreservedSegmentRelinks`).
struct PreservedSegment {
    boundary: String,
    head: String,
    tail: String,
    anchor: Option<String>,
}

/// What the chain analysis yields for one session: which uuids the page
/// hides, and which ones the CLI can still resume at.
pub(super) struct ChainFilter {
    /// Dead-branch uuids per file (parallel to `files`; an unreadable file
    /// maps to an empty set). Each segment's dead branches are judged on its
    /// own chain — the CLI's segments are self-contained (every segment
    /// restarts from a null parent, and a compact boundary points back
    /// through `logicalParentUuid` instead of a message link), so a merged
    /// walk would depend on bridges that need not exist. The sets stay per
    /// file so a uuid that is dead in one segment but alive in another
    /// (identical uuids cannot occur in practice, but nothing in the format
    /// forbids them) never gets dropped on the wrong segment.
    ///
    /// A segment contributes nothing when its own layout is not understood
    /// (a dangling reference to a uuid no segment knows, or a cycle):
    /// dropping history on a guess is worse than showing a rewound-away
    /// tail.
    pub dead: Vec<std::collections::HashSet<String>>,
    /// Uuids of the active file that `--resume-session-at` can resolve. The
    /// CLI loads the active file alone and walks it with `parentUuid` only
    /// (`buildConversationChain`, plus the relink and parallel-tool
    /// recovery passes), so pre-boundary history that the page still shows
    /// is not resumable. None when that walk is not understood: everything
    /// stays rewindable rather than hiding the affordance on a guess.
    pub rewindable: Option<std::collections::HashSet<String>>,
}

pub(super) fn dead_branch_uuids_for_chain(files: &[std::path::PathBuf]) -> ChainFilter {
    let mut segments: Vec<Option<SegmentChain>> = Vec::with_capacity(files.len());
    let mut anywhere: std::collections::HashSet<String> = std::collections::HashSet::new();
    for file in files {
        // An unreadable archive segment only trims history (the parse loop
        // reports the active file's own error); leaving it out of `anywhere`
        // keeps references to its uuids conservative for every other segment.
        let segment = open_line_reader(file).ok().map(segment_chain);
        if let Some(segment) = &segment {
            anywhere.extend(segment.links.keys().cloned());
        }
        segments.push(segment);
    }
    let active = segments.last().and_then(|segment| segment.as_ref());
    let rewindable = active.and_then(|segment| {
        let kept = segment_kept_uuids(segment, &anywhere, false, false)?;
        Some(drop_unanswered_tail_prompts(segment, kept))
    });
    let dead = segments
        .iter()
        .map(|segment| match segment {
            Some(segment) => segment_dead_uuids(segment, &anywhere).unwrap_or_default(),
            None => std::collections::HashSet::new(),
        })
        .collect();
    ChainFilter { dead, rewindable }
}

/// Index one segment file: positioned entries, transcript chain nodes in
/// file order, and the parallel-tool topology.
pub(super) fn segment_chain(reader: impl BufRead) -> SegmentChain {
    let mut chain = SegmentChain {
        links: HashMap::new(),
        order: Vec::new(),
        node_types: HashMap::new(),
        assistants: Vec::new(),
        tool_results: Vec::new(),
        boundaries: Vec::new(),
        preserved: Vec::new(),
    };
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("\"type\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        let Some(ty) = value.get("type").and_then(Value::as_str) else {
            continue;
        };
        if value.get("isSidechain").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        let Some(uuid) = value
            .get("uuid")
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
        else {
            continue;
        };
        // A missing parentUuid field is not a chain position (null IS one:
        // the session root or a compact boundary).
        if value.get("parentUuid").is_none() {
            continue;
        }
        let parent = value
            .get("parentUuid")
            .and_then(Value::as_str)
            .map(str::to_string);
        let logical = value
            .get("logicalParentUuid")
            .and_then(Value::as_str)
            .map(str::to_string);
        if CHAIN_TYPES.contains(&ty) {
            chain.order.push(uuid.to_string());
            chain.node_types.insert(uuid.to_string(), ty.to_string());
        }
        // Parallel-tool topology for the recovery pass: assistant siblings
        // share `message.id`, and a tool-result row's parentUuid points at
        // the one-block assistant whose tool_use produced it.
        if ty == "assistant" {
            if let Some(id) = value
                .pointer("/message/id")
                .and_then(Value::as_str)
                .filter(|s| !s.is_empty())
            {
                chain.assistants.push((uuid.to_string(), id.to_string()));
            }
        } else if ty == "user" {
            let is_tool_result = value
                .pointer("/message/content")
                .and_then(Value::as_array)
                .is_some_and(|blocks| {
                    blocks
                        .iter()
                        .any(|b| b.get("type").and_then(Value::as_str) == Some("tool_result"))
                });
            if is_tool_result {
                if let Some(parent) = &parent {
                    chain.tool_results.push((uuid.to_string(), parent.clone()));
                }
            }
        }
        // Preserved-segment compaction (reactive / partial / session-memory
        // compact): the boundary records the kept slice while those entries
        // keep their pre-compact parentUuid on disk.
        if ty == "system" && value.get("subtype").and_then(Value::as_str) == Some("compact_boundary")
        {
            chain.boundaries.push(uuid.to_string());
            if let Some(segment) = value.pointer("/compactMetadata/preservedSegment") {
                let head = segment.get("headUuid").and_then(Value::as_str);
                let tail = segment.get("tailUuid").and_then(Value::as_str);
                if let (Some(head), Some(tail)) = (head, tail) {
                    chain.preserved.push(PreservedSegment {
                        boundary: uuid.to_string(),
                        head: head.to_string(),
                        tail: tail.to_string(),
                        anchor: segment
                            .get("anchorUuid")
                            .and_then(Value::as_str)
                            .map(str::to_string),
                    });
                }
            }
        }
        chain.links.insert(uuid.to_string(), (parent, logical));
    }
    chain
}

/// The outcome of mirroring the CLI's preserved-segment relink for one
/// segment (see `relink_preserved`).
enum RelinkOutcome {
    /// No live preserved slice: walk the segment's own links.
    NotNeeded,
    /// The slice was spliced back: walk these links instead.
    Patched(HashMap<String, (Option<String>, Option<String>)>),
    /// The slice's tail → head walk does not close: keep the segment whole.
    Unresolved,
}

/// Mirror the CLI's `applyPreservedSegmentRelinks` on one segment: of the
/// boundaries in this file only the last one may still be live, and when it
/// carries a preserved slice, splice that slice back before the chain walk
/// sees it — `head → anchor`, and the anchor's other children → tail. The
/// kept entries themselves stay where they are on disk (their parentUuid is
/// the pre-compact one); the chain walk then reaches them through the
/// patched head, and a later rewind re-roots only what the walk can no
/// longer reach.
///
/// `Unresolved` (the segment is then kept whole, like the CLI's no-op) when
/// the slice cannot be confirmed: an anchor missing from the metadata or a
/// tail → head walk that runs outside this segment.
fn relink_preserved(segment: &SegmentChain) -> RelinkOutcome {
    let links = &segment.links;
    let Some(last_boundary) = segment.boundaries.last() else {
        return RelinkOutcome::NotNeeded;
    };
    let Some(preserved) = segment
        .preserved
        .iter()
        .find(|preserved| preserved.boundary == *last_boundary)
    else {
        // A stale slice (an older boundary): the CLI skips the relink too.
        return RelinkOutcome::NotNeeded;
    };
    let Some(anchor) = preserved.anchor.as_deref() else {
        return RelinkOutcome::Unresolved;
    };
    let mut seen: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut cur = Some(preserved.tail.as_str());
    let mut reached_head = false;
    while let Some(uuid) = cur {
        if uuid == preserved.head {
            reached_head = true;
            break;
        }
        if !seen.insert(uuid) {
            break;
        }
        let Some((parent, logical)) = links.get(uuid) else {
            break;
        };
        cur = parent.as_deref().or(logical.as_deref());
        if let Some(next) = cur {
            if !links.contains_key(next) {
                cur = None;
            }
        }
    }
    if !reached_head {
        return RelinkOutcome::Unresolved;
    }
    let mut patched = links.clone();
    let head = preserved.head.as_str();
    if let Some((_, logical)) = patched.get(head) {
        patched.insert(
            head.to_string(),
            (Some(anchor.to_string()), logical.clone()),
        );
    }
    let others: Vec<String> = patched
        .iter()
        .filter(|(uuid, (parent, _))| parent.as_deref() == Some(anchor) && uuid.as_str() != head)
        .map(|(uuid, _)| uuid.clone())
        .collect();
    for uuid in others {
        let logical = patched[&uuid].1.clone();
        patched.insert(uuid, (Some(preserved.tail.clone()), logical));
    }
    // The boundary's logicalParentUuid is a display bridge back into the
    // pre-compact history; a prefix-preserving boundary points it at the
    // slice's own tail, so following it after the splice would loop back
    // through the slice. History is read from its own segment anyway — drop
    // the bridge on the patched view.
    if let Some((parent, _)) = patched.get(last_boundary.as_str()) {
        patched.insert(last_boundary.clone(), (parent.clone(), None));
    }
    RelinkOutcome::Patched(patched)
}

/// Kept uuids of one segment's chain walk, including the CLI's parallel-tool
/// recovery (streaming writes one assistant entry per content block, all
/// sharing `message.id`, and each tool result parents to its own block's
/// uuid; the single-parent walk alone would orphan them, so the CLI's
/// `recoverOrphanedParallelToolResults` pass is mirrored here).
///
/// A rewind (the interactive one, or a send carrying `--resume-session-at`)
/// leaves the rewound conversation in the append-only file forever; the walk
/// starts from the segment's latest leaf and takes everything it can reach
/// (the CLI's `buildConversationChain`). Only entries shaped like
/// main-conversation transcript messages join the chain.
///
/// `follow_logical` bridges compact boundaries through `logicalParentUuid`.
/// This reader's page view wants that (pre-compaction history stays visible,
/// matching its whole-chain semantics), but the CLI's own resume walk
/// follows `parentUuid` only — which is exactly why pre-boundary history is
/// shown here yet cannot be resumed there.
///
/// None when the layout is not understood (a cycle, or — with
/// `bail_on_dangling` — a reference to a uuid no segment knows). Without
/// `bail_on_dangling` such a reference just ends the walk, the way
/// `buildConversationChain` silently truncates the chain.
pub(super) fn segment_kept_uuids(
    segment: &SegmentChain,
    anywhere: &std::collections::HashSet<String>,
    follow_logical: bool,
    bail_on_dangling: bool,
) -> Option<std::collections::HashSet<String>> {
    let order = &segment.order;
    if order.is_empty() {
        return Some(std::collections::HashSet::new());
    }
    // The preserved slice's entries hold their pre-compact parentUuid on
    // disk; splice them back (in memory, like the CLI's loader) before
    // judging what the chain walk reaches.
    let relink = relink_preserved(segment);
    let links = match &relink {
        RelinkOutcome::NotNeeded => &segment.links,
        RelinkOutcome::Patched(patched) => patched,
        RelinkOutcome::Unresolved => return None,
    };
    let mut referenced: std::collections::HashSet<&str> = std::collections::HashSet::new();
    // Only chain nodes count as children for the leaf pick: an auxiliary node
    // trailing the newest message (a legacy `progress` entry parented to it)
    // must not disqualify that message as the latest leaf.
    for uuid in order {
        if let Some((parent, logical)) = links.get(uuid) {
            for link in [parent.as_deref(), logical.as_deref()].into_iter().flatten() {
                if links.contains_key(link) {
                    referenced.insert(link);
                }
            }
        }
    }
    // No unreferenced chain node = every chain cycles; not a layout this
    // walk understands.
    let leaf = order
        .iter()
        .rev()
        .find(|u| !referenced.contains(u.as_str()))?;
    let chain_set: std::collections::HashSet<&str> = order.iter().map(String::as_str).collect();
    let mut visited: std::collections::HashSet<&str> = std::collections::HashSet::new();
    let mut kept: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut cur: Option<&str> = Some(leaf.as_str());
    while let Some(uuid) = cur {
        if !visited.insert(uuid) {
            // Cycle: not a layout this walk understands — keep everything.
            return None;
        }
        if chain_set.contains(uuid) {
            kept.insert(uuid.to_string());
        }
        let (parent, logical) = links.get(uuid)?;
        let next = if follow_logical {
            parent.as_deref().or(logical.as_deref())
        } else {
            parent.as_deref()
        };
        match next {
            // Compact/replacement boundary or session root.
            None => break,
            Some(candidate) => {
                if links.contains_key(candidate) {
                    cur = Some(candidate);
                } else if anywhere.contains(candidate) {
                    // The chain continues in another segment — a legal
                    // boundary, not a broken layout.
                    break;
                } else if bail_on_dangling {
                    // Dangling parent — bail out rather than risk dropping
                    // still-reachable history.
                    return None;
                } else {
                    break;
                }
            }
        }
    }
    // Parallel-tool recovery (the CLI's recoverOrphanedParallelToolResults):
    // for every surviving assistant entry, its sibling blocks — same
    // `message.id` — and all their tool results belong to the surviving
    // turn, even though the walk followed a single branch through them.
    let mut by_id: HashMap<&str, Vec<&str>> = HashMap::new();
    for (uuid, id) in &segment.assistants {
        by_id.entry(id.as_str()).or_default().push(uuid.as_str());
    }
    let mut trs_by_parent: HashMap<&str, Vec<&str>> = HashMap::new();
    for (uuid, parent) in &segment.tool_results {
        trs_by_parent
            .entry(parent.as_str())
            .or_default()
            .push(uuid.as_str());
    }
    let mut processed: std::collections::HashSet<&str> = std::collections::HashSet::new();
    for (uuid, id) in &segment.assistants {
        if !kept.contains(uuid.as_str()) || !processed.insert(id.as_str()) {
            continue;
        }
        let Some(group) = by_id.get(id.as_str()) else {
            continue;
        };
        for member in group {
            kept.insert(member.to_string());
            if let Some(trs) = trs_by_parent.get(member) {
                kept.extend(trs.iter().map(|tr| tr.to_string()));
            }
        }
    }
    Some(kept)
}

/// The CLI resolves `--resume-session-at` only against the chain it loads
/// (`buildConversationChain` over the active file): a trailing prompt with
/// no reply yet — the orphaned input of a turn that failed before producing
/// anything — is not part of that chain. Trim the tail run of such prompt
/// nodes from the resumable set, or the page would offer a rewind point the
/// CLI rejects — and a rejected resume keeps its anchor, wedging every
/// retry. Tool-result rows are not prompt inputs and stay.
fn drop_unanswered_tail_prompts(
    segment: &SegmentChain,
    kept: std::collections::HashSet<String>,
) -> std::collections::HashSet<String> {
    let mut result = kept;
    let mut tail = segment
        .order
        .iter()
        .rev()
        .find(|uuid| result.contains(uuid.as_str()))
        .cloned();
    while let Some(uuid) = tail {
        let is_prompt = segment.node_types.get(&uuid).map(String::as_str) == Some("user")
            && !segment.tool_results.iter().any(|(u, _)| u == &uuid);
        if !is_prompt {
            break;
        }
        result.remove(&uuid);
        tail = segment
            .links
            .get(&uuid)
            .and_then(|(parent, _)| parent.as_ref())
            .filter(|parent| result.contains(parent.as_str()))
            .cloned();
    }
    result
}

/// Dead uuids of one segment; empty when nothing is dead, None when the
/// segment's layout is not understood (the caller then keeps it whole).
fn segment_dead_uuids(
    segment: &SegmentChain,
    anywhere: &std::collections::HashSet<String>,
) -> Option<std::collections::HashSet<String>> {
    let kept = segment_kept_uuids(segment, anywhere, true, true)?;
    if kept.len() == segment.order.len() {
        return Some(std::collections::HashSet::new());
    }
    Some(
        segment
            .order
            .iter()
            .filter(|uuid| !kept.contains(uuid.as_str()))
            .cloned()
            .collect(),
    )
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
    // Same dead-branch filter as the page reader (per-segment index pass, then
    // a streaming skip): after a rewind the sidebar's count and timestamps
    // must describe the surviving chain, not the withdrawn tail.
    let filter = dead_branch_uuids_for_chain(&files);
    let mut acc = ScanAcc::default();
    for (file, segment_dead) in files.iter().zip(filter.dead.iter()) {
        let reader = match open_line_reader(file) {
            Ok(reader) => reader,
            Err(error) if file.as_path() == path => return Err(error),
            Err(_) => continue,
        };
        let drop = (!segment_dead.is_empty()).then_some(segment_dead);
        walk_lines(reader, &extract, drop, |row| {
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
/// one NDJSON line, extract rows, normalize, hand each to `consume`. Entries
/// whose uuid is in `drop` (a dead branch) are skipped entirely.
fn walk_lines(
    reader: impl BufRead,
    extract: &LineExtractor<'_>,
    drop: Option<&std::collections::HashSet<String>>,
    mut consume: impl FnMut(LineRow),
) {
    for line in reader.lines() {
        let Ok(line) = line else { continue };
        let trimmed = line.trim();
        if trimmed.is_empty() || !trimmed.contains("\"type\"") {
            continue;
        }
        let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
            continue;
        };
        if let Some(drop) = drop {
            if let Some(uuid) = value.get("uuid").and_then(Value::as_str) {
                if drop.contains(uuid) {
                    continue;
                }
            }
        }
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
            archived: row.archived,
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
    /// True when the source line lives in an archived (pre-compaction)
    /// segment file rather than the active one; filled in per file by the
    /// parse loop.
    archived: bool,
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
            archived: false,
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

/// Flush buffered claude text as a row carrying the line's usage/model/effort
/// — and its entry uuid: a reply split by thinking or tool calls produces one
/// text row per segment, and every segment belongs to the same transcript
/// entry (the row actions address the entry by that uuid).
fn claude_flush_text(
    out: &mut LineRows,
    text: &mut String,
    role: &str,
    ts: &Option<String>,
    usage: &Option<Value>,
    model: &Option<String>,
    effort: &Option<String>,
    uuid: &Option<String>,
) {
    if !text.trim().is_empty() {
        out.push(LineRow {
            usage: usage.clone(),
            model: model.clone(),
            effort: effort.clone(),
            uuid: uuid.clone(),
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
    uuid: &Option<String>,
) {
    match block.get("type").and_then(Value::as_str) {
        Some("thinking") => {
            claude_flush_text(out, text, role, ts, usage, model, effort, uuid);
            if let Some(t) = block.get("thinking").and_then(Value::as_str) {
                out.push(LineRow::new("thinking", t.to_string(), ts.clone()));
            }
        }
        Some("tool_use") => {
            claude_flush_text(out, text, role, ts, usage, model, effort, uuid);
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
                    &uuid,
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
    fn claude_split_text_segments_all_carry_the_entry_uuid() {
        let line: Value = serde_json::json!({
            "uuid": "entry-1",
            "type": "assistant",
            "timestamp": "2026-09-05T11:12:16.469Z",
            "message": {
                "role": "assistant",
                "content": [
                    {"type": "text", "text": "先改文件"},
                    {"type": "tool_use", "name": "Edit", "input": {}},
                    {"type": "text", "text": "改完了"}
                ]
            }
        });
        let rows = extract_claude_line(&line, ImageMode::Collect);
        let seen: Vec<(&str, &str, Option<&str>)> = rows
            .iter()
            .map(|r| (r.role.as_str(), r.text.as_str(), r.uuid.as_deref()))
            .collect();
        // 工具调用前后的文本段都属于同一条目：各段都带条目 uuid（行操作
        // 按它定位），工具行保持无入口。
        assert_eq!(
            seen,
            [
                ("assistant", "先改文件", Some("entry-1")),
                ("tool", "Edit", None),
                ("assistant", "改完了", Some("entry-1")),
            ]
        );
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

    /// One transcript entry in the shape the CLI appends: user/assistant
    /// message with a parentUuid position (None = session root or compact
    /// boundary; with `logical` set it bridges a compaction).
    fn msg(
        role: &str,
        uuid: &str,
        parent: Option<&str>,
        logical: Option<&str>,
        text: &str,
        ts: &str,
    ) -> Value {
        let content = if role == "user" {
            serde_json::json!(text)
        } else {
            serde_json::json!([{"type": "text", "text": text}])
        };
        let mut value = serde_json::json!({
            "type": role,
            "uuid": uuid,
            "parentUuid": parent,
            "timestamp": ts,
            "message": {"role": role, "content": content},
        });
        if let Some(logical) = logical {
            value["logicalParentUuid"] = serde_json::json!(logical);
        }
        value
    }

    fn write_jsonl(path: &Path, lines: &[Value]) {
        let body: String = lines.iter().map(|v| v.to_string() + "\n").collect();
        std::fs::write(path, body).unwrap();
    }

    fn rewind_fixture(lines: &[Value]) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("hzkcode-extract-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("sess-fixture.jsonl");
        write_jsonl(&file, lines);
        (dir, file)
    }

    /// A compact boundary in the CLI's shape: `parentUuid` null, an optional
    /// `logicalParentUuid` bridge, and an optional preserved slice.
    fn boundary(
        uuid: &str,
        logical: Option<&str>,
        preserved: Option<(&str, &str, &str)>,
    ) -> Value {
        let mut value = serde_json::json!({
            "type": "system",
            "subtype": "compact_boundary",
            "content": "对话已压缩",
            "uuid": uuid,
            "parentUuid": serde_json::Value::Null,
            "timestamp": "2026-10-05T03:00:00.000Z",
        });
        if let Some(logical) = logical {
            value["logicalParentUuid"] = serde_json::json!(logical);
        }
        if let Some((head, anchor, tail)) = preserved {
            value["compactMetadata"] = serde_json::json!({
                "trigger": "reactive",
                "preservedSegment": {
                    "headUuid": head,
                    "anchorUuid": anchor,
                    "tailUuid": tail,
                },
            });
        }
        value
    }

    /// A segmented fixture: `root_lines` go to seg-1 (archived), `active_lines`
    /// to the active file, with a manifest chaining seg-1 → seg-2.
    fn segmented_fixture(
        root_lines: &[Value],
        active_lines: &[Value],
    ) -> (std::path::PathBuf, std::path::PathBuf) {
        let dir = std::env::temp_dir().join(format!("hzkcode-extract-{}", uuid::Uuid::new_v4()));
        let session = dir.join("proj");
        std::fs::create_dir_all(session.join("sess-1/segments")).unwrap();
        write_jsonl(&session.join("sess-1/segments/seg-1.jsonl"), root_lines);
        write_jsonl(&session.join("sess-1.jsonl"), active_lines);
        std::fs::write(
            session.join("sess-1/segments.json"),
            r#"{"version":1,"sessionId":"sess-1","activeSegment":"seg-2","segments":[
                {"id":"seg-1","seq":1,"file":"segments/seg-1.jsonl","kind":"root","parent":null},
                {"id":"seg-2","seq":2,"file":"segments/seg-2.jsonl","kind":"compact","parent":"seg-1"}]}"#,
        )
        .unwrap();
        (dir, session.join("sess-1.jsonl"))
    }

    /// Parsed text rows without the boundary usage markers.
    fn page_texts(parsed: &ParsedSession) -> Vec<&str> {
        parsed
            .messages
            .iter()
            .filter(|m| m.role != "__usage__")
            .map(|m| m.text.as_str())
            .collect()
    }

    #[test]
    fn rewound_tail_disappears_from_the_page() {
        // u1→a1→u2→a2 ran; the user rewound to a1 and sent u3, so the file
        // keeps the abandoned u2/a2 branch forever (append-only). The page
        // must walk the chain from the latest leaf (a3) and hide the tail.
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "第一问", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "第一答", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("a1"), None, "被撤回的问", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "被撤回的答", "2026-10-05T01:01:01.000Z"),
            msg("user", "u3", Some("a1"), None, "回退后的问", "2026-10-05T01:02:00.000Z"),
            msg("assistant", "a3", Some("u3"), None, "回退后的答", "2026-10-05T01:02:01.000Z"),
        ]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let texts: Vec<&str> = parsed.messages.iter().map(|m| m.text.as_str()).collect();
        let seqs: Vec<i64> = parsed.messages.iter().map(|m| m.seq).collect();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(texts, ["第一问", "第一答", "回退后的问", "回退后的答"]);
        assert_eq!(seqs, [1, 2, 3, 4]);
    }

    #[test]
    fn linear_and_bridged_chains_are_untouched() {
        // A plain linear session: nothing is dead.
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "问一", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "答一", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("a1"), None, "问二", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "答二", "2026-10-05T01:01:01.000Z"),
        ]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(parsed.messages.len(), 4);

        // A compact boundary: the first post-boundary message carries
        // parentUuid null + logicalParentUuid, and the walk must bridge it so
        // pre-compaction history stays visible (this reader shows the whole
        // root → active chain, unlike the CLI's context-only restore).
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "旧问", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "旧答", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", None, Some("a1"), "压缩后问", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "压缩后答", "2026-10-05T01:01:01.000Z"),
        ]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(parsed.messages.len(), 4);

        // A dangling parent means the layout is not understood — keep
        // everything rather than risk hiding reachable history.
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "问一", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "答一", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("ghost"), None, "幽灵父", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "答二", "2026-10-05T01:01:01.000Z"),
        ]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(parsed.messages.len(), 4);
    }

    #[test]
    fn scan_summary_follows_the_surviving_chain() {
        // The sidebar summary must describe the same surviving chain the
        // page shows: compare the rewound file against a file that contains
        // exactly the surviving messages.
        let (rewound_dir, rewound) = rewind_fixture(&[
            msg("user", "u1", None, None, "第一问", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "第一答", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("a1"), None, "被撤回的问", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "被撤回的答", "2026-10-05T01:01:01.000Z"),
            msg("user", "u3", Some("a1"), None, "回退后的问", "2026-10-05T01:02:00.000Z"),
            msg("assistant", "a3", Some("u3"), None, "回退后的答", "2026-10-05T01:02:01.000Z"),
        ]);
        let (clean_dir, clean) = rewind_fixture(&[
            msg("user", "u1", None, None, "第一问", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "第一答", "2026-10-05T01:00:01.000Z"),
            msg("user", "u3", Some("a1"), None, "回退后的问", "2026-10-05T01:02:00.000Z"),
            msg("assistant", "a3", Some("u3"), None, "回退后的答", "2026-10-05T01:02:01.000Z"),
        ]);
        let rewound_summary = scan_summary_file("claude", &rewound).unwrap();
        let clean_summary = scan_summary_file("claude", &clean).unwrap();
        let _ = std::fs::remove_dir_all(&rewound_dir);
        let _ = std::fs::remove_dir_all(&clean_dir);
        assert_eq!(rewound_summary.title, clean_summary.title);
        assert_eq!(rewound_summary.preview, clean_summary.preview);
        assert_eq!(rewound_summary.message_count, clean_summary.message_count);
        assert_eq!(rewound_summary.first_ts, clean_summary.first_ts);
    }

    #[test]
    fn segment_chain_rewind_hides_the_active_tail_but_keeps_archives() {
        // The CLI restarts every segment from a null parent: seg-1 is a root
        // archive, the active segment opens with a compact boundary whose
        // logicalParentUuid bridges back into seg-1. A rewind inside the
        // active segment must hide only the withdrawn tail — the archive
        // history and the boundary + summary chain stay.
        let root = [
            msg("user", "u1", None, None, "旧问一", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "旧答一", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("a1"), None, "旧问二", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "旧答二", "2026-10-05T01:01:01.000Z"),
        ];
        let active = [
            boundary("b1", Some("a2"), None),
            msg("user", "s1", Some("b1"), None, "（压缩摘要）", "2026-10-05T01:02:00.000Z"),
            msg("user", "u3", Some("s1"), None, "压缩后问", "2026-10-05T01:02:01.000Z"),
            msg("assistant", "a3", Some("u3"), None, "压缩后答", "2026-10-05T01:02:02.000Z"),
            msg("user", "u4", Some("a3"), None, "被撤回的问", "2026-10-05T01:03:00.000Z"),
            msg("assistant", "a4", Some("u4"), None, "被撤回的答", "2026-10-05T01:03:01.000Z"),
            msg("user", "u5", Some("a3"), None, "回退后的问", "2026-10-05T01:04:00.000Z"),
            msg("assistant", "a5", Some("u5"), None, "回退后的答", "2026-10-05T01:04:01.000Z"),
        ];
        let (dir, active_path) = segmented_fixture(&root, &active);
        let parsed = parse_session_file("claude", &active_path).unwrap();
        let texts = page_texts(&parsed);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            texts,
            [
                "旧问一", "旧答一", "旧问二", "旧答二", "（压缩摘要）", "压缩后问", "压缩后答",
                "回退后的问", "回退后的答"
            ]
        );
    }

    #[test]
    fn preserved_compact_slice_and_summary_survive_a_rewind() {
        // Suffix-preserving compaction (reactive): the boundary keeps the
        // recent slice, whose entries hold their pre-compact parentUuid on
        // disk (u3 points back into seg-1), while the summary anchors the
        // post-boundary chain. The in-memory relink must reconnect both
        // before any walk, or the surviving chain orphans the slice and the
        // summary. A later rewind then hides only what it withdrew.
        let root = [
            msg("user", "u1", None, None, "旧问一", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "旧答一", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("a1"), None, "旧问二", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "旧答二", "2026-10-05T01:01:01.000Z"),
        ];
        let active = [
            boundary("b1", Some("a2"), Some(("u3", "s1", "a4"))),
            msg("user", "s1", Some("b1"), None, "（压缩摘要）", "2026-10-05T01:02:00.000Z"),
            msg("user", "u3", Some("a2"), None, "保留问一", "2026-10-05T01:02:01.000Z"),
            msg("assistant", "a3", Some("u3"), None, "保留答一", "2026-10-05T01:02:02.000Z"),
            msg("user", "u4", Some("a3"), None, "保留问二", "2026-10-05T01:03:00.000Z"),
            msg("assistant", "a4", Some("u4"), None, "保留答二", "2026-10-05T01:03:01.000Z"),
            msg("user", "u5", Some("a4"), None, "被撤回的问", "2026-10-05T01:03:02.000Z"),
            msg("assistant", "a5", Some("u5"), None, "被撤回的答", "2026-10-05T01:03:03.000Z"),
            msg("user", "u6", Some("a4"), None, "回退后的问", "2026-10-05T01:04:00.000Z"),
            msg("assistant", "a6", Some("u6"), None, "回退后的答", "2026-10-05T01:04:01.000Z"),
        ];
        let expected = [
            "旧问一", "旧答一", "旧问二", "旧答二", "（压缩摘要）", "保留问一", "保留答一",
            "保留问二", "保留答二", "回退后的问", "回退后的答",
        ];
        let (dir, active_path) = segmented_fixture(&root, &active);
        let parsed = parse_session_file("claude", &active_path).unwrap();
        let texts = page_texts(&parsed);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(texts, expected);
        // The kept slice is re-linked into the active chain, so the CLI can
        // still resume at it; the archived root history cannot.
        assert_eq!(
            parsed
                .messages
                .iter()
                .find(|m| m.text == "保留问一")
                .map(|m| m.archived),
            Some(false)
        );
        assert_eq!(
            parsed
                .messages
                .iter()
                .find(|m| m.text == "旧问一")
                .map(|m| m.archived),
            Some(true)
        );

        // The same shape when the rewind points at the summary: the new chain
        // hangs off the anchor, and its entries must splice after the slice's
        // tail — the withdrawn turn still stays hidden.
        let active = [
            boundary("b1", Some("a2"), Some(("u3", "s1", "a4"))),
            msg("user", "s1", Some("b1"), None, "（压缩摘要）", "2026-10-05T01:02:00.000Z"),
            msg("user", "u3", Some("a2"), None, "保留问一", "2026-10-05T01:02:01.000Z"),
            msg("assistant", "a3", Some("u3"), None, "保留答一", "2026-10-05T01:02:02.000Z"),
            msg("user", "u4", Some("a3"), None, "保留问二", "2026-10-05T01:03:00.000Z"),
            msg("assistant", "a4", Some("u4"), None, "保留答二", "2026-10-05T01:03:01.000Z"),
            msg("user", "u5", Some("a4"), None, "被撤回的问", "2026-10-05T01:03:02.000Z"),
            msg("assistant", "a5", Some("u5"), None, "被撤回的答", "2026-10-05T01:03:03.000Z"),
            msg("user", "u6", Some("s1"), None, "回退后的问", "2026-10-05T01:04:00.000Z"),
            msg("assistant", "a6", Some("u6"), None, "回退后的答", "2026-10-05T01:04:01.000Z"),
        ];
        let (dir, active_path) = segmented_fixture(&root, &active);
        let parsed = parse_session_file("claude", &active_path).unwrap();
        let texts = page_texts(&parsed);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(texts, expected);
    }

    #[test]
    fn prefix_preserved_compaction_does_not_loop_after_relink() {
        // A prefix-preserving boundary points its logicalParentUuid at the
        // kept slice's own tail (the CLI's partial compact), while the
        // slice's head keeps a pre-compact parent from seg-1. After the
        // splice the raw walk would loop (tail → … → head → boundary →
        // logical → tail) and give up, so a later rewind could not filter
        // anything; dropping the bridge on the patched view must keep it
        // working.
        let root = [
            msg("user", "x0", None, None, "更早问", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "x1", Some("x0"), None, "更早答", "2026-10-05T01:00:01.000Z"),
        ];
        let active = [
            boundary("b1", Some("a4"), Some(("u2", "b1", "a4"))),
            msg("user", "u2", Some("x1"), None, "保留问一", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "保留答一", "2026-10-05T01:01:01.000Z"),
            msg("user", "u3", Some("a2"), None, "保留问二", "2026-10-05T01:01:02.000Z"),
            msg("assistant", "a4", Some("u3"), None, "保留答二", "2026-10-05T01:01:03.000Z"),
            msg("user", "u5", Some("a4"), None, "被撤回的问", "2026-10-05T01:02:00.000Z"),
            msg("assistant", "a5", Some("u5"), None, "被撤回的答", "2026-10-05T01:02:01.000Z"),
            msg("user", "u6", Some("a4"), None, "回退后的问", "2026-10-05T01:03:00.000Z"),
            msg("assistant", "a6", Some("u6"), None, "回退后的答", "2026-10-05T01:03:01.000Z"),
        ];
        let (dir, active_path) = segmented_fixture(&root, &active);
        let parsed = parse_session_file("claude", &active_path).unwrap();
        let texts = page_texts(&parsed);
        let _ = std::fs::remove_dir_all(&dir);
        assert_eq!(
            texts,
            [
                "更早问", "更早答", "保留问一", "保留答一", "保留问二", "保留答二",
                "回退后的问", "回退后的答"
            ]
        );
    }

    #[test]
    fn parallel_tool_branches_stay_visible_and_rewound_turns_drop() {
        // A parallel tool turn writes one assistant entry per content block
        // (all sharing `message.id`) and each tool result parents to its own
        // block: the bare single-parent walk keeps only one branch. The
        // recovery pass must keep both blocks and both results — while a
        // rewound turn is still dropped.
        let block = |uuid: &str, parent: &str, text: &str, id: &str| {
            let mut value = msg(
                "assistant",
                uuid,
                Some(parent),
                None,
                text,
                "2026-10-05T01:00:01.000Z",
            );
            value["message"]["id"] = serde_json::json!(id);
            value
        };
        let tool_result = |uuid: &str, parent: &str| {
            let mut value = msg("user", uuid, Some(parent), None, "", "2026-10-05T01:00:02.000Z");
            value["message"]["content"] = serde_json::json!([
                {"type": "tool_result", "tool_use_id": "t", "content": "ok"}
            ]);
            value
        };
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "问一", "2026-10-05T01:00:00.000Z"),
            block("a1", "u1", "第一块", "msg_m1"),
            block("a2", "a1", "第二块", "msg_m1"),
            tool_result("r1", "a1"),
            tool_result("r2", "a2"),
            block("a3", "r1", "收尾", "msg_m2"),
        ]);
        let filter = super::dead_branch_uuids_for_chain(&[file.clone()]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let texts = page_texts(&parsed);
        let _ = std::fs::remove_dir_all(&dir);
        assert!(
            filter.dead[0].is_empty(),
            "parallel blocks are not dead: {:?}",
            filter.dead
        );
        assert_eq!(texts, ["问一", "第一块", "第二块", "收尾"]);

        // The rewound turn (its own blocks and results) must disappear.
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "问一", "2026-10-05T01:00:00.000Z"),
            block("a1", "u1", "第一块", "msg_m1"),
            block("a2", "a1", "第二块", "msg_m1"),
            tool_result("r1", "a1"),
            tool_result("r2", "a2"),
            msg("user", "u2", Some("r1"), None, "被撤回的问", "2026-10-05T01:01:00.000Z"),
            block("a4", "u2", "被撤回的答", "msg_m2"),
            tool_result("r3", "a4"),
            msg("user", "u3", Some("r1"), None, "回退后的问", "2026-10-05T01:02:00.000Z"),
            block("a5", "u3", "回退后的答", "msg_m3"),
        ]);
        let filter = super::dead_branch_uuids_for_chain(&[file.clone()]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let texts = page_texts(&parsed);
        let _ = std::fs::remove_dir_all(&dir);
        let mut expected: Vec<String> = ["u2", "a4", "r3"].iter().map(|s| s.to_string()).collect();
        let mut found: Vec<String> = filter.dead[0].iter().cloned().collect();
        expected.sort();
        found.sort();
        assert_eq!(found, expected);
        assert_eq!(texts, ["问一", "第一块", "第二块", "回退后的问", "回退后的答"]);
    }

    #[test]
    fn an_unanswered_tail_prompt_is_not_rewindable() {
        // A turn that failed before producing anything leaves its prompt as
        // the chain's tail with no reply. The CLI's resume walk does not
        // reach it (`--resume-session-at` reports 未找到 message.uuid), so it
        // must carry no rewind entry — offering one wedges every retry: the
        // rejected send keeps its anchor and fails again forever.
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "问一", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "答一", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("a1"), None, "失败后残留的问", "2026-10-05T01:00:02.000Z"),
        ]);
        let filter = super::dead_branch_uuids_for_chain(&[file.clone()]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let rewindable = filter.rewindable.expect("walk understood");
        assert!(rewindable.contains("u1"), "a replied prompt stays rewindable");
        assert!(rewindable.contains("a1"), "the reply stays rewindable");
        assert!(
            !rewindable.contains("u2"),
            "the unanswered tail prompt must not be rewindable: {rewindable:?}"
        );
        // The page keeps showing the lingering prompt (it is not dead
        // history), but its rewind entry is withdrawn.
        let archived: Vec<(&str, bool)> = parsed
            .messages
            .iter()
            .filter(|m| m.role != "__usage__")
            .map(|m| (m.text.as_str(), m.archived))
            .collect();
        assert_eq!(
            archived,
            [("问一", false), ("答一", false), ("失败后残留的问", true)]
        );
        let texts = page_texts(&parsed);
        assert_eq!(texts, ["问一", "答一", "失败后残留的问"]);
    }

    #[test]
    fn compaction_boundary_rows_are_not_rewindable() {
        // The page shows pre-boundary history (the logicalParentUuid bridge),
        // but the CLI's resume walk follows parentUuid only: those rows keep
        // no rewind entry while everything from the boundary on does.
        let (dir, file) = rewind_fixture(&[
            msg("user", "u1", None, None, "旧问", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "旧答", "2026-10-05T01:00:01.000Z"),
            boundary("b1", Some("a1"), None),
            msg("user", "s1", Some("b1"), None, "（压缩摘要）", "2026-10-05T01:01:00.000Z"),
            msg("user", "u2", Some("s1"), None, "压缩后问", "2026-10-05T01:01:01.000Z"),
            msg("assistant", "a2", Some("u2"), None, "压缩后答", "2026-10-05T01:01:02.000Z"),
        ]);
        let parsed = parse_session_file("claude", &file).unwrap();
        let _ = std::fs::remove_dir_all(&dir);
        let archived: Vec<(&str, bool)> = parsed
            .messages
            .iter()
            .filter(|m| m.role != "__usage__")
            .map(|m| (m.text.as_str(), m.archived))
            .collect();
        assert_eq!(
            archived,
            [
                ("旧问", true),
                ("旧答", true),
                ("（压缩摘要）", false),
                ("压缩后问", false),
                ("压缩后答", false),
            ]
        );
    }

    #[test]
    fn same_uuid_alive_in_one_segment_survives_another_segments_verdict() {
        // Identical uuids across segments cannot occur in the CLI's own
        // writes, but the per-file verdicts must still keep a uuid that is
        // dead in one segment when another segment carries it alive.
        let root = [
            msg("user", "u1", None, None, "旧问", "2026-10-05T01:00:00.000Z"),
            msg("assistant", "a1", Some("u1"), None, "旧答", "2026-10-05T01:00:01.000Z"),
            msg("user", "u2", Some("a1"), None, "重复问", "2026-10-05T01:00:02.000Z"),
            msg("assistant", "a2", Some("u2"), None, "重复答", "2026-10-05T01:00:03.000Z"),
            msg("user", "u4", Some("a1"), None, "重发问", "2026-10-05T01:01:00.000Z"),
            msg("assistant", "a4", Some("u4"), None, "重发答", "2026-10-05T01:01:01.000Z"),
        ];
        // Inside seg-1 the rewind abandoned u2/a2 (u4/a4 re-rooted at a1).
        let active = [
            boundary("b1", None, None),
            msg("user", "u2", Some("b1"), None, "重复问", "2026-10-05T01:02:00.000Z"),
            msg("assistant", "a2", Some("u2"), None, "重复答", "2026-10-05T01:02:01.000Z"),
            msg("user", "u5", Some("a2"), None, "压缩后问", "2026-10-05T01:02:02.000Z"),
            msg("assistant", "a5", Some("u5"), None, "压缩后答", "2026-10-05T01:02:03.000Z"),
        ];
        let (dir, active_path) = segmented_fixture(&root, &active);
        let parsed = parse_session_file("claude", &active_path).unwrap();
        let texts = page_texts(&parsed);
        let _ = std::fs::remove_dir_all(&dir);
        // seg-1's u2/a2 rows are hidden, the alive copies in the active file
        // stay: each text appears exactly once.
        assert_eq!(texts.iter().filter(|text| **text == "重复问").count(), 1);
        assert_eq!(texts.iter().filter(|text| **text == "重复答").count(), 1);
        assert!(texts.contains(&"重发问"));
        assert!(texts.contains(&"压缩后问"));
    }
}
