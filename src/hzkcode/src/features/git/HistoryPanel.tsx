import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { IconButton } from "@/components/base/buttons/icon-button";
import { ipc, type CommitInfo, type GitFileEntry } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import i18n from "@/lib/i18n";
import { cx } from "@/utils/cx";
import { FileRow } from "./FileRow";
import { useGitStore } from "./store";

const PAGE_SIZE = 50;

/** Lazily fetched file list of one expanded commit. */
type CommitFiles = GitFileEntry[] | "loading" | { error: string };

/** Relative commit time via Intl — localized without extra i18n keys. */
function relativeTime(unixSeconds: number): string {
  const rtf = new Intl.RelativeTimeFormat(i18n.language, { numeric: "auto" });
  const diff = unixSeconds - Date.now() / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), "second");
  if (abs < 3600) return rtf.format(Math.round(diff / 60), "minute");
  if (abs < 86_400) return rtf.format(Math.round(diff / 3600), "hour");
  if (abs < 86_400 * 30) return rtf.format(Math.round(diff / 86_400), "day");
  if (abs < 86_400 * 365) return rtf.format(Math.round(diff / (86_400 * 30)), "month");
  return rtf.format(Math.round(diff / (86_400 * 365)), "year");
}

/** Commit history of the workspace's checked-out branch: paged list, per
 *  commit file list on expand, and click-through to each file's commit diff. */
export function HistoryPanel({
  workspacePath,
  className,
}: {
  workspacePath: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const historyRevision = useGitStore(
    (s) => s.historyRevisionByWorkspace[workspacePath] ?? 0,
  );
  const [commits, setCommits] = useState<CommitInfo[] | null>(null);
  const [hasMore, setHasMore] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notRepo, setNotRepo] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [filesByHash, setFilesByHash] = useState<Record<string, CommitFiles>>({});
  // Drops stale responses: a reload (fresh commit / workspace switch)
  // invalidates any page still in flight.
  const seqRef = useRef(0);

  const reload = useCallback(() => {
    const seq = ++seqRef.current;
    setCommits(null);
    setError(null);
    setNotRepo(false);
    setExpanded(null);
    setFilesByHash({});
    setLoadingMore(false);
    ipc
      .gitLog(workspacePath, PAGE_SIZE, 0)
      .then((list) => {
        if (seqRef.current !== seq) return;
        setCommits(list);
        setHasMore(list.length === PAGE_SIZE);
      })
      .catch((err: unknown) => {
        if (seqRef.current !== seq) return;
        if (errorText(err).includes("NOT_A_REPO")) setNotRepo(true);
        else setError(errorText(err));
      });
  }, [workspacePath]);

  useEffect(() => {
    reload();
  }, [reload, historyRevision]);

  const loadMore = useCallback(() => {
    if (!commits || loadingMore) return;
    const seq = seqRef.current;
    setLoadingMore(true);
    ipc
      .gitLog(workspacePath, PAGE_SIZE, commits.length)
      .then((list) => {
        if (seqRef.current !== seq) return;
        setCommits((prev) => (prev ? [...prev, ...list] : list));
        setHasMore(list.length === PAGE_SIZE);
      })
      .catch((err: unknown) => {
        if (seqRef.current === seq) setError(errorText(err));
      })
      .finally(() => {
        if (seqRef.current === seq) setLoadingMore(false);
      });
  }, [commits, loadingMore, workspacePath]);

  const toggleCommit = useCallback(
    (hash: string) => {
      setExpanded((prev) => (prev === hash ? null : hash));
      const cached = filesByHash[hash];
      // Loaded (or loading) files are reused; an error state retries.
      if (Array.isArray(cached) || cached === "loading") return;
      const seq = seqRef.current;
      setFilesByHash((prev) => ({ ...prev, [hash]: "loading" }));
      ipc
        .gitCommitFiles(workspacePath, hash)
        .then((files) => {
          if (seqRef.current !== seq) return;
          setFilesByHash((prev) => ({ ...prev, [hash]: files }));
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          setFilesByHash((prev) => ({ ...prev, [hash]: { error: errorText(err) } }));
        });
    },
    [filesByHash, workspacePath],
  );

  const openFileDiff = useCallback(
    (hash: string, file: string) =>
      useGitStore
        .getState()
        .openDiff(workspacePath, { file, staged: false, commit: hash }),
    [workspacePath],
  );

  return (
    <aside className={cx("flex h-full flex-col bg-background-primary-default", className)}>
      <div className="flex items-center gap-1.5 border-b border-separator-border px-3 py-2.5">
        <span className="text-body-medium text-text-primary">{t("git.history")}</span>
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon={RefreshCw}
            size="small"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            disabled={commits === null}
            onClick={reload}
          />
        </div>
      </div>
      <div className="flex-1 overflow-y-auto">
        {notRepo ? (
          <CenteredNote>{t("git.notARepo")}</CenteredNote>
        ) : error ? (
          <CenteredNote kind="error">{error}</CenteredNote>
        ) : commits === null ? (
          <CenteredNote>{t("common.loading")}</CenteredNote>
        ) : commits.length === 0 ? (
          <CenteredNote>{t("git.noCommits")}</CenteredNote>
        ) : (
          <>
            <ul>
              {commits.map((commit) => (
                <CommitRow
                  key={commit.hash}
                  commit={commit}
                  expanded={expanded === commit.hash}
                  files={filesByHash[commit.hash]}
                  onToggle={() => toggleCommit(commit.hash)}
                  onOpenFile={(file) => openFileDiff(commit.hash, file)}
                />
              ))}
            </ul>
            {hasMore && (
              <button
                type="button"
                disabled={loadingMore}
                onClick={loadMore}
                className={cx(
                  "w-full py-2 text-center text-xs text-text-secondary",
                  "hover:bg-background-secondary-hover disabled:text-text-disabled",
                )}
              >
                {t("git.loadMore")}
              </button>
            )}
          </>
        )}
      </div>
    </aside>
  );
}

function CenteredNote({
  children,
  kind,
}: {
  children: ReactNode;
  kind?: "error";
}) {
  return (
    <div className="flex h-full items-center justify-center p-4">
      <p
        className={cx(
          "text-center text-body-medium",
          kind === "error" ? "text-text-error-primary" : "text-text-tertiary",
        )}
      >
        {children}
      </p>
    </div>
  );
}

function CommitRow({
  commit,
  expanded,
  files,
  onToggle,
  onOpenFile,
}: {
  commit: CommitInfo;
  expanded: boolean;
  files: CommitFiles | undefined;
  onToggle: () => void;
  onOpenFile: (file: string) => void;
}) {
  const { t } = useTranslation();
  return (
    <li>
      <button
        type="button"
        aria-expanded={expanded}
        onClick={onToggle}
        className="flex w-full items-start gap-1 px-2 py-1.5 text-left hover:bg-background-secondary-hover"
      >
        {expanded ? (
          <ChevronDown
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-foreground-icon-tertiary"
          />
        ) : (
          <ChevronRight
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-foreground-icon-tertiary"
          />
        )}
        <span className="min-w-0 flex-1">
          <span className="block truncate text-body-medium text-text-primary">
            {commit.summary || "—"}
          </span>
          <span className="block truncate text-xs text-text-tertiary">
            <span className="font-mono">{commit.shortHash}</span>
            {" · "}
            {commit.author}
            {" · "}
            {relativeTime(commit.time)}
          </span>
        </span>
      </button>
      {expanded && (
        <div className="pb-1 pl-7">
          {files === undefined || files === "loading" ? (
            <p className="px-3 py-1 text-xs text-text-tertiary">{t("common.loading")}</p>
          ) : Array.isArray(files) ? (
            files.length === 0 ? (
              <p className="px-3 py-1 text-xs text-text-tertiary">{t("git.noChanges")}</p>
            ) : (
              <ul>
                {files.map((file) => (
                  <FileRow key={file.path} entry={file} onOpen={onOpenFile} />
                ))}
              </ul>
            )
          ) : (
            <p className="px-3 py-1 text-xs text-text-error-primary">{files.error}</p>
          )}
        </div>
      )}
    </li>
  );
}
