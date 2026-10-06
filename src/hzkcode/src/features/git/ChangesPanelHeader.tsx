import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Plus from "lucide-react/dist/esm/icons/plus";
import Search from "lucide-react/dist/esm/icons/search";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import CloudDownload from "lucide-react/dist/esm/icons/cloud-download";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import CloudUpload from "lucide-react/dist/esm/icons/cloud-upload";
import { Button } from "@/components/base/buttons/button";
import { IconButton } from "@/components/base/buttons/icon-button";
import {
  Dropdown,
  DropdownDivider,
  DropdownItem,
  DropdownPopover,
  DropdownTrigger,
} from "@/components/base/dropdown/dropdown";
import { ipc, type BranchInfo, type RemoteInfo } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { useGitStore } from "./store";

interface ChangesPanelHeaderProps {
  workspacePath: string;
  notRepo: boolean;
  branch: string | undefined;
  /** Commits ahead of / behind the upstream; undefined hides the indicator. */
  ahead: number | undefined;
  behind: number | undefined;
  branches: BranchInfo[] | undefined;
  /** The origin remote; null = none bound, undefined = still loading. */
  remote: RemoteInfo | null | undefined;
  /** Binds or re-points origin; resolves true once persisted. `pushUrl` is
   *  the explicit push choice: "" follows the fetch URL, a value replaces it,
   *  null keeps the current configuration. */
  onSaveRemote: (url: string, pushUrl: string | null) => Promise<boolean>;
  pending: Record<string, true>;
  /** First error to surface: a failed action, else the last refresh failure. */
  error: string | null;
  run: (key: string, action: () => Promise<unknown>) => void;
  onDismissError: () => void;
}

/** Title row with refresh/pull/push, the branch picker, and the new-branch form. */
export function ChangesPanelHeader({
  workspacePath,
  notRepo,
  branch,
  ahead,
  behind,
  branches,
  remote,
  onSaveRemote,
  pending,
  error,
  run,
  onDismissError,
}: ChangesPanelHeaderProps) {
  const { t } = useTranslation();
  const [branchOpen, setBranchOpen] = useState(false);
  const [creatingBranch, setCreatingBranch] = useState(false);
  const [newBranchName, setNewBranchName] = useState("");
  const [branchQuery, setBranchQuery] = useState("");

  // Stale filter text must not survive into the next open.
  useEffect(() => {
    if (!branchOpen) setBranchQuery("");
  }, [branchOpen]);

  const filteredBranches = useMemo(() => {
    const q = branchQuery.trim().toLowerCase();
    return (branches ?? []).filter(
      (b) => q.length === 0 || b.name.toLowerCase().includes(q),
    );
  }, [branches, branchQuery]);

  return (
    <div className="flex flex-col gap-2 border-b border-separator-border px-3 py-2.5">
      <div className="flex items-center gap-1.5">
        <span className="text-body-medium text-text-primary">{t("git.changes")}</span>
        {ahead !== undefined && behind !== undefined && (
          <span className="text-xs text-text-tertiary">
            ↑{ahead} ↓{behind}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <IconButton
            icon={RefreshCw}
            size="small"
            aria-label={t("common.refresh")}
            title={t("common.refresh")}
            disabled={pending.refresh === true}
            onClick={() =>
              run("refresh", () => useGitStore.getState().refresh(workspacePath, true))
            }
          />
          <IconButton
            icon={CloudDownload}
            size="small"
            aria-label={t("git.pull")}
            title={t("git.pull")}
            disabled={notRepo || pending.pull === true}
            onClick={() => run("pull", () => useGitStore.getState().pull(workspacePath))}
          />
          <IconButton
            icon={CloudUpload}
            size="small"
            aria-label={t("git.push")}
            title={t("git.push")}
            disabled={notRepo || pending.push === true}
            onClick={() => run("push", () => useGitStore.getState().push(workspacePath))}
          />
        </div>
      </div>
      {!notRepo && (
        <div className="flex items-center gap-1">
          <Dropdown isOpen={branchOpen} onOpenChange={setBranchOpen}>
            <DropdownTrigger
              className={cx(
                "flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-border-button-default",
                "px-2 text-body-medium text-text-primary shadow-xs",
                "hover:bg-background-secondary-hover",
              )}
            >
              <GitBranch
                aria-hidden
                className="size-4 shrink-0 text-foreground-icon-secondary"
              />
              <span className="truncate">{branch ?? "…"}</span>
              <ChevronDown
                aria-hidden
                className="ml-auto size-4 shrink-0 text-foreground-icon-tertiary"
              />
            </DropdownTrigger>
            <DropdownPopover aria-label={t("git.branch")} placement="bottom start" className="max-h-80!">
              {/* Single scroller: the popover itself, capped at 320px
                  (react-aria's inline viewport clamp would otherwise let it
                  grow to nearly full-window height, so the cap needs the
                  important modifier to win). Search and the new-branch footer
                  pin via sticky; the rows scroll between them. An inner
                  max-h scroll div nested badly here — in short windows the
                  clamped popover clipped the inner list and its scrollbar,
                  leaving the lower branches unreachable. */}
              <div className="sticky -top-2.5 z-10 -mx-2.5 -mt-2.5 bg-background-primary-default px-2.5 pt-2.5 pb-1">
                <div className="flex h-8 items-center gap-1.5 rounded-lg border border-border-button-default px-2">
                  <Search
                    aria-hidden
                    className="size-4 shrink-0 text-foreground-icon-secondary"
                  />
                  <input
                    autoFocus
                    value={branchQuery}
                    onChange={(e) => setBranchQuery(e.target.value)}
                    placeholder={t("git.searchBranches")}
                    className="min-w-0 flex-1 bg-transparent text-body-medium text-text-primary outline-none placeholder:text-text-placeholder"
                  />
                </div>
              </div>
              {filteredBranches.map((b) => (
                <DropdownItem
                  key={b.name}
                  selected={b.isCurrent}
                  className="px-2 py-1.5"
                  onSelect={() => {
                    setBranchOpen(false);
                    if (!b.isCurrent) {
                      run("checkout", () =>
                        useGitStore.getState().checkout(workspacePath, b.name),
                      );
                    }
                  }}
                >
                  <span className="truncate text-body-medium text-text-primary">
                    {b.name}
                  </span>
                </DropdownItem>
              ))}
              {filteredBranches.length === 0 && (
                <span className="px-2 py-1.5 text-body-medium text-text-tertiary">
                  {t("git.noMatchingBranches")}
                </span>
              )}
              <div className="sticky -bottom-2.5 z-10 -mx-2.5 -mb-2.5 bg-background-primary-default px-2.5 pb-2.5">
                <DropdownDivider />
                <DropdownItem
                  className="px-2 py-1.5"
                  onSelect={() => {
                    setBranchOpen(false);
                    setCreatingBranch(true);
                  }}
                >
                  <Plus aria-hidden className="size-4 text-foreground-icon-secondary" />
                  <span className="text-body-medium text-text-primary">
                    {t("git.newBranch")}
                  </span>
                </DropdownItem>
              </div>
            </DropdownPopover>
          </Dropdown>
        </div>
      )}
      {creatingBranch && (
        <form
          className="flex items-center gap-1"
          onSubmit={(e) => {
            e.preventDefault();
            const name = newBranchName.trim();
            if (name.length === 0 || pending.createBranch === true) return;
            run("createBranch", async () => {
              await useGitStore.getState().createBranch(workspacePath, name);
              setCreatingBranch(false);
              setNewBranchName("");
            });
          }}
        >
          <input
            autoFocus
            value={newBranchName}
            onChange={(e) => setNewBranchName(e.target.value)}
            placeholder={t("git.branchNamePlaceholder")}
            className={cx(
              "h-8 min-w-0 flex-1 rounded-lg border border-border-button-default px-2",
              "text-body-medium text-text-primary placeholder:text-text-placeholder",
              "outline-none focus:border-border-focus-ring",
            )}
          />
          <Button
            size="small"
            type="submit"
            disabled={newBranchName.trim().length === 0 || pending.createBranch === true}
          >
            {t("common.confirm")}
          </Button>
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              setCreatingBranch(false);
              setNewBranchName("");
            }}
          >
            {t("common.cancel")}
          </Button>
        </form>
      )}
      {!notRepo && (
        <RemoteRow
          workspacePath={workspacePath}
          remote={remote}
          saving={pending.remote === true}
          onSave={onSaveRemote}
        />
      )}
      {error && (
        <div role="alert" className="flex items-center gap-2">
          <p className="min-w-0 flex-1 break-words text-xs text-text-error-primary">{error}</p>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onDismissError}
            className="shrink-0 cursor-pointer rounded p-0.5 text-text-error-primary hover:bg-background-tertiary-hover"
          >
            ×
          </button>
        </div>
      )}
    </div>
  );
}

/** The origin line under the branch picker: the (credential-masked) fetch
 *  URL (plus the separate push URL when one is set) and an 编辑/绑定 entry
 *  that opens an inline form. The form is explicit about the push target: a
 *  checkbox keeps it equal to the fetch URL, unchecking offers a separate
 *  one (blank keeps the current configuration). Opening the form prefills
 *  the raw (unmasked) addresses — fetched only then — so editing starts from
 *  the real values instead of a masked display string. */
function RemoteRow({
  workspacePath,
  remote,
  saving,
  onSave,
}: {
  workspacePath: string;
  remote: RemoteInfo | null | undefined;
  saving: boolean;
  onSave: (url: string, pushUrl: string | null) => Promise<boolean>;
}) {
  const { t } = useTranslation();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [pushDraft, setPushDraft] = useState("");
  const [pushSame, setPushSame] = useState(true);

  if (editing) {
    return (
      <form
        className="flex flex-col gap-1"
        onSubmit={(e) => {
          e.preventDefault();
          const url = draft.trim();
          if (url.length === 0 || saving) return;
          // Explicit push choice: same-URL clears a separate push URL, a
          // typed one replaces it, an empty one while unchecked keeps the
          // current configuration.
          const push = pushSame ? "" : pushDraft.trim() ? pushDraft.trim() : null;
          void onSave(url, push).then((ok) => {
            if (ok) {
              setEditing(false);
              setDraft("");
              setPushDraft("");
            }
          });
        }}
      >
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={t("git.remoteUrlPlaceholder")}
          className={cx(
            "h-8 min-w-0 rounded-lg border border-border-button-default px-2",
            "text-body-medium text-text-primary placeholder:text-text-placeholder",
            "outline-none focus:border-border-focus-ring",
          )}
        />
        <label className="flex items-center gap-1.5 px-0.5 text-xs text-text-secondary">
          <input
            type="checkbox"
            checked={pushSame}
            onChange={(e) => setPushSame(e.target.checked)}
            className="size-3.5"
          />
          {t("git.pushSameAsUrl")}
        </label>
        {!pushSame && (
          <input
            value={pushDraft}
            onChange={(e) => setPushDraft(e.target.value)}
            placeholder={t("git.pushUrlPlaceholder")}
            className={cx(
              "h-8 min-w-0 rounded-lg border border-border-button-default px-2",
              "text-body-medium text-text-primary placeholder:text-text-placeholder",
              "outline-none focus:border-border-focus-ring",
            )}
          />
        )}
        <div className="flex items-center justify-end gap-1">
          <Button
            size="small"
            type="submit"
            disabled={draft.trim().length === 0 || saving}
          >
            {t("common.confirm")}
          </Button>
          <Button
            size="small"
            variant="ghost"
            onClick={() => {
              setEditing(false);
              setDraft("");
              setPushDraft("");
            }}
          >
            {t("common.cancel")}
          </Button>
        </div>
      </form>
    );
  }

  // Still loading: keep the row reserved but quiet.
  if (remote === undefined) return <div className="h-5" />;

  const openForm = () => {
    setDraft("");
    setPushDraft("");
    // A separate push URL flips the checkbox so the choice is visible
    // instead of being silently dropped.
    setPushSame(!remote?.pushUrl);
    setEditing(true);
    // Prefill with the raw (unmasked) addresses, fetched only for the form:
    // submitting the masked display value as-is would corrupt the stored
    // credential.
    void ipc
      .gitRemoteRaw(workspacePath)
      .then((raw) => {
        if (!raw) return;
        const { url, pushUrl } = raw;
        // Don't clobber anything typed while the fetch was in flight.
        setDraft((prev) => (prev.length === 0 ? url : prev));
        if (pushUrl) {
          setPushDraft((prev) => (prev.length === 0 ? pushUrl : prev));
        }
      })
      .catch(() => {});
  };

  return (
    <div className="flex min-w-0 flex-col gap-0.5 px-0.5">
      <div className="flex min-w-0 items-center gap-1">
        {remote ? (
          <>
            <span className="min-w-0 truncate text-xs text-text-tertiary" title={remote.url}>
              {remote.name} · {remote.url}
            </span>
            <button
              type="button"
              onClick={openForm}
              className="shrink-0 cursor-pointer text-xs text-text-secondary hover:text-text-primary"
            >
              {t("git.editRemote")}
            </button>
          </>
        ) : (
          <>
            <span className="text-xs text-text-tertiary">{t("git.noRemote")}</span>
            <button
              type="button"
              onClick={openForm}
              className="shrink-0 cursor-pointer text-xs text-text-secondary hover:text-text-primary"
            >
              {t("git.bindRemote")}
            </button>
          </>
        )}
      </div>
      {remote?.pushUrl && (
        <span
          className="min-w-0 truncate text-caption-1-medium text-text-tertiary"
          title={remote.pushUrl}
        >
          {t("git.pushUrl")} · {remote.pushUrl}
        </span>
      )}
    </div>
  );
}
