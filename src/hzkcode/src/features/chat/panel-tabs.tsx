import { useMemo } from "react";
import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import GitBranch from "lucide-react/dist/esm/icons/git-branch";
import History from "lucide-react/dist/esm/icons/history";
import i18n from "@/lib/i18n";
import {
  compareByOrder,
  panelTabRegistry,
  useRegistry,
  type PanelTabDef,
} from "@hzkcode/plugin-sdk";
import { FilesPanel } from "@/features/files/FilesPanel";
import { ChangesPanel } from "@/features/git/ChangesPanel";
import { HistoryPanel } from "@/features/git/HistoryPanel";

/**
 * Builtin right-panel tabs, registered through the same extension-point
 * registry plugins use (plan §4.2 #4 — files/changes are the dogfood
 * surface). Module-scope side effect, imported once by ChatPage; the
 * registry's upsert semantics make HMR re-runs harmless.
 */

/** ChangesPanel keeps its per-workspace remount (key) and full-width class
 *  exactly as it was inlined in ChatSidePanel. */
const ChangesTab = ({ workspacePath }: { workspacePath: string }) => (
  <ChangesPanel key={workspacePath} workspacePath={workspacePath} className="w-full" />
);

const HistoryTab = ({ workspacePath }: { workspacePath: string }) => (
  <HistoryPanel key={workspacePath} workspacePath={workspacePath} className="w-full" />
);

panelTabRegistry.register({
  id: "files",
  label: () => i18n.t("files.tab"),
  icon: FolderSymlink,
  order: 0,
  component: FilesPanel,
});
panelTabRegistry.register({
  id: "changes",
  label: () => i18n.t("git.changes"),
  icon: GitBranch,
  order: 1,
  component: ChangesTab,
});
panelTabRegistry.register({
  id: "history",
  label: () => i18n.t("git.history"),
  icon: History,
  order: 2,
  component: HistoryTab,
});

/** Registry entries in display order (compareByOrder: undefined order sorts
 *  last, ties by id). The panel header's pills and the mounted panels both
 *  read this list, so they always agree on tab order. */
export function useSortedPanelTabs(): PanelTabDef[] {
  const tabs = useRegistry(panelTabRegistry);
  return useMemo(() => [...tabs].sort(compareByOrder), [tabs]);
}

/** Read-side fallback for the persisted active tab: a plugin tab can vanish
 *  (plugin unloaded/quarantined) while its id stays in layout state, which
 *  would hide every panel and blank the sidebar. Resolve to the first tab
 *  instead. Deliberately NOT written back — the stale id re-resolves if the
 *  plugin returns. */
export function resolveActivePanelTab(
  tabs: PanelTabDef[],
  activeId: string,
): string | undefined {
  if (tabs.some((tab) => tab.id === activeId)) return activeId;
  return tabs[0]?.id;
}
