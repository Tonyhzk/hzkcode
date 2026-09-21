import { openEditorWindow } from "@/lib/window-actions";
import { useFilesStore } from "./store";

/** Move an open file tab into a standalone editor window: the new window
 *  loads the file from disk, then the tab closes here (move semantics, like
 *  dragging a browser tab out). */
export async function moveFileToNewWindow(path: string): Promise<void> {
  const opened = await openEditorWindow(path);
  if (opened) useFilesStore.getState().closeFile(path);
}
