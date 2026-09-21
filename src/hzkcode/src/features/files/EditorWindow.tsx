import { lazy, Suspense, useEffect } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { CenteredSpinner } from "@/components/base/empty-state";
import { isWeb } from "@/lib/platform";
import { fileName, useFilesStore } from "./store";

const EditorPane = lazy(() => import("./EditorPane"));

/** Standalone editor window (?ctx=editor&filePath=…): one file, full window.
 *  The file opens into this window's own files store, so edits and drafts
 *  stay independent from the main window's editor dock. */
export function EditorWindow({ filePath }: { filePath: string }) {
  useEffect(() => {
    void useFilesStore.getState().openFile(filePath);
  }, [filePath]);
  // Window title follows the file name.
  useEffect(() => {
    const name = fileName(filePath);
    if (isWeb) {
      document.title = name;
      return;
    }
    void getCurrentWindow()
      .setTitle(name)
      .catch(() => {});
  }, [filePath]);

  return (
    <div className="flex h-dvh w-full flex-col overflow-hidden bg-background-primary-default">
      <Suspense fallback={<CenteredSpinner />}>
        <EditorPane path={filePath} />
      </Suspense>
    </div>
  );
}
