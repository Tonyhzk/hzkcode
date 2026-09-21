import { openEditorWindow, rememberEditorTabMovedOut } from "@/lib/window-actions";
import { useFilesStore } from "./store";

/** Move an open file tab into a standalone editor window: the new window
 *  loads the file from disk, then the tab closes here (move semantics, like
 *  dragging a browser tab out). Closing that window later hands the tab back
 *  to this one. `screenPosition` opens the window where the tab was dropped. */
export async function moveFileToNewWindow(
  path: string,
  screenPosition?: { x: number; y: number },
): Promise<void> {
  const opened = await openEditorWindow(path, screenPosition);
  if (opened) {
    rememberEditorTabMovedOut(path);
    useFilesStore.getState().closeFile(path);
  }
}
