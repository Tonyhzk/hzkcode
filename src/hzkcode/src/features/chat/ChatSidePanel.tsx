import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import RefreshCw from "lucide-react/dist/esm/icons/refresh-cw";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { useFilesStore } from "@/features/files/store";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
import { pluginIdFromRegistryKey } from "@hzkcode/plugin-sdk";
import { cx } from "@/utils/cx";
import { PANEL_TOGGLE_CLASSES } from "./panel-toggle-classes";
import { resolveActivePanelTab, useSortedPanelTabs } from "./panel-tabs";
import type { ActiveSession } from "./store";

/** File-list column: files/changes tabs with their own header, and the
 * full-height resize strip on its left edge. Every registered tab's panel
 * stays mounted so tab switches preserve tree expansion and scroll state;
 * plugin tabs render inside a PluginBoundary (plan §4.2 #4). */
export function ChatSidePanel({
  active,
  panelRef,
  panelWidth,
  panelCollapsed,
  dragging,
  panelTab,
  onPanelTabChange,
  onResizeStart,
}: {
  active: ActiveSession | null;
  panelRef: React.RefObject<HTMLDivElement>;
  panelWidth: number;
  panelCollapsed: boolean;
  dragging: "sidebar" | "panel" | "editor" | null;
  panelTab: string;
  onPanelTabChange?: (tab: string) => void;
  onResizeStart: (e: React.PointerEvent) => void;
}) {
  const { t } = useTranslation();
  const panelTabs = useSortedPanelTabs();
  // Persisted tab may point at an unloaded plugin tab; fall back to the
  // first tab so the sidebar never renders fully hidden (read-side only).
  const activeTab = active ? resolveActivePanelTab(panelTabs, panelTab) : undefined;
  const treeRefreshing = useFilesStore((s) => s.refreshing);
  // Success flash: when a refresh finishes, swap the icon to a green check
  // for a beat (same pattern as the copy buttons' "copied" state).
  const [refreshed, setRefreshed] = useState(false);
  const wasRefreshing = useRef(false);
  useEffect(() => {
    if (treeRefreshing) {
      wasRefreshing.current = true;
      return;
    }
    if (!wasRefreshing.current) return;
    wasRefreshing.current = false;
    setRefreshed(true);
    const timer = setTimeout(() => setRefreshed(false), 1000);
    return () => clearTimeout(timer);
  }, [treeRefreshing]);
  if (!active) return null;
  return (
    <div
      ref={panelRef}
      className={cx(
        // Visibility is state-driven (width 0 when collapsed), never
        // breakpoint-gated: a narrow window auto-collapses in ChatPage, but an
        // explicit expand there must produce a real panel at any width.
        "relative flex shrink-0 overflow-hidden",
        // Width transition for collapse/expand; disabled mid-drag
        // since resizes mutate style.width imperatively.
        !dragging &&
          "transition-[width] duration-200 ease-out motion-reduce:transition-none",
      )}
      style={{ width: panelCollapsed ? 0 : panelWidth }}
    >
      {/* Panel resize strip: full height, straddling the border. */}
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label={t("chat.resizePanel")}
        title={t("chat.resizePanel")}
        onPointerDown={onResizeStart}
        className={cx(
          "group absolute inset-y-0 -left-1 z-30 w-2 cursor-col-resize touch-none",
          panelCollapsed && "hidden",
        )}
      >
        <span
          className={cx(
            "absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full bg-accent-300 opacity-0 transition-opacity group-hover:opacity-100",
            dragging === "panel" && "opacity-100",
          )}
        />
      </div>
      <div
        className={cx(
          "flex h-full w-full flex-col overflow-hidden border-separator-border bg-background-primary-default",
          !panelCollapsed && "border-l",
        )}
      >
        <div className="flex h-10 shrink-0 items-center gap-2 border-b border-separator-border px-2">
          <PillTabList>
            {panelTabs.map((tab) => (
              <PillTab
                key={tab.id}
                icon={tab.icon}
                isSelected={activeTab === tab.id}
                onSelect={() => onPanelTabChange?.(tab.id)}
              >
                {tab.label()}
              </PillTab>
            ))}
          </PillTabList>
          {activeTab === "files" && (
            <button
              type="button"
              title={t("common.refresh")}
              aria-label={t("common.refresh")}
              disabled={treeRefreshing}
              onClick={() => void useFilesStore.getState().refreshTree()}
              className={cx(PANEL_TOGGLE_CLASSES, "disabled:opacity-50")}
            >
              {refreshed ? (
                <Check
                  className="size-4 text-notification-success-foreground"
                  aria-hidden
                />
              ) : (
                <RefreshCw
                  className={cx("size-4", treeRefreshing && "animate-spin")}
                  aria-hidden
                />
              )}
            </button>
          )}
        </div>
        {/* All tab panels stay mounted so tab switches preserve tree
            expansion and scroll state. */}
        {panelTabs.map((tab) => {
          const TabComponent = tab.component;
          const panel = <TabComponent workspacePath={active.workspacePath} />;
          return (
            <div
              key={tab.id}
              className={cx(
                "min-h-0 flex-1",
                activeTab === tab.id ? "flex flex-col" : "hidden",
              )}
            >
              {tab.id.startsWith("plugin:") ? (
                // Plugin tabs get a crash boundary scoped to their plugin id.
                <PluginBoundary pluginId={pluginIdFromRegistryKey(tab.id)}>
                  {panel}
                </PluginBoundary>
              ) : (
                panel
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
