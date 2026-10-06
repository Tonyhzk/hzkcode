import { memo } from "react";
import { useTranslation } from "react-i18next";
import Plus from "lucide-react/dist/esm/icons/plus";
import Minus from "lucide-react/dist/esm/icons/minus";
import { Focusable } from "react-aria-components";
import { Tooltip, TooltipContent } from "@/components/base/tooltip/tooltip";
import { type GitFileEntry } from "@/lib/ipc";
import { cx } from "@/utils/cx";

const STATUS_COLOR: Record<string, string> = {
  M: "text-status-yellow-text",
  A: "text-state-success-text",
  D: "text-text-error-primary",
  R: "text-status-purple-text",
  C: "text-status-blue-text",
};

interface FileRowProps {
  entry: GitFileEntry;
  /** Untracked group: show the "New" badge like the template panel. */
  isNew?: boolean;
  onOpen: (path: string) => void;
  /** Stage/unstage button; omitted in read-only lists (history panel). */
  actionLabel?: string;
  actionKind?: "stage" | "unstage";
  onAction?: (path: string) => void;
  actionBusy?: boolean;
}

/** One changed-file row: status letter, path, +/− stats, optional action. */
export const FileRow = memo(function FileRow({
  entry,
  isNew = false,
  onOpen,
  actionLabel,
  actionKind,
  onAction,
  actionBusy,
}: FileRowProps) {
  const { t } = useTranslation();
  const raw = entry.status.replace("?", "").trim().charAt(0).toUpperCase();
  const letter = raw.length > 0 ? raw : "?";
  const sepIdx = Math.max(entry.path.lastIndexOf("/"), entry.path.lastIndexOf("\\"));
  const dirPart = sepIdx > 0 ? entry.path.slice(0, sepIdx + 1) : "";
  const filePart = sepIdx >= 0 ? entry.path.slice(sepIdx + 1) : entry.path;
  const showAction =
    actionLabel !== undefined && actionKind !== undefined && onAction !== undefined;
  return (
    <li className="group flex items-center gap-2 px-3 py-1 hover:bg-background-secondary-hover">
      <span
        className={cx(
          "w-4 shrink-0 text-center font-mono text-xs",
          STATUS_COLOR[letter] ?? "text-text-tertiary",
        )}
      >
        {letter}
      </span>
      <Tooltip>
        <Focusable>
          <button
            type="button"
            onClick={() => onOpen(entry.path)}
            className="flex min-w-0 flex-1 items-baseline text-left font-mono text-xs"
          >
            {/* Directory truncates from the left (…/foo/bar) so the filename
                — the most important part — is always fully visible; the tooltip
                below shows the full path on hover. */}
            {dirPart && (
              <span dir="rtl" className="min-w-0 truncate text-left text-text-tertiary">
                <bdo dir="ltr">{dirPart}</bdo>
              </span>
            )}
            <span className="shrink-0 text-text-primary">{filePart}</span>
          </button>
        </Focusable>
        <TooltipContent className="break-all font-mono">{entry.path}</TooltipContent>
      </Tooltip>
      {entry.additions !== undefined && (
        <span className="shrink-0 text-xs text-state-success-text">+{entry.additions}</span>
      )}
      {entry.deletions !== undefined && entry.deletions > 0 && (
        <span className="shrink-0 text-xs text-text-error-primary">−{entry.deletions}</span>
      )}
      {isNew && (
        <span className="shrink-0 rounded-sm bg-background-tertiary-default px-1 py-px text-caption-1-medium text-text-secondary">
          {t("git.newFile")}
        </span>
      )}
      {showAction && (
        <button
          type="button"
          disabled={actionBusy}
          onClick={() => onAction(entry.path)}
          aria-label={actionLabel}
          title={actionLabel}
          className={cx(
            "shrink-0 rounded p-0.5 text-foreground-icon-secondary opacity-0",
            // Reveal on row hover AND on keyboard focus (same contract as the
            // file-tree mention button).
            "group-hover:opacity-100 focus-visible:opacity-100 hover:bg-background-tertiary-hover",
            "disabled:text-foreground-icon-disabled",
          )}
        >
          {actionKind === "stage" ? (
            <Plus aria-hidden className="size-4" />
          ) : (
            <Minus aria-hidden className="size-4" />
          )}
        </button>
      )}
    </li>
  );
});
