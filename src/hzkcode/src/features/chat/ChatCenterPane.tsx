import { lazy, Suspense } from "react";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { CenteredSpinner } from "@/components/base/empty-state";
import { DiffView } from "@/features/git/DiffView";
import type { DiffTarget } from "@/features/git/store";
import type { EngineInfo, GitStatus, Workspace } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { ChatConversation } from "./components/ChatConversation";
import type { ActiveSession } from "./store";

// CodeMirror + react-markdown are heavy; split them out of the startup chunk.
const EditorPane = lazy(() => import("@/features/files/EditorPane"));

/** Center tab content: the chat conversation, open file editors, and the
 * changes diff, stacked so only the active surface is visible. The inactive
 * surfaces stay mounted but invisible (never display:none) so WKWebView
 * keeps its scroll boxes and editor drafts alive — see the virtualizer note
 * in FileTree. */
export function ChatCenterPane({
  active,
  engines,
  workspaces,
  startNewChat,
  composerInputRef,
  openFiles,
  activeFilePath,
  diffView,
  diffStatus,
  closeDiff,
}: {
  active: ActiveSession | null;
  engines: EngineInfo[];
  workspaces: Workspace[];
  startNewChat: (workspacePath: string) => void;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
  openFiles: string[];
  activeFilePath: string | null;
  diffView: { workspacePath: string; target: DiffTarget } | null;
  diffStatus: GitStatus | undefined;
  closeDiff: () => void;
}) {
  return (
    <>
      <div
        className={cx(
          "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
          activeFilePath || diffView
            ? "invisible absolute inset-0"
            : "relative min-w-0 flex-1 basis-0",
        )}
      >
        <ChatConversation
          active={active}
          engines={engines}
          workspaces={workspaces}
          startNewChat={startNewChat}
          composerInputRef={composerInputRef}
        />
      </div>

      {openFiles.length > 0 && (
        <div
          className={cx(
            "flex min-w-0 flex-col overflow-hidden bg-background-primary-default",
            activeFilePath && !diffView
              ? "relative min-w-0 flex-1 basis-0"
              : "invisible absolute inset-0",
          )}
        >
          <Suspense fallback={<CenteredSpinner />}>
            {openFiles.map((path) => (
              <div
                key={path}
                className={cx(
                  "min-h-0 flex-col",
                  path === activeFilePath
                    ? "flex flex-1"
                    : "invisible absolute inset-0",
                )}
              >
                <EditorPane path={path} />
              </div>
            ))}
          </Suspense>
        </div>
      )}

      {/* Center diff, opened from the changes panel's file rows. Its tab
          sits in the strip; ← or closing the tab returns to the chat. */}
      {diffView && (
        <div className="relative flex min-w-0 flex-1 basis-0 flex-col overflow-hidden bg-background-primary-default">
          <DiffView
            workspacePath={diffView.workspacePath}
            target={diffView.target}
            status={diffStatus}
            onBack={closeDiff}
          />
        </div>
      )}
    </>
  );
}
