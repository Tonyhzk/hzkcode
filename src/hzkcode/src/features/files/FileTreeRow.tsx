import { memo, useCallback, useMemo, type MouseEvent } from "react";
import Loader2 from "lucide-react/dist/esm/icons/loader-2";
import Plus from "lucide-react/dist/esm/icons/plus";
import { cx } from "@/utils/cx";
import type { DirEntry, FileTreeColor, RepositorySummary } from "@/lib/ipc";
import { getFileTreeIconSvg } from "./fileIcons";

export interface VisibleNode extends DirEntry {
  path: string;
  depth: number;
  expanded: boolean;
  loading: boolean;
  /** Compact git status when this directory is itself a repo root. */
  repository?: RepositorySummary;
  /** Git-state name color: file states + blue for repo-root rows. */
  color?: FileTreeColor;
}

/** Tooltip/aria text for a repo badge: `branch ✓` or `branch M<n> ?<n>`. */
function repositoryLabel(repo: RepositorySummary): string {
  return repo.changed + repo.untracked === 0
    ? `${repo.branch} ✓`
    : `${repo.branch}${repo.changed > 0 ? ` M${repo.changed}` : ""}${repo.untracked > 0 ? ` ?${repo.untracked}` : ""}`;
}

interface TreeRowProps {
  node: VisibleNode;
  selected: boolean;
  onToggleDir: (path: string) => void;
  onOpenFile: (path: string) => void;
  onSelectDir: (path: string) => void;
  onContextMenu: (event: MouseEvent<HTMLElement>, node: VisibleNode) => void;
  /** Hover "+": stage an @path mention in the active chat's composer. */
  onMention: (path: string) => void;
  mentionLabel: string;
}

export const TreeRow = memo(function TreeRow({
  node,
  selected,
  onToggleDir,
  onOpenFile,
  onSelectDir,
  onContextMenu,
  onMention,
  mentionLabel,
}: TreeRowProps) {
  const handleClick = useCallback(() => {
    if (node.isDir) {
      onSelectDir(node.path);
      onToggleDir(node.path);
    } else {
      onOpenFile(node.path);
    }
  }, [node.isDir, node.path, onToggleDir, onOpenFile, onSelectDir]);

  // Icon SVGs are static string constants; selection is a map/set lookup.
  const iconSvg = useMemo(
    () => getFileTreeIconSvg(node.name, node.isDir, node.expanded),
    [node.name, node.isDir, node.expanded],
  );

  return (
    <div
      onContextMenu={(e) => onContextMenu(e, node)}
      className={cx(
        "group flex h-7 w-full items-center rounded-md pr-1 text-body-medium",
        "hover:bg-background-primary-hover",
        selected
          ? "bg-background-primary-active text-text-primary"
          : "text-text-primary",
      )}
      style={{ paddingLeft: 14 + node.depth * 14 }}
    >
      <button
        type="button"
        onClick={handleClick}
        className="flex min-w-0 flex-1 items-center gap-1 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
        title={node.path}
      >
        {node.loading ? (
          <Loader2 className="size-4 shrink-0 animate-spin text-foreground-icon-tertiary" aria-hidden />
        ) : (
          <span
            className={cx(
              "size-4 shrink-0 [&>svg]:size-4",
              node.isDir
                ? "text-foreground-icon-secondary"
                : "text-foreground-icon-tertiary",
            )}
            aria-hidden
            dangerouslySetInnerHTML={{ __html: iconSvg }}
          />
        )}
        <span
          className={cx(
            // The folder/file name has display priority: it keeps its
            // natural width (truncating only when it alone overflows the
            // row), so the badge below yields space instead.
            "min-w-0 max-w-full shrink-0 truncate",
            // Spec: untracked files → green, modified files → orange, and
            // repo-root rows (workspace repo root + nested repos) → blue.
            // Plain folders never carry color.
            node.color === "untracked" && "text-status-green-text",
            node.color === "modified" && "text-text-warning-primary",
            node.color === "repository" && "text-status-blue-text",
          )}
        >
          {node.name}
        </span>
        {node.repository ? (
          <span
            className={cx(
              // The branch badge takes what's left; the branch name
              // truncates with an ellipsis (full text in the title tip) —
              // no horizontal scrolling, ever.
              "ml-2 flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-caption-1-medium",
              node.repository.changed + node.repository.untracked === 0
                ? "text-state-success-text"
                : "text-status-yellow-text",
            )}
            title={repositoryLabel(node.repository)}
            aria-label={repositoryLabel(node.repository)}
          >
            <span className="min-w-0 flex-1 truncate">{node.repository.branch}</span>
            {node.repository.changed + node.repository.untracked === 0 ? (
              <span className="shrink-0" aria-hidden>✓</span>
            ) : (
              <>
                {node.repository.changed > 0 && (
                  <span className="shrink-0 text-text-warning-primary" aria-hidden>M{node.repository.changed}</span>
                )}
                {node.repository.untracked > 0 && (
                  <span className="shrink-0 text-status-green-text" aria-hidden>?{node.repository.untracked}</span>
                )}
              </>
            )}
          </span>
        ) : null}
      </button>
      <button
        type="button"
        aria-label={mentionLabel}
        title={mentionLabel}
        onClick={(e) => {
          e.stopPropagation();
          onMention(node.path);
        }}
        className="ml-auto hidden size-5 shrink-0 cursor-pointer items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-primary-active hover:text-text-primary group-hover:flex focus-visible:flex"
      >
        <Plus className="size-3.5" aria-hidden />
      </button>
    </div>
  );
});
