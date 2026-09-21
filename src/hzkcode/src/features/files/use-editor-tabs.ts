import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";
import FileText from "lucide-react/dist/esm/icons/file-text";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import { useGitStore } from "@/features/git/store";
import { fileName, useFilesStore } from "./store";
import type { EditorTabItem } from "./EditorTab";

// File tabs of the editor dock; keys are prefixed so select/close handlers
// can route them to the files store.
export const FILE_TAB_PREFIX = "file:";
// The changes diff opens as a dock tab too; a single instance at a time.
export const DIFF_TAB_KEY = "diff:";

/** Editor-dock tab data: open files and the changes diff as tab items, the
 *  active key, and the select/close/reorder handlers. Unsaved files never
 *  close silently — dirty tabs route through `onDirtyClose`, and dragging a
 *  tab out of the window routes through `onDragOut`. */
export function useEditorTabs({
  onDirtyClose,
  onDragOut,
}: {
  onDirtyClose: (path: string) => void;
  onDragOut: (path: string, screenPosition: { x: number; y: number }) => void;
}) {
  const { openFiles, activeFilePath, dirtyPaths, activateFile, closeFile, moveOpenFile } =
    useFilesStore(
      useShallow((s) => ({
        openFiles: s.openFiles,
        activeFilePath: s.activeFilePath,
        dirtyPaths: s.dirtyPaths,
        activateFile: s.activateFile,
        closeFile: s.closeFile,
        moveOpenFile: s.moveOpenFile,
      })),
    );
  const diffView = useGitStore((s) => s.diffView);
  const closeDiff = useGitStore((s) => s.closeDiff);
  const diffStatus = useGitStore((s) =>
    s.diffView ? s.statusByWorkspace[s.diffView.workspacePath] : undefined,
  );

  const tabItems = useMemo<EditorTabItem[]>(
    () => [
      ...openFiles.map((path) => ({
        key: FILE_TAB_PREFIX + path,
        label: fileName(path),
        title: path,
        icon: FileText,
        dirty: !!dirtyPaths[path],
      })),
      ...(diffView
        ? [
            {
              key: DIFF_TAB_KEY,
              label: fileName(diffView.target.file),
              title: diffView.target.file,
              icon: GitBranch,
            },
          ]
        : []),
    ],
    [openFiles, dirtyPaths, diffView],
  );
  const activeKey = diffView
    ? DIFF_TAB_KEY
    : activeFilePath
      ? FILE_TAB_PREFIX + activeFilePath
      : null;

  const handleSelect = useCallback(
    (tabKey: string) => {
      // The diff tab is already the active dock view while diffView is set.
      if (tabKey === DIFF_TAB_KEY) return;
      if (tabKey.startsWith(FILE_TAB_PREFIX)) {
        activateFile(tabKey.slice(FILE_TAB_PREFIX.length));
      }
    },
    [activateFile],
  );

  const handleClose = useCallback(
    (tabKey: string) => {
      if (tabKey === DIFF_TAB_KEY) {
        closeDiff();
        return;
      }
      if (!tabKey.startsWith(FILE_TAB_PREFIX)) return;
      const path = tabKey.slice(FILE_TAB_PREFIX.length);
      if (dirtyPaths[path]) onDirtyClose(path);
      else closeFile(path);
    },
    [closeDiff, closeFile, dirtyPaths, onDirtyClose],
  );

  // Drag-reorder stays within the file group: the diff tab is pinned.
  const handleReorder = useCallback(
    (draggedKey: string, targetKey: string, before: boolean) => {
      if (draggedKey === DIFF_TAB_KEY || targetKey === DIFF_TAB_KEY) return;
      if (!draggedKey.startsWith(FILE_TAB_PREFIX) || !targetKey.startsWith(FILE_TAB_PREFIX)) {
        return;
      }
      const draggedPath = draggedKey.slice(FILE_TAB_PREFIX.length);
      const targetPath = targetKey.slice(FILE_TAB_PREFIX.length);
      const from = openFiles.indexOf(draggedPath);
      let to = openFiles.indexOf(targetPath) + (before ? 0 : 1);
      if (from >= 0 && from < to) to -= 1;
      moveOpenFile(draggedPath, to);
    },
    [openFiles, moveOpenFile],
  );

  // Close All: drop every tab. Dirty file tabs cannot be discarded silently —
  // close everything else first, then route the first dirty file through the
  // save-confirmation dialog (any others stay open and a repeat Close All
  // walks through them).
  const handleCloseAll = useCallback(() => {
    closeDiff();
    const dirty = openFiles.filter((path) => dirtyPaths[path]);
    for (const path of openFiles) {
      if (!dirtyPaths[path]) closeFile(path);
    }
    if (dirty[0]) onDirtyClose(dirty[0]);
  }, [closeDiff, openFiles, dirtyPaths, closeFile, onDirtyClose]);

  // Close Inactive: drop the tabs that are neither in view nor dirty.
  const handleCloseInactive = useCallback(() => {
    if (activeKey !== DIFF_TAB_KEY) closeDiff();
    const others = openFiles.filter((path) => FILE_TAB_PREFIX + path !== activeKey);
    const dirty = others.filter((path) => dirtyPaths[path]);
    for (const path of others) {
      if (!dirtyPaths[path]) closeFile(path);
    }
    if (dirty[0]) onDirtyClose(dirty[0]);
  }, [activeKey, openFiles, dirtyPaths, closeFile, closeDiff, onDirtyClose]);

  const handleDragOut = useCallback(
    (tabKey: string, screenPosition: { x: number; y: number }) => {
      if (tabKey === DIFF_TAB_KEY || !tabKey.startsWith(FILE_TAB_PREFIX)) return;
      onDragOut(tabKey.slice(FILE_TAB_PREFIX.length), screenPosition);
    },
    [onDragOut],
  );

  return {
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
  };
}
