import { memo, useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ChevronRight from "lucide-react/dist/esm/icons/chevron-right";
import { ipc, type GitFileEntry, type GitStatus, type RemoteInfo } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { cx } from "@/utils/cx";
import { useGitStore } from "./store";
import { ChangesPanelHeader } from "./ChangesPanelHeader";
import { CommitFooter } from "./CommitFooter";
import { FileRow } from "./FileRow";

export function ChangesPanel({
  workspacePath,
  className,
}: {
  workspacePath: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const status = useGitStore((s) => s.statusByWorkspace[workspacePath]);
  const notRepo = useGitStore((s) => s.notRepoByWorkspace[workspacePath]);
  const refreshError = useGitStore((s) => s.errorByWorkspace[workspacePath]);
  const branches = useGitStore((s) => s.branchesByWorkspace[workspacePath]);

  const [actionError, setActionError] = useState<string | null>(null);
  const [pending, setPending] = useState<Record<string, true>>({});
  const [commitMsg, setCommitMsg] = useState("");

  useEffect(() => {
    void useGitStore.getState().refresh(workspacePath);
    void useGitStore.getState().loadBranches(workspacePath);
  }, [workspacePath]);

  // The origin remote line under the branch picker; undefined until read.
  const [remote, setRemote] = useState<RemoteInfo | null | undefined>(undefined);
  const loadRemote = useCallback(() => {
    ipc
      .gitRemote(workspacePath)
      .then((info) => setRemote(info))
      .catch(() => setRemote(null));
  }, [workspacePath]);
  useEffect(() => {
    loadRemote();
  }, [loadRemote]);

  /** Runs a mutating action: tracks busy state, surfaces errors inline.
   *  Resolves true on success so callers can close their inline forms. */
  const run = useCallback(
    (key: string, action: () => Promise<unknown>): Promise<boolean> => {
      setPending((p) => ({ ...p, [key]: true }));
      setActionError(null);
      return action()
        .then(() => true)
        .catch((err: unknown) => {
          setActionError(errorText(err));
          return false;
        })
        .finally(() => {
          setPending((p) => {
            const next = { ...p };
            delete next[key];
            return next;
          });
        });
    },
    [],
  );
  /** Dismiss the header error: the failed action's error, else the store's
   * last refresh failure. */
  const dismissError = useCallback(() => {
    setActionError(null);
    useGitStore.getState().clearError(workspacePath);
  }, [workspacePath]);

  const saveRemote = useCallback(
    async (url: string, pushUrl: string | null) => {
      const ok = await run("remote", () =>
        ipc.gitRemoteSet(workspacePath, url, pushUrl),
      );
      if (ok) loadRemote();
      return ok;
    },
    [run, workspacePath, loadRemote],
  );

  const stage = useCallback(
    (files: string[]) =>
      run("stage", () => useGitStore.getState().stage(workspacePath, files)),
    [run, workspacePath],
  );
  const unstage = useCallback(
    (files: string[]) =>
      run("unstage", () => useGitStore.getState().unstage(workspacePath, files)),
    [run, workspacePath],
  );
  const stageOne = useCallback((file: string) => stage([file]), [stage]);
  const unstageOne = useCallback((file: string) => unstage([file]), [unstage]);
  // File rows open the diff in the editor dock (ChatPage expands it).
  const openStagedDiff = useCallback(
    (file: string) =>
      useGitStore.getState().openDiff(workspacePath, { file, staged: true }),
    [workspacePath],
  );
  const openUnstagedDiff = useCallback(
    (file: string) =>
      useGitStore.getState().openDiff(workspacePath, { file, staged: false }),
    [workspacePath],
  );

  const header = (
    <ChangesPanelHeader
      workspacePath={workspacePath}
      notRepo={notRepo}
      branch={status?.branch}
      ahead={status?.ahead}
      behind={status?.behind}
      branches={branches}
      remote={remote}
      onSaveRemote={saveRemote}
      pending={pending}
      error={actionError ?? refreshError}
      run={run}
      onDismissError={dismissError}
    />
  );

  if (notRepo) {
    return (
      <aside className={cx("flex h-full flex-col bg-background-primary-default", className)}>
        {header}
        <div className="flex flex-1 items-center justify-center p-4">
          <p className="text-center text-body-medium text-text-tertiary">
            {t("git.notARepo")}
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside className={cx("flex h-full flex-col bg-background-primary-default", className)}>
      {header}
      <div className="flex-1 overflow-y-auto">
        {!status ? (
          <div className="flex h-full items-center justify-center p-4">
            <p className="text-body-medium text-text-tertiary">{t("common.loading")}</p>
          </div>
        ) : status.staged.length + status.unstaged.length + status.untracked.length === 0 ? (
          <div className="flex h-full items-center justify-center p-4">
            <p className="text-body-medium text-text-tertiary">{t("git.noChanges")}</p>
          </div>
        ) : (
          <>
            <ChangesSummary status={status} />
            <GroupSection
              title={t("git.staged")}
              entries={status.staged}
              groupActionLabel={t("git.unstageAll")}
              onGroupAction={unstage}
              rowActionLabel={t("git.unstage")}
              rowActionKind="unstage"
              onRowAction={unstageOne}
              onOpen={openStagedDiff}
              actionBusy={pending.unstage === true}
            />
            <GroupSection
              title={t("git.unstaged")}
              entries={status.unstaged}
              groupActionLabel={t("git.stageAll")}
              onGroupAction={stage}
              rowActionLabel={t("git.stage")}
              rowActionKind="stage"
              onRowAction={stageOne}
              onOpen={openUnstagedDiff}
              actionBusy={pending.stage === true}
            />
            <GroupSection
              title={t("git.untracked")}
              entries={status.untracked}
              groupActionLabel={t("git.stageAll")}
              onGroupAction={stage}
              rowActionLabel={t("git.stage")}
              rowActionKind="stage"
              onRowAction={stageOne}
              onOpen={openUnstagedDiff}
              actionBusy={pending.stage === true}
              isNew
            />
          </>
        )}
      </div>
      <CommitFooter
        workspacePath={workspacePath}
        stagedCount={status?.staged.length ?? 0}
        busy={pending.commit === true}
        commitMsg={commitMsg}
        onCommitMsgChange={setCommitMsg}
        run={run}
      />
    </aside>
  );
}

/* -------------------------------------------------------------------------- */

function ChangesSummary({ status }: { status: GitStatus }) {
  const { t } = useTranslation();
  const all = [...status.staged, ...status.unstaged, ...status.untracked];
  const adds = all.reduce((n, f) => n + (f.additions ?? 0), 0);
  const dels = all.reduce((n, f) => n + (f.deletions ?? 0), 0);
  return (
    <div className="sticky top-0 flex items-center gap-1.5 border-b border-separator-border bg-background-primary-default px-3 py-2">
      <span className="text-body-medium text-text-primary">
        {all.length} {t("git.uncommittedChanges")}
      </span>
      <span className="text-xs text-state-success-text">+{adds}</span>
      <span className="text-xs text-text-error-primary">−{dels}</span>
    </div>
  );
}

interface GroupSectionProps {
  title: string;
  entries: GitFileEntry[];
  groupActionLabel: string;
  onGroupAction: (files: string[]) => void;
  rowActionLabel: string;
  rowActionKind: "stage" | "unstage";
  onRowAction: (file: string) => void;
  onOpen: (file: string) => void;
  actionBusy: boolean;
  isNew?: boolean;
}

const GroupSection = memo(function GroupSection({
  title,
  entries,
  groupActionLabel,
  onGroupAction,
  rowActionLabel,
  rowActionKind,
  onRowAction,
  onOpen,
  actionBusy,
  isNew = false,
}: GroupSectionProps) {
  const [open, setOpen] = useState(true);
  if (entries.length === 0) return null;
  return (
    <section>
      <div
        className={cx(
          "sticky top-0 flex items-center gap-1 bg-background-secondary-default px-3 py-1.5",
          "border-b border-separator-border",
        )}
      >
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-1"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {open ? (
            <ChevronDown aria-hidden className="size-4 text-foreground-icon-tertiary" />
          ) : (
            <ChevronRight aria-hidden className="size-4 text-foreground-icon-tertiary" />
          )}
          <span className="text-body-medium text-text-secondary">{title}</span>
          <span className="text-xs text-text-tertiary">{entries.length}</span>
        </button>
        <button
          type="button"
          disabled={actionBusy}
          onClick={() => onGroupAction(entries.map((f) => f.path))}
          className={cx(
            "shrink-0 rounded px-1.5 py-0.5 text-xs text-text-secondary",
            "hover:bg-background-tertiary-hover disabled:text-text-disabled",
          )}
        >
          {groupActionLabel}
        </button>
      </div>
      {open && (
        <ul>
          {entries.map((entry) => (
            <FileRow
              key={entry.path}
              entry={entry}
              actionLabel={rowActionLabel}
              actionKind={rowActionKind}
              onAction={onRowAction}
              onOpen={onOpen}
              actionBusy={actionBusy}
              isNew={isNew}
            />
          ))}
        </ul>
      )}
    </section>
  );
});

