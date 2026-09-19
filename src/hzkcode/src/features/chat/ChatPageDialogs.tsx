import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import { ConfirmDialog, PromptDialog } from "@/components/dialogs";
import { fileName, useFilesStore } from "@/features/files/store";
import { useTerminalStore } from "@/features/terminal/store";
import type { SessionMeta } from "@/lib/ipc";
import { useChatStore } from "./store";

/** Modal dialogs owned by the chat page. */
export type ChatPageDialog =
  | { kind: "rename"; session: SessionMeta }
  | { kind: "delete"; session: SessionMeta }
  | { kind: "removeWorkspace"; workspaceId: string }
  | { kind: "workspaceAlias"; workspaceId: string }
  | { kind: "closeFile"; path: string };

/** Session rename/delete, dirty-file close, and workspace removal
 * confirmations, rendered above the chat page. */
export function ChatPageDialogs({
  dialog,
  onClose,
}: {
  dialog: ChatPageDialog | null;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { renameSession, deleteSession, removeWorkspace, setWorkspaceAlias } = useChatStore(
    useShallow((s) => ({
      renameSession: s.renameSession,
      deleteSession: s.deleteSession,
      removeWorkspace: s.removeWorkspace,
      setWorkspaceAlias: s.setWorkspaceAlias,
    })),
  );
  const workspaces = useChatStore((s) => s.workspaces);
  const workspaceAliases = useChatStore((s) => s.workspaceAliases);
  const closeFile = useFilesStore((s) => s.closeFile);
  const removeTerminalWorkspace = useTerminalStore((s) => s.removeWorkspace);

  return (
    <>
      {dialog?.kind === "rename" && (
        <PromptDialog
          title={t("chat.renameSession")}
          initial={dialog.session.customTitle || dialog.session.title}
          onSubmit={(title) => {
            onClose();
            void renameSession(dialog.session.engine, dialog.session.sessionId, title);
          }}
          onCancel={onClose}
        />
      )}
      {dialog?.kind === "delete" && (
        <ConfirmDialog
          danger
          message={t("chat.confirmDeleteSession")}
          onConfirm={() => {
            onClose();
            void deleteSession(dialog.session.engine, dialog.session.sessionId);
          }}
          onCancel={onClose}
        />
      )}
      {dialog?.kind === "closeFile" && (
        <ConfirmDialog
          danger
          message={t("files.confirmCloseDirty", { name: fileName(dialog.path) })}
          onConfirm={() => {
            closeFile(dialog.path);
            onClose();
          }}
          onCancel={onClose}
        />
      )}
      {dialog?.kind === "workspaceAlias" && (
        <PromptDialog
          allowEmpty
          title={t("chat.workspaceAliasTitle")}
          hint={t("chat.workspaceAliasHint")}
          placeholder={t("chat.workspaceAliasPlaceholder")}
          initial={workspaceAliases[dialog.workspaceId] ?? ""}
          onSubmit={(alias) => {
            onClose();
            void setWorkspaceAlias(dialog.workspaceId, alias);
          }}
          onCancel={onClose}
        />
      )}
      {dialog?.kind === "removeWorkspace" && (
        <ConfirmDialog
          message={t("chat.confirmRemoveWorkspace")}
          onConfirm={() => {
            const workspace = workspaces.find((w) => w.id === dialog.workspaceId);
            if (workspace) removeTerminalWorkspace(workspace.path);
            onClose();
            void removeWorkspace(dialog.workspaceId);
          }}
          onCancel={onClose}
        />
      )}
    </>
  );
}
