import { lazy, memo, Suspense, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { useTranslation } from "react-i18next";
import Copy from "lucide-react/dist/esm/icons/copy";
import Check from "lucide-react/dist/esm/icons/check";
import Pencil from "lucide-react/dist/esm/icons/pencil";
import RotateCcw from "lucide-react/dist/esm/icons/rotate-ccw";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import Undo2 from "lucide-react/dist/esm/icons/undo-2";
import Trash2 from "lucide-react/dist/esm/icons/trash-2";
import AlertCircle from "lucide-react/dist/esm/icons/alert-circle";
import AlertTriangle from "lucide-react/dist/esm/icons/alert-triangle";
import Info from "lucide-react/dist/esm/icons/info";
import type { Message } from "@/lib/ipc";

import type { SessionState } from "../store";
import { useChatStore } from "../store";
import { parseUsage } from "../usage";
import { formatTokens } from "@/utils/format-tokens";
import { cx } from "@/utils/cx";
import { AgentThinking } from "@/components/application/agent-thinking/agent-thinking";
import { streamParseInterval, useThrottled } from "@/hooks/use-throttled";
import { useCopied } from "@/hooks/use-copied";
import { MessageImages } from "./MessageImages";
import { GrantCard } from "./GrantCard";
import { QuestionRecord } from "./QuestionCard";
import { PermissionRecord } from "./PermissionCard";
import { MESSAGE_ANCHOR_RAIL_BAND_CLASS, MessageAnchorRail } from "./MessageAnchorRail";
import { createAnchorRowsBuilder } from "./timeline-anchors";
import { branchTargets, buildRows, collectToolKeys, rowKey, type TimelineRow } from "./timeline-rows";
import { formatDuration } from "./format-duration";
import { ProcessDisclosure } from "./ProcessDisclosure";
import { CollapsibleMessage } from "./CollapsibleMessage";
import { useScrollFollow, useTailPin } from "./use-scroll-follow";
import { ScrollToBottomButton } from "./ScrollToBottomButton";
import { pluginIdFromRegistryKey, timelineRowRegistry, useRegistry } from "@hzkcode/plugin-sdk";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
import { useAnchorRailScroll } from "./use-anchor-rail-scroll";
import { useLoadEarlier } from "./use-load-earlier";
import { stripAgentBlock } from "./agent-block";

const TimelineRowView = memo(function TimelineRowView({
  row,
  workspacePath,
  turnLive,
  autoExpand,
  thinkingAutoCollapse,
  detailedDisplay,
  seenTools,
  onRetry,
  branchTarget,
  onBranch,
  onRewind,
  onEdit,
  onDelete,
}: {
  row: TimelineRow;
  workspacePath: string;
  /** True while the current turn is still streaming; suppresses the footer. */
  turnLive: boolean;
  /** True on the timeline's last process row: it rides open until a newer
   * one appears, and stays open once the turn settles. */
  autoExpand: boolean;
  /** False keeps a settled thinking row expanded (设置 → 通用 → 行为). */
  thinkingAutoCollapse: boolean;
  /** True (设置 → 通用 → 行为 → 详细显示): every process row rides open and
   *  tool calls print their arguments and results inline. */
  detailedDisplay: boolean;
  seenTools: Set<string>;
  /** Wired on the bottom-most chat message only (see MessageTimeline). */
  onRetry?: () => void;
  branchTarget?: string;
  onBranch?: (targetUuid: string) => void;
  onRewind?: (target: { uuid: string; role: "user" | "assistant" }) => void;
  onEdit?: (target: { uuid: string; text: string; tail?: string }) => void;
  /** Delete affordance: the row's own transcript uuid (the entry is removed
   *  from the active segment; later messages reconnect). Hidden for rows
   *  read from archived segments — the write only covers the active file. */
  onDelete?: (targetUuid: string) => void;
}) {
  // Plugin-defined row kinds (plan §4.2 #5) dispatch to the registered
  // renderer before the builtin switch below; builtin kinds never hit this
  // unless a plugin deliberately shadows one.
  const customRenderers = useRegistry(timelineRowRegistry);
  const custom = customRenderers.find((r) => r.kind === row.kind);
  if (custom) {
    const pluginId = pluginIdFromRegistryKey(custom.id);
    const Renderer = custom.component;
    return (
      <PluginBoundary pluginId={pluginId}>
        <Renderer row={row} />
      </PluginBoundary>
    );
  }
  // Every process run — thinking, tools, or both — folds into the same
  // collapsed summary line ("思考 N 次 工具调用 M 次 >"); expanding shows
  // the per-step details.
  if (row.kind === "process") {
    return (
      <ProcessDisclosure
        items={row.items}
        autoExpand={autoExpand}
        turnLive={turnLive}
        thinkingAutoCollapse={thinkingAutoCollapse}
        detailedDisplay={detailedDisplay}
        processId={row.firstSeq}
        seenTools={seenTools}
      />
    );
  }
  return (
    <MessageRow
      message={row.message}
      workspacePath={workspacePath}
      turnFinal={row.turnFinal && !turnLive}
      onRetry={onRetry}
      branchTarget={branchTarget}
      onBranch={onBranch}
      onRewind={onRewind}
      onEdit={onEdit}
      onDelete={onDelete}
    />
  );
});

const LazyMarkdown = lazy(() => import("./Markdown"));

/** Markdown body; the react-markdown/highlight stack loads in a lazy chunk. */
function Markdown({ text, workspacePath, streaming }: {
  text: string;
  workspacePath: string;
  streaming?: boolean;
}) {
  return (
    <Suspense
      fallback={
        <div className="prose-chat text-body-regular whitespace-pre-wrap text-text-primary">
          {text}
        </div>
      }
    >
      <LazyMarkdown text={text} workspacePath={workspacePath} streaming={streaming} />
    </Suspense>
  );
}

/** Format a message timestamp: HH:mm today, MM-dd HH:mm this year, full date
 * beyond. ts is RFC3339 (claude/pi) or epoch millis as a string (kimi/dsh). */
function formatMessageTime(ts: string | null | undefined): string | null {
  if (!ts) return null;
  const ms = /^\d+$/.test(ts) ? Number(ts) : Date.parse(ts);
  if (!Number.isFinite(ms)) return null;
  const d = new Date(ms);
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (d.toDateString() === now.toDateString()) return hm;
  if (d.getFullYear() === now.getFullYear())
    return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${hm}`;
}

/** Compact token usage for one message: "↑3.2k ↓412". Input is the whole
 *  prompt side — fresh tokens plus cache reads/writes — so a cache-heavy turn
 *  does not read as if it had sent almost nothing. */
function formatUsage(usage: unknown): string | null {
  const u = parseUsage(usage);
  if (!u) return null;
  const input = u.input + u.cacheRead + u.cacheWrite;
  if (!input && !u.output) return null;
  const parts: string[] = [];
  if (input) parts.push(`↑${formatTokens(input)}`);
  if (u.output) parts.push(`↓${formatTokens(u.output)}`);
  return parts.join(" ");
}

/** Passive per-message facts, revealed on message hover: time · duration · token usage · model · effort. */
function MessageMeta({ message }: { message: Message }) {
  const { t } = useTranslation();
  const effortText = useMemo(() => {
    if (!message.effort) return null;
    const key = `chat.effort${message.effort.charAt(0).toUpperCase() + message.effort.slice(1).toLowerCase()}`;
    const translated = t(key);
    const effortVal = translated && translated !== key ? translated : message.effort;
    return t("chat.metaEffort", { effort: effortVal });
  }, [message.effort, t]);

  const durationFormatted = useMemo(() => {
    const d = formatDuration(message.durationMs);
    return d ? t("chat.metaDuration", { duration: d }) : null;
  }, [message.durationMs, t]);

  const modelFormatted = useMemo(() => {
    return message.model ? t("chat.metaModel", { model: message.model }) : null;
  }, [message.model, t]);

  const parts = [
    formatMessageTime(message.ts),
    durationFormatted,
    formatUsage(message.usage),
    modelFormatted,
    effortText,
  ].filter((p): p is string => Boolean(p));
  if (parts.length === 0) return null;
  return (
    <span className="text-caption-1-regular tabular-nums text-text-tertiary opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      {parts.join(" · ")}
    </span>
  );
}

/** Assistant message hover actions (copy + retry + rewind + branch). The
 *  retry affordance is wired only on the timeline's last message (the
 *  terminal's `//`); rewind and branch ride any message that resolves to a
 *  transcript entry. */
function MessageActions({
  text,
  onRetry,
  branchTarget,
  onBranch,
  onRewind,
  onDelete,
}: {
  text: string;
  onRetry?: () => void;
  branchTarget?: string;
  onBranch?: (targetUuid: string) => void;
  onRewind?: (targetUuid: string) => void;
  onDelete?: () => void;
}) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();
  const iconBtn =
    "flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-icon-secondary transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-primary";
  return (
    <div className="flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
      <button
        type="button"
        aria-label={t("chat.copy")}
        onClick={() => copy(text)}
        className={iconBtn}
      >
        {copied ? (
          <Check className="size-3.5 text-lime-500" aria-hidden />
        ) : (
          <Copy className="size-3.5" aria-hidden />
        )}
      </button>
      {onRetry && (
        <button
          type="button"
          aria-label={t("chat.retry")}
          title={t("chat.retry")}
          onClick={onRetry}
          className={iconBtn}
        >
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
      )}
      {branchTarget && onRewind && (
        <button
          type="button"
          aria-label={t("chat.rewind")}
          title={t("chat.rewind")}
          onClick={() => onRewind(branchTarget)}
          className={iconBtn}
        >
          <Undo2 className="size-3.5" aria-hidden />
        </button>
      )}
      {branchTarget && onBranch && (
        <button
          type="button"
          aria-label={t("chat.branch")}
          title={t("chat.branch")}
          onClick={() => onBranch(branchTarget)}
          className={iconBtn}
        >
          <GitBranch className="size-3.5" aria-hidden />
        </button>
      )}
      {branchTarget && onDelete && (
        <button
          type="button"
          aria-label={t("chat.delete")}
          title={t("chat.delete")}
          onClick={onDelete}
          className={iconBtn}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** Copy affordance for a user bubble: icon only, no chrome, in a footer row
 *  under the bubble's bottom-right corner. A side-slot button vertically
 *  centers against the bubble, so long messages push it far from the text
 *  it copies; a footer stays put regardless of bubble height. Mirrors the
 *  assistant row's hover-reveal so a settled conversation stays clean, and
 *  stays reachable by keyboard. */
function UserMessageCopy({
  text,
  onRetry,
  branchTarget,
  onBranch,
  onRewind,
  onEdit,
  onDelete,
}: {
  text: string;
  onRetry?: () => void;
  branchTarget?: string;
  onBranch?: (targetUuid: string) => void;
  onRewind?: (targetUuid: string) => void;
  onEdit?: (targetUuid: string) => void;
  onDelete?: (targetUuid: string) => void;
}) {
  const { t } = useTranslation();
  const { copied, copy } = useCopied();
  const iconBtn =
    "flex size-6 cursor-pointer items-center justify-center rounded-md bg-transparent text-foreground-icon-secondary opacity-0 transition-opacity duration-150 group-hover:opacity-100 focus-visible:opacity-100 hover:bg-background-tertiary-hover hover:text-foreground-icon-primary";
  const canBranch = Boolean(branchTarget && onBranch);
  const canRewind = Boolean(branchTarget && onRewind);
  const canEdit = Boolean(branchTarget && onEdit);
  const canDelete = Boolean(branchTarget && onDelete);
  if (!text.trim() && !onRetry && !canBranch && !canRewind && !canEdit && !canDelete)
    return null;
  return (
    <div className="flex items-center gap-0.5">
      {text.trim() && (
        <button
          type="button"
          aria-label={t("chat.copy")}
          title={t("chat.copy")}
          onClick={() => copy(text)}
          className={iconBtn}
        >
          {copied ? (
            <Check className="size-3.5 text-lime-500" aria-hidden />
          ) : (
            <Copy className="size-3.5" aria-hidden />
          )}
        </button>
      )}
      {canEdit && (
        <button
          type="button"
          aria-label={t("chat.edit")}
          title={t("chat.edit")}
          onClick={() => onEdit!(branchTarget!)}
          className={iconBtn}
        >
          <Pencil className="size-3.5" aria-hidden />
        </button>
      )}
      {onRetry && (
        <button
          type="button"
          aria-label={t("chat.retry")}
          title={t("chat.retry")}
          onClick={onRetry}
          className={iconBtn}
        >
          <RotateCcw className="size-3.5" aria-hidden />
        </button>
      )}
      {canRewind && (
        <button
          type="button"
          aria-label={t("chat.rewind")}
          title={t("chat.rewind")}
          onClick={() => onRewind!(branchTarget!)}
          className={iconBtn}
        >
          <Undo2 className="size-3.5" aria-hidden />
        </button>
      )}
      {canBranch && (
        <button
          type="button"
          aria-label={t("chat.branch")}
          title={t("chat.branch")}
          onClick={() => onBranch!(branchTarget!)}
          className={iconBtn}
        >
          <GitBranch className="size-3.5" aria-hidden />
        </button>
      )}
      {canDelete && (
        <button
          type="button"
          aria-label={t("chat.delete")}
          title={t("chat.delete")}
          onClick={() => onDelete!(branchTarget!)}
          className={iconBtn}
        >
          <Trash2 className="size-3.5" aria-hidden />
        </button>
      )}
    </div>
  );
}

/** User bubble. The agent block sendPrompt appended stays in history (the
 *  CLI transcript owns it), but the bubble strips it and carries the agent
 *  identity as a small badge above, mirroring the meta row's caption type. */
function UserMessageRow({
  message,
  onRetry,
  branchTarget,
  onBranch,
  onRewind,
  onEdit,
  onDelete,
}: {
  message: Message;
  onRetry?: () => void;
  branchTarget?: string;
  onBranch?: (targetUuid: string) => void;
  onRewind?: (targetUuid: string) => void;
  onEdit?: (target: { uuid: string; text: string; tail?: string }) => void;
  onDelete?: (targetUuid: string) => void;
}) {
  const { t } = useTranslation();
  const stripped = useMemo(() => stripAgentBlock(message.text), [message.text]);
  return (
    <div className="group -mr-1.5 ml-auto flex w-fit max-w-[85%] flex-col items-end">
      {stripped.agentName && (
        <span
          aria-label={t("chat.agentBadge", { name: stripped.agentName })}
          className="mb-1 flex items-center gap-1 text-caption-1-regular text-text-tertiary"
        >
          {stripped.agentIcon && <span aria-hidden>{stripped.agentIcon}</span>}
          {stripped.agentName}
        </span>
      )}
      <div
        className="flex flex-col rounded-xl bg-bubble-user px-3.5 py-2.5 text-left text-body-regular whitespace-pre-wrap break-words text-text-white"
        data-selectable
      >
        <CollapsibleMessage>
          {message.images && message.images.length > 0 && (
            <MessageImages images={message.images} />
          )}
          {stripped.text}
        </CollapsibleMessage>
      </div>
      <UserMessageCopy
        text={stripped.text}
        onRetry={onRetry}
        branchTarget={branchTarget}
        onBranch={onBranch}
        onRewind={onRewind}
        onEdit={
          onEdit
            ? (uuid) => onEdit({ uuid, text: stripped.text, tail: stripped.tail })
            : undefined
        }
        onDelete={onDelete}
      />
    </div>
  );
}

/** A CLI system notice (role "notice"): the line the terminal prints inline —
 *  second-brain advice and call failures, personal-memory notes, model
 *  fallback. Kept in the timeline as a quiet row: no bubble, no markdown,
 *  severity-tinted icon and text. */
const NoticeRow = memo(function NoticeRow({ message }: { message: Message }) {
  const level = message.level ?? "info";
  const tone =
    level === "error"
      ? "text-text-error-primary"
      : level === "warning"
        ? "text-text-warning-primary"
        : "text-text-tertiary";
  const Icon = level === "error" ? AlertCircle : level === "warning" ? AlertTriangle : Info;
  return (
    <div className="flex items-start gap-1.5 text-body-2-regular">
      <Icon className={cx("mt-[3px] size-3.5 shrink-0", tone)} aria-hidden />
      <span className={cx("whitespace-pre-wrap break-words", tone)} data-selectable>
        {message.text}
      </span>
    </div>
  );
});

export const MessageRow = memo(function MessageRow({
  message,
  workspacePath,
  turnFinal,
  onRetry,
  branchTarget,
  onBranch,
  onRewind,
  onEdit,
  onDelete,
}: {
  message: Message;
  workspacePath: string;
  turnFinal: boolean;
  /** Retry affordance (the terminal's `//`): wired on the timeline's last
   *  message only, so a mid-history bubble never shows it. */
  onRetry?: () => void;
  /** Branch affordance (the CLI's /branch): the row's own transcript uuid —
   *  the fork includes the row itself (a reply, or the prompt). Absent when
   *  the row cannot resolve one. */
  branchTarget?: string;
  onBranch?: (targetUuid: string) => void;
  /** Rewind affordance (回退): the row's own transcript uuid plus its role —
   *  the dialog decides between rewinding the conversation and/or the
   *  workspace files. Shown on every row that resolves a uuid, except rows
   *  read from an archived (pre-compaction) segment: the CLI's
   *  `--resume-session-at` cannot resolve those. */
  onRewind?: (target: { uuid: string; role: "user" | "assistant" }) => void;
  /** Edit affordance (the CLI's --edit-message): the row's own transcript
   *  uuid, the visible body and any hidden legacy tail block to keep. User
   *  rows only — the engine edits nothing else. */
  onEdit?: (target: { uuid: string; text: string; tail?: string }) => void;
  /** Delete affordance: the row's own transcript uuid. User and assistant
   *  rows only, and never for archived (pre-compaction) segments — the
   *  rewrite covers the active file alone. */
  onDelete?: (targetUuid: string) => void;
}) {
  // A live row's text grows per store flush; a full markdown reparse per
  // flush scales linearly with reply length (~30ms at 32KB) and starves the
  // main thread, so the parse is throttled. Settled rows never change and
  // render as-is.
  const text = useThrottled(message.text, message.live ? streamParseInterval(message.text.length) : 0);
  const { t } = useTranslation();
  if (message.role === "grant") {
    // Permission-denial card: actionable directory grant, not a chat bubble.
    return <GrantCard message={message} />;
  }
  if (message.role === "question") {
    // The interaction lives in the dock above the composer; the timeline
    // keeps only the placeholder / settled history row.
    return <QuestionRecord message={message} />;
  }
  if (message.role === "permission") {
    // Same treatment as a question: actionable in the dock, recorded here.
    return <PermissionRecord message={message} />;
  }
  if (message.role === "user") {
    return (
      <UserMessageRow
        message={message}
        onRetry={onRetry}
        branchTarget={branchTarget}
        onBranch={onBranch}
        onRewind={
          onRewind && !message.archived
            ? (uuid) => onRewind({ uuid, role: "user" })
            : undefined
        }
        onEdit={onEdit}
        onDelete={onDelete && !message.archived ? onDelete : undefined}
      />
    );
  }
  if (message.role === "notice") {
    return <NoticeRow message={message} />;
  }
  const rewindForRow =
    onRewind && !message.archived
      ? (uuid: string) => onRewind({ uuid, role: "assistant" })
      : undefined;
  const deleteForRow =
    onDelete && !message.archived && branchTarget
      ? () => onDelete(branchTarget)
      : undefined;
  return (
    <div className="group flex flex-col text-left">
      <Markdown text={text} workspacePath={workspacePath} streaming={message.live} />
      {turnFinal && (
        <div className="mt-1 flex items-center gap-2">
          <MessageActions
            text={message.text}
            onRetry={onRetry}
            branchTarget={branchTarget}
            onBranch={onBranch}
            onRewind={rewindForRow}
            onDelete={deleteForRow}
          />
          <MessageMeta message={message} />
        </div>
      )}
      {/* A mid-turn assistant segment keeps its own rewind entry (the row
          resolves its own transcript uuid); the copy/meta footer stays
          turn-final-only. Delete rides the same row-level affordances. */}
      {!turnFinal && branchTarget && (rewindForRow || deleteForRow) && (
        <div className="mt-1 flex items-center gap-0.5 opacity-0 transition-opacity duration-150 group-hover:opacity-100">
          {rewindForRow && (
            <button
              type="button"
              aria-label={t("chat.rewind")}
              title={t("chat.rewind")}
              onClick={() => rewindForRow(branchTarget)}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-icon-secondary transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-primary"
            >
              <Undo2 className="size-3.5" aria-hidden />
            </button>
          )}
          {deleteForRow && (
            <button
              type="button"
              aria-label={t("chat.delete")}
              title={t("chat.delete")}
              onClick={deleteForRow}
              className="flex size-6 cursor-pointer items-center justify-center rounded-md text-foreground-icon-secondary transition-colors hover:bg-background-tertiary-hover hover:text-foreground-icon-primary"
            >
              <Trash2 className="size-3.5" aria-hidden />
            </button>
          )}
        </div>
      )}
    </div>
  );
});

export const MessageTimeline = memo(function MessageTimeline({
  session,
  streaming,
  onLoadEarlier,
  workspacePath,
  onRetry,
  onBranch,
  onRewind,
  onEdit,
  onDelete,
}: {
  session: SessionState;
  streaming: boolean;
  onLoadEarlier: () => void;
  workspacePath: string;
  /** Repeat the last prompt (the terminal's `//`); rendered as a small icon
   *  next to the copy action on the bottom-most chat message. */
  onRetry?: () => void;
  /** Fork the conversation at one message (the CLI's /branch): the target is
   *  the transcript uuid the fork should end at. */
  onBranch?: (targetUuid: string) => void;
  /** 回退 (rewind) at one message: opens the choice between rewinding the
   *  conversation (the next send truncates to this message) and/or restoring
   *  the workspace files to the state at it. Shown on every row that
   *  resolves a transcript uuid. */
  onRewind?: (target: { uuid: string; role: "user" | "assistant" }) => void;
  /** Edit affordance (the CLI's --edit-message): the target carries the row's
   *  transcript uuid, its visible body and any hidden legacy tail to keep. */
  onEdit?: (target: { uuid: string; text: string; tail?: string }) => void;
  /** Delete affordance (删除): the target is the row's transcript uuid — the
   *  entry is removed from the active segment and later messages reconnect.
   *  Hidden on archived rows: the rewrite only covers the active file. */
  onDelete?: (targetUuid: string) => void;
}) {

  const { t } = useTranslation();
  const thinkingAutoCollapse = useChatStore((s) => s.thinkingAutoCollapse);
  const detailedDisplay = useChatStore((s) => s.detailedDisplay);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const items = session.messages;
  const rows = useMemo(() => buildRows(items), [items]);
  // Anchor rail: one dash per user message (reference: messageAnchors).
  const buildAnchorRows = useMemo(createAnchorRowsBuilder, []);
  const anchors = useMemo(() => buildAnchorRows(rows), [buildAnchorRows, rows]);
  // Per-timeline, not a module singleton: ChatConversation remounts this
  // with key={sessionKey}, so a tab switch gets a fresh set. Prime from
  // the first snapshot that already has rows so history / tab-open does
  // not replay height 0→auto. Do not lock an empty set — loading failure
  // and load-earlier both flip `session.loading`, and an empty new chat
  // must still animate the first live tools.
  const [seenTools] = useState(() => new Set<string>());
  const [primed, setPrimed] = useState(false);
  if (!primed && rows.length > 0) {
    for (const key of collectToolKeys(rows)) seenTools.add(key);
    setPrimed(true);
  }
  // Key of the last process row — the one that stays expanded by default.
  const lastProcessKey = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      if (rows[i].kind === "process") return rowKey(rows[i]);
    }
    return null;
  }, [rows]);
  // The bottom-most chat message (user or assistant) carries the retry icon.
  // Notice rows are not messages; process rows fold tool runs.
  const lastMessageKey = useMemo(() => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (
        row.kind === "msg" &&
        (row.message.role === "user" || row.message.role === "assistant")
      ) {
        return rowKey(row);
      }
    }
    return null;
  }, [rows]);
  // Branch target per message row (the CLI's /branch semantics); rows
  // without a resolvable transcript entry get no icon.
  const branchTargetByRow = useMemo(() => branchTargets(rows), [rows]);
  // Live stream rows are ordinary rows that grow in place; the only extra
  // tail item is the turn-status indicator below them.
  // The tail indicator stays mounted AND visible for the whole turn — a
  // constant status anchor below the growing rows. Hiding it while content
  // grew made every idle ↔ growing transition read as disconnect/reconnect:
  // the status line kept popping in and out at each tool call and pause.
  // The reply footer (copy + time + usage) only makes sense once the turn
  // settles: while streaming, mid-turn segments (kimi multi-message replies)
  // are not the final word.
  const turnLive = streaming;
  const count = rows.length + (streaming ? 1 : 0);

  const virtualizer = useVirtualizer({
    count,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 72,
    overscan: 8,
    getItemKey: (index) =>
      index < rows.length ? rowKey(rows[index]) : "streaming-tail",
  });

  const { atBottomRef, userPausedRef, isFollowing, scrollToBottom, resumeFollow } = useScrollFollow({ scrollRef });
  const { activeAnchorId, handleScrollToAnchor } = useAnchorRailScroll({
    scrollRef,
    anchors,
    virtualizer,
    rowCount: rows.length,
    atBottomRef,
    userPausedRef,
  });
  useTailPin({ scrollRef, count, items, streaming, isFollowing, scrollToBottom });
  useLoadEarlier({
    scrollRef,
    virtualizer,
    rows,
    itemCount: items.length,
    nextBefore: session.nextBefore,
    onLoadEarlier,
  });

  const activeModel = useMemo(() => {
    if (session.activeModel) return session.activeModel;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].model) return items[i].model;
    }
    return null;
  }, [session.activeModel, items]);

  const activeEffort = useMemo(() => {
    if (session.activeEffort) return session.activeEffort;
    for (let i = items.length - 1; i >= 0; i--) {
      if (items[i].effort) return items[i].effort;
    }
    return null;
  }, [session.activeEffort, items]);

  const activeModelFormatted = useMemo(() => {
    return activeModel ? t("chat.metaModel", { model: activeModel }) : null;
  }, [activeModel, t]);

  const activeEffortFormatted = useMemo(() => {
    if (!activeEffort) return null;
    const key = `chat.effort${activeEffort.charAt(0).toUpperCase() + activeEffort.slice(1).toLowerCase()}`;
    const translated = t(key);
    const effortVal = translated && translated !== key ? translated : activeEffort;
    return t("chat.metaEffort", { effort: effortVal });
  }, [activeEffort, t]);

  // Tokens the reply in flight has spent, in the same "↑in ↓out" shape the
  // settled rows use. `turnUsage` is the run's reports summed (omp per
  // message, codex token_count); engines that report only at the end have
  // nothing until they do. Nothing is estimated from streamed text, so the
  // number is always real.
  const liveUsage = useMemo(
    () => formatUsage(session.turnUsage ?? session.usage),
    [session.turnUsage, session.usage],
  );

  return (
    <div className="relative flex min-h-0 flex-1 flex-col">
      <MessageAnchorRail
        activeAnchorId={activeAnchorId}
        anchors={anchors}
        navigationLabel={t("chat.anchorNavigation")}
        getFallbackTitle={(index) => t("chat.anchorUserTitle", { index: index + 1 })}
        onScrollToAnchor={handleScrollToAnchor}
      />
      <ScrollToBottomButton scrollRef={scrollRef} contentSignal={count} onJump={resumeFollow} />
      {/* The rail is absolutely positioned, so its band must be reserved here or
          a narrow window slides the centered column under the dashes. Only when
          the rail actually renders (anchors present) — otherwise the padding
          would be lopsided for no reason. */}
      <div
        ref={scrollRef}
        className={cx(
          "min-h-0 flex-1 overflow-y-auto overflow-x-hidden px-4",
          anchors.length > 0 && MESSAGE_ANCHOR_RAIL_BAND_CLASS,
        )}
      >
        <div data-sentinel className="h-px" />
        {session.nextBefore && (
          <button
            type="button"
            onClick={onLoadEarlier}
            className="mx-auto my-2 block rounded-full bg-background-tertiary-default px-3 py-1 text-caption-1-medium text-text-secondary hover:bg-background-secondary-hover"
          >
            {t("chat.loadEarlier")}
          </button>
        )}
        <div
          data-virtual-inner
          style={{ height: virtualizer.getTotalSize(), position: "relative" }}
          className="mx-auto max-w-[750px]"
        >
          {virtualizer.getVirtualItems().map((item) => {
            const isTail = item.index >= rows.length;
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                style={{
                  position: "absolute",
                  top: 0,
                  left: 0,
                  width: "100%",
                  transform: `translateY(${item.start}px)`,
                }}
                className="py-2"
              >
                {isTail ? (
                  <AgentThinking
                    variant="wave"
                    label={t("chat.thinking")}
                    className="py-2"
                    startedAt={session.turnStartedAt ?? undefined}
                    durationFormatter={(d) => t("chat.metaDuration", { duration: d })}
                    model={activeModelFormatted}
                    effort={activeEffortFormatted}
                    usage={liveUsage}
                    retry={
                      session.retry
                        ? session.retry.max > 0
                          ? t("chat.retrying", {
                              attempt: session.retry.attempt,
                              max: session.retry.max,
                            })
                          : t("chat.retryingNoMax", { attempt: session.retry.attempt })
                        : null
                    }
                    retryDetail={session.retry?.message || null}
                  />
                ) : (
                  <TimelineRowView
                    row={rows[item.index]}
                    workspacePath={workspacePath}
                    turnLive={turnLive}
                    autoExpand={
                      detailedDisplay || rowKey(rows[item.index]) === lastProcessKey
                    }
                    thinkingAutoCollapse={thinkingAutoCollapse}
                    detailedDisplay={detailedDisplay}
                    seenTools={seenTools}
                    onRetry={
                      onRetry &&
                      !turnLive &&
                      rows[item.index].kind === "msg" &&
                      rowKey(rows[item.index]) === lastMessageKey
                        ? onRetry
                        : undefined
                    }
                    branchTarget={
                      !turnLive && rows[item.index].kind === "msg"
                        ? branchTargetByRow.get(rowKey(rows[item.index]))
                        : undefined
                    }
                    onBranch={onBranch}
                    onRewind={onRewind}
                    onEdit={onEdit}
                    onDelete={onDelete}
                  />
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
});
