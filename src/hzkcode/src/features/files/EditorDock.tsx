import { lazy, Suspense } from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { CenteredSpinner, EmptyState } from "@/components/base/empty-state";
import { DiffView } from "@/features/git/DiffView";
import { cx } from "@/utils/cx";
import { EditorTabFace } from "./EditorTab";
import { EditorTabStrip } from "./EditorTabStrip";
import { useEditorTabDrag } from "./editor-tab-drag";
import { useEditorTabs } from "./use-editor-tabs";

// CodeMirror + react-markdown are heavy; split them out of the startup chunk.
const EditorPane = lazy(() => import("./EditorPane"));

/** Right-most column: the multi-tab file editor. Open files (and the
 *  changes diff) live here as tabs — the conversation column never cedes its
 *  space to an editor. Files stay mounted while other tabs are in view so
 *  scroll positions and drafts survive tab switches. Dragging a tab against
 *  a window edge moves it into a standalone editor window instead. */
export function EditorDock({
  width,
  collapsed,
  dragging,
  dockRef,
  onResizeStart,
  onDirtyClose,
  onDragOut,
}: {
  /** Rendered width in px (already clamped against the row's other columns). */
  width: number;
  collapsed: boolean;
  dragging: "sidebar" | "panel" | "editor" | null;
  dockRef: React.RefObject<HTMLDivElement>;
  onResizeStart: (e: React.PointerEvent) => void;
  /** Unsaved tab close confirmation (owned by the page's dialog host). */
  onDirtyClose: (path: string) => void;
  /** Tab dragged out of the window; the page moves it to a new window at the
   *  drop point. */
  onDragOut: (path: string, screenPosition: { x: number; y: number }) => void;
}) {
  const { t } = useTranslation();
  const {
    tabItems,
    activeKey,
    handleSelect,
    handleClose,
    handleReorder,
    handleCloseAll,
    handleCloseInactive,
    handleDragOut,
    openFiles,
    activeFilePath,
    diffView,
    diffStatus,
    closeDiff,
  } = useEditorTabs({ onDirtyClose, onDragOut });
  const {
    draggedKey,
    dragGhost,
    dropTarget,
    dragOutActive,
    suppressClickRef,
    handleTabDragStart,
    handleTabDragEnd,
  } = useEditorTabDrag({
    onReorder: handleReorder,
    onDragOut: handleDragOut,
  });
  const dragGhostTab = dragGhost
    ? tabItems.find((tab) => tab.key === dragGhost.key)
    : undefined;
  const empty = openFiles.length === 0 && !diffView;

  return (
    <div
      ref={dockRef}
      className={cx(
        // Visibility is state-driven (width 0 when collapsed), never
        // breakpoint-gated: narrow windows clamp the width in ChatPage.
        "relative flex shrink-0 overflow-hidden",
        // Width transition for collapse/expand; disabled mid-drag
        // since resizes mutate style.width imperatively.
        !dragging &&
          "transition-[width] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ width: collapsed ? 0 : width }}
    >
      {/* Dock resize strip: full height, straddling the border. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chat.resizeFileEditor")}
        title={t("chat.resizeFileEditor")}
        onPointerDown={onResizeStart}
        className={cx(
          "group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none",
          collapsed && "hidden",
        )}
      >
        <span
          className={cx(
            "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent-300 opacity-0 transition-opacity group-hover:opacity-100",
            dragging === "editor" && "opacity-100",
          )}
        />
      </div>
      <div
        className={cx(
          "flex h-full w-full flex-col overflow-hidden border-separator-border bg-background-primary-default",
          !collapsed && "border-l",
        )}
      >
        <EditorTabStrip
          tabs={tabItems}
          activeKey={activeKey}
          draggedKey={draggedKey}
          dropTarget={dropTarget}
          suppressClickRef={suppressClickRef}
          onSelect={handleSelect}
          onClose={handleClose}
          onCloseAll={handleCloseAll}
          onCloseInactive={handleCloseInactive}
          onTabDragStart={handleTabDragStart}
          onTabDragEnd={handleTabDragEnd}
        />
        <div
          id="editor-tabpanel"
          role="tabpanel"
          className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
        >
          {openFiles.length > 0 && (
            <Suspense fallback={<CenteredSpinner />}>
              {openFiles.map((path) => (
                <div
                  key={path}
                  className={cx(
                    "min-h-0 flex-col",
                    path === activeFilePath && !diffView
                      ? "flex min-w-0 flex-1 basis-0"
                      : "invisible absolute inset-0",
                  )}
                >
                  <EditorPane path={path} />
                </div>
              ))}
            </Suspense>
          )}
          {diffView && (
            <div className="flex min-h-0 min-w-0 flex-1 basis-0 flex-col overflow-hidden">
              <DiffView
                workspacePath={diffView.workspacePath}
                target={diffView.target}
                status={diffStatus}
                onBack={closeDiff}
              />
            </div>
          )}
          {empty && (
            <EmptyState className="flex-col gap-2 p-6">
              <p className="text-body-medium text-text-tertiary">
                {t("files.editorEmpty")}
              </p>
            </EmptyState>
          )}
          {dragOutActive && (
            <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center bg-background-secondary-default/80 p-4">
              <p className="rounded-xl border border-border-button-default bg-background-primary-default px-4 py-3 text-body-medium text-text-secondary shadow-lg">
                {t("files.dragOutHint")}
              </p>
            </div>
          )}
        </div>
      </div>
      {/* Ghost card riding under the pointer during a tab drag: the system
          drag image is transparent (to hide the platform's cancel
          animation), so this is the visible feedback. Portalled to the body
          so the dock's overflow-hidden can never clip it. */}
      {dragGhost && dragGhostTab
        ? createPortal(
            <div
              aria-hidden
              className="pointer-events-none fixed z-50 flex h-7 items-center gap-1.5 rounded-lg border border-border-button-default bg-background-primary-default px-2.5 text-body-medium text-text-primary shadow-lg"
              style={{
                left: dragGhost.x,
                top: dragGhost.y,
                width: dragGhost.width || undefined,
              }}
            >
              <EditorTabFace tab={dragGhostTab} />
            </div>,
            document.body,
          )
        : null}
    </div>
  );
}
