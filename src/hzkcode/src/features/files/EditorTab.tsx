import X from "lucide-react/dist/esm/icons/x";
import { useTranslation } from "react-i18next";
import type { PointerEvent as ReactPointerEvent } from "react";
import type { LucideIcon } from "lucide-react";
import { cx } from "@/utils/cx";

export interface EditorTabItem {
  key: string;
  label: string;
  /** Tooltip; defaults to the label. */
  title?: string;
  icon?: LucideIcon;
  /** Unsaved-changes dot before the label. */
  dirty?: boolean;
}

/** Tab face — icon, dirty dot, label — shared by the strip's tab and the
 *  drag ghost the dock floats under the pointer. */
export function EditorTabFace({ tab }: { tab: EditorTabItem }) {
  const { t } = useTranslation();
  return (
    <>
      {tab.icon && (
        <tab.icon
          className="size-3 shrink-0 text-foreground-icon-secondary"
          aria-hidden
        />
      )}
      {tab.dirty && (
        <span
          role="status"
          aria-label={t("files.unsavedChanges")}
          title={t("files.unsavedChanges")}
          className="h-1.5 w-1.5 shrink-0 rounded-full bg-foreground-icon-primary"
        />
      )}
      <span className="truncate">{tab.label}</span>
    </>
  );
}

/** One tab of the file-editor dock: icon, dirty dot, label, drop indicator,
 *  close button. Selection lives on the tab; the close button sits beside it
 *  so no focusable control nests inside the tab. */
export function EditorTab({
  tab,
  isActive,
  dragged,
  dropBefore,
  closeLabel,
  onShowMenu,
  onSelect,
  onClose,
  onPointerDown,
  suppressClickRef,
}: {
  tab: EditorTabItem;
  isActive: boolean;
  /** This tab is the one being drag-reordered. */
  dragged: boolean;
  /** Drop indicator side, null when this tab is not the drop target. */
  dropBefore: boolean | null;
  closeLabel: string;
  /** Right-click menu anchor; omitted when the strip has no tab menu. */
  onShowMenu?: (position: { x: number; y: number }) => void;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  onPointerDown?: (e: ReactPointerEvent<HTMLDivElement>) => void;
  suppressClickRef: React.MutableRefObject<boolean>;
}) {
  return (
    <div
      data-tab-key={tab.key}
      role="presentation"
      title={tab.title ?? tab.label}
      onContextMenu={(e) => {
        if (!onShowMenu) return;
        e.preventDefault();
        onShowMenu({ x: e.clientX, y: e.clientY });
      }}
      className={cx(
        "group relative flex h-7 max-w-48 shrink-0 cursor-default items-center gap-1.5 rounded-lg px-2.5 text-body-medium transition-colors",
        dragged && "opacity-50",
        isActive
          ? "bg-background-secondary-default text-text-primary"
          : "text-text-tertiary hover:bg-background-secondary-hover hover:text-text-secondary",
      )}
    >
      <div
        role="tab"
        aria-selected={isActive}
        aria-controls="editor-tabpanel"
        tabIndex={isActive ? 0 : -1}
        onClick={() => {
          if (suppressClickRef.current) {
            suppressClickRef.current = false;
            return;
          }
          onSelect(tab.key);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onSelect(tab.key);
          }
        }}
        onAuxClick={(e) => {
          if (e.button === 1) onClose(tab.key);
        }}
        onPointerDown={onPointerDown}
        className="flex min-w-0 flex-1 cursor-default items-center gap-1.5"
      >
        <EditorTabFace tab={tab} />
      </div>
      {dropBefore !== null && (
        <span
          aria-hidden
          className={cx(
            "pointer-events-none absolute top-1 bottom-1 w-0.5 rounded-full bg-accent-500",
            dropBefore ? "-left-[3px]" : "-right-[3px]",
          )}
        />
      )}
      <button
        type="button"
        aria-label={closeLabel}
        onClick={(e) => {
          e.stopPropagation();
          onClose(tab.key);
        }}
        className={cx(
          "flex h-4 w-4 shrink-0 items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-tertiary-hover hover:text-foreground-icon-primary",
          // Keyboard users must see the button when it has focus, not
          // only on pointer hover.
          isActive ? "opacity-100" : "opacity-0 group-hover:opacity-100 focus-visible:opacity-100",
        )}
      >
        <X className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}
