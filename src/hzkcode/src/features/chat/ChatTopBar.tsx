import { useRef } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { useTranslation } from "react-i18next";
import { getCurrentWindow } from "@tauri-apps/api/window";
import Columns2 from "lucide-react/dist/esm/icons/columns-2";
import PanelLeftOpen from "lucide-react/dist/esm/icons/panel-left-open";
import PanelRightClose from "lucide-react/dist/esm/icons/panel-right-close";
import PanelRightOpen from "lucide-react/dist/esm/icons/panel-right-open";
import { WindowControls } from "@/components/application/window-controls";
import { HeaderOpenActions } from "@/features/open-app/HeaderOpenActions";
import { needsWindowControls, useTitlebarStyle } from "@/features/settings/titlebar";
import { IS_MAC, isWeb } from "@/lib/platform";
import { cx } from "@/utils/cx";
import { DRAG_IGNORE_SELECTOR, useWindowDragRegion } from "@/hooks/use-window-drag";
import { PANEL_TOGGLE_CLASSES } from "./panel-toggle-classes";

/** Top bar of the conversation column: the active session's title, the
 *  open-in-app cluster, and the panel/editor collapse toggles. Doubles as the
 *  window drag surface (overlay titlebar) — with the sidebar expanded its own
 *  drag strip owns the traffic-light corner, so this bar only reserves the
 *  inset once the sidebar is collapsed. */
export function ChatTopBar({
  title,
  workspacePath,
  sidebarCollapsed,
  onToggleSidebar,
  editorCollapsed,
  onToggleEditor,
  panelCollapsed,
  onTogglePanel,
}: {
  title: string;
  workspacePath?: string;
  sidebarCollapsed: boolean;
  onToggleSidebar: () => void;
  editorCollapsed: boolean;
  onToggleEditor: () => void;
  panelCollapsed: boolean;
  onTogglePanel: () => void;
}) {
  const { t } = useTranslation();
  const barRef = useRef<HTMLDivElement>(null);
  const titlebarStyle = useTitlebarStyle();
  const customControls = needsWindowControls(titlebarStyle);
  useWindowDragRegion(barRef);
  const trafficLightInset = (IS_MAC || customControls) && sidebarCollapsed && !isWeb;

  // Double-click on empty bar space maximizes/restores (custom Windows
  // titlebar convention; macOS keeps its native zoom behavior).
  const handleDoubleClick = (e: ReactMouseEvent) => {
    if (isWeb || !customControls) return;
    if ((e.target as HTMLElement).closest(DRAG_IGNORE_SELECTOR)) return;
    void getCurrentWindow().toggleMaximize();
  };

  const editorLabel = t(
    editorCollapsed ? "chat.showFileEditor" : "chat.hideFileEditor",
  );
  const panelLabel = t(panelCollapsed ? "openApp.expandPanel" : "openApp.collapsePanel");

  return (
    <div
      ref={barRef}
      data-tauri-drag-region
      onDoubleClick={handleDoubleClick}
      className={cx(
        "flex h-10 shrink-0 items-center border-b border-separator-border bg-background-primary-default select-none",
        trafficLightInset && "pl-[80px]",
      )}
    >
      {customControls && sidebarCollapsed && (
        <div className="flex h-full shrink-0 items-center pl-3 pr-4">
          <WindowControls />
        </div>
      )}
      {sidebarCollapsed && (
        <button
          type="button"
          title={t("chat.expandSidebar")}
          aria-label={t("chat.expandSidebar")}
          onClick={onToggleSidebar}
          className={cx(PANEL_TOGGLE_CLASSES, "ml-2")}
        >
          <PanelLeftOpen className="size-4" aria-hidden />
        </button>
      )}
      <span
        className="ml-3 min-w-0 truncate text-body-medium text-text-primary"
        title={title}
      >
        {title}
      </span>
      <div className="min-w-2 flex-1" data-tauri-drag-region />
      {workspacePath && <HeaderOpenActions workspacePath={workspacePath} />}
      <button
        type="button"
        title={editorLabel}
        aria-label={editorLabel}
        aria-pressed={!editorCollapsed}
        onClick={onToggleEditor}
        className={cx(PANEL_TOGGLE_CLASSES, "mx-1")}
      >
        <Columns2 className="size-4" aria-hidden />
      </button>
      <button
        type="button"
        title={panelLabel}
        aria-label={panelLabel}
        onClick={onTogglePanel}
        className={cx(PANEL_TOGGLE_CLASSES, "mr-2")}
      >
        {panelCollapsed ? (
          <PanelRightOpen className="size-4" aria-hidden />
        ) : (
          <PanelRightClose className="size-4" aria-hidden />
        )}
      </button>
    </div>
  );
}
