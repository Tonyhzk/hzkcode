import type { Message } from "@/lib/ipc";

export type ProcessItem = {
  type: "tool" | "thinking";
  text: string;
  live?: boolean;
  /** Target file of the tool call; renders as a file-type chip. */
  path?: string | null;
  /** Tool-call arguments (object / array / string); expandable in the timeline. */
  args?: unknown;
  /** Tool-call execution result/output. */
  result?: unknown;
};

export type TimelineRow =
  | { kind: "msg"; message: Message; turnFinal: boolean }
  | { kind: "process"; items: ProcessItem[]; firstSeq: number };

/** Letters, digits, or emoji make a segment real content. Harnesses emit
 * bare placeholder segments ("·", ".") between tool batches; rendered as a
 * bubble they read as an empty box with a lone dot, and each one splits what
 * should be a single folded tool run into alternating chips. */
const CONTENT_RE = /[\p{L}\p{N}\p{Extended_Pictographic}]/u;

function isPlaceholderMessage(message: Message): boolean {
  return message.role === "assistant" && !CONTENT_RE.test(message.text);
}

/** Row wrapper caches keyed by message reference. The store grows rows
 * immutably (spread-copy on change), so a message whose reference survived a
 * stream flush reuses its wrapper and memoized row views skip it entirely.
 * WeakMaps keep no message alive beyond the session state that holds it. */
type MsgRow = Extract<TimelineRow, { kind: "msg" }>;
const msgRowCache = new WeakMap<Message, { final?: MsgRow; plain?: MsgRow }>();
const processItemCache = new WeakMap<Message, ProcessItem>();
const processRowCache = new WeakMap<
  Message,
  { items: ProcessItem[]; row: Extract<TimelineRow, { kind: "process" }> }
>();

function getMsgRow(message: Message, turnFinal: boolean): MsgRow {
  let slots = msgRowCache.get(message);
  if (!slots) {
    slots = {};
    msgRowCache.set(message, slots);
  }
  const cached = turnFinal ? slots.final : slots.plain;
  if (cached) return cached;
  const row: MsgRow = { kind: "msg", message, turnFinal };
  if (turnFinal) slots.final = row;
  else slots.plain = row;
  return row;
}

function getProcessItem(message: Message): ProcessItem {
  let item = processItemCache.get(message);
  if (!item) {
    item = {
      type: message.role === "tool" ? "tool" : "thinking",
      text: message.text,
      live: message.live,
      path: message.path,
      args: message.args,
      result: message.result,
    };
    processItemCache.set(message, item);
  }
  return item;
}

function getProcessRow(first: Message, items: ProcessItem[]): TimelineRow {
  const cached = processRowCache.get(first);
  // Items only ever append (or swap identity wholesale on settle), so an
  // element-wise reference check is a cheap, exact staleness test.
  if (
    cached &&
    cached.items.length === items.length &&
    cached.items.every((item, i) => item === items[i])
  ) {
    return cached.row;
  }
  const row: TimelineRow = { kind: "process", items, firstSeq: first.seq };
  processRowCache.set(first, { items, row });
  return row;
}

/** Fold runs of consecutive tool / thinking messages into single process
 * rows, preserving order — between two chat bubbles there is at most one
 * collapsed chip, never an alternating stack. Row objects are cached per
 * message reference, so rows unaffected by a flush keep their identity and
 * React.memo bails out on them. */
export function buildRows(messages: Message[]): TimelineRow[] {
  const rows: TimelineRow[] = [];
  let i = 0;
  while (i < messages.length) {
    const message = messages[i];
    if (isPlaceholderMessage(message)) {
      i++;
      continue;
    }
    if (message.role === "tool" || message.role === "thinking") {
      const first = message;
      const items: ProcessItem[] = [];
      while (i < messages.length) {
        const step = messages[i];
        if (step.role === "tool" || step.role === "thinking") {
          items.push(getProcessItem(step));
        } else if (!isPlaceholderMessage(step)) {
          break;
        }
        i++;
      }
      rows.push(getProcessRow(first, items));
    } else {
      rows.push(getMsgRow(message, false));
      i++;
    }
  }
  // Footer (copy + meta) renders only on a reply's final assistant segment:
  // walk backwards, resetting at each user message. turnFinal variants are
  // cached too — a flip swaps in the other cached wrapper, no mutation.
  let seenAssistant = false;
  for (let j = rows.length - 1; j >= 0; j--) {
    const row = rows[j];
    if (row.kind !== "msg") continue;
    if (row.message.role === "user") {
      seenAssistant = false;
    } else if (row.message.role === "notice") {
      // CLI notice rows are not reply segments: they take no footer and do
      // not split the reply's own final-segment scan.
      continue;
    } else {
      const turnFinal = !seenAssistant;
      seenAssistant = true;
      if (row.turnFinal !== turnFinal) rows[j] = getMsgRow(row.message, turnFinal);
    }
  }
  return rows;
}

export function rowKey(row: TimelineRow): string | number {
  return row.kind === "msg" ? row.message.seq : `process-${row.firstSeq}`;
}

/** Branch target uuid per message row (the CLI's /branch semantics): every
 *  message targets its own transcript entry — the backend forks inclusively
 *  of a reply and right before a prompt, so branching at a prompt ends the
 *  fork on the reply it follows. Rows without a resolvable entry (a
 *  just-sent prompt echoes locally and only gains its uuid once the session
 *  is re-read) are absent — the branch icon hides for them. The session's
 *  first prompt takes part like any other; its target is its own entry too,
 *  mirroring the CLI, which allows a designated target to produce an empty
 *  fork. */
export function branchTargets(rows: TimelineRow[]): Map<string | number, string> {
  const targets = new Map<string | number, string>();
  for (const row of rows) {
    if (row.kind !== "msg") continue;
    const uuid = row.message.uuid;
    if (!uuid) continue;
    const role = row.message.role;
    if (role !== "assistant" && role !== "user") continue;
    targets.set(rowKey(row), uuid);
  }
  return targets;
}

export function toolEntranceKey(processId: number, index: number): string {
  return `${processId}:${index}`;
}

export function collectToolKeys(rows: TimelineRow[]): string[] {
  const keys: string[] = [];
  for (const row of rows) {
    if (row.kind !== "process") continue;
    row.items.forEach((item, index) => {
      if (item.type === "tool") keys.push(toolEntranceKey(row.firstSeq, index));
    });
  }
  return keys;
}

export function markToolKeys(seen: Set<string>, processId: number, items: ProcessItem[]) {
  items.forEach((item, index) => {
    if (item.type === "tool") seen.add(toolEntranceKey(processId, index));
  });
}
