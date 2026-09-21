import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { KeyboardEvent, PointerEvent as ReactPointerEvent, RefObject } from "react";
import { EditorTab, type EditorTabItem } from "./EditorTab";
import { EditorTabContextMenu } from "./EditorTabContextMenu";

/** Vertical wheel drives the horizontal tab scroll (VSCode behavior).
 * Native non-passive listener: React wheel handlers cannot preventDefault. */
function useHorizontalWheelScroll(scrollRef: RefObject<HTMLDivElement | null>) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (e.deltaX === 0 && e.deltaY === 0) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      el.scrollLeft += delta;
      e.preventDefault();
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [scrollRef]);
}

/** Keep the active tab in view as tabs stream in/out of the strip. */
function useActiveTabInView(
  scrollRef: RefObject<HTMLDivElement | null>,
  activeKey: string | null,
  tabCount: number,
) {
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !activeKey) return;
    // Match by dataset instead of a selector: file paths may contain quotes
    // and jsdom lacks CSS.escape.
    const active = Array.from(
      el.querySelectorAll<HTMLElement>("[data-tab-key]"),
    ).find((node) => node.dataset.tabKey === activeKey);
    active?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }, [scrollRef, activeKey, tabCount]);
}

/** Roving-tabindex tab list: Arrow keys move focus between tabs (selection
 * still requires Enter/Space, matching the platform tab convention). */
function handleTabListKeyDown(
  scrollRef: RefObject<HTMLDivElement | null>,
  e: KeyboardEvent<HTMLDivElement>,
) {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const el = scrollRef.current;
  if (!el) return;
  const tabEls = Array.from(el.querySelectorAll<HTMLElement>('[role="tab"]'));
  const current = tabEls.indexOf(document.activeElement as HTMLElement);
  if (current < 0) return;
  e.preventDefault();
  const next =
    e.key === "ArrowRight"
      ? (current + 1) % tabEls.length
      : (current - 1 + tabEls.length) % tabEls.length;
  tabEls[next]?.focus();
}

/** Tab strip of the file-editor dock: open files (and the changes diff) as
 * reorderable tabs. Tab drag state comes from the dock, which also renders
 * the drag-out hint over the content area. */
export function EditorTabStrip({
  tabs,
  activeKey,
  dropTarget,
  suppressClickRef,
  onSelect,
  onClose,
  onCloseAll,
  onCloseInactive,
  onTabPointerDown,
}: {
  tabs: EditorTabItem[];
  activeKey: string | null;
  dropTarget: { draggedKey: string; key: string; before: boolean } | null;
  suppressClickRef: React.MutableRefObject<boolean>;
  onSelect: (key: string) => void;
  onClose: (key: string) => void;
  /** Tab right-click menu entry: close every tab. Omit to hide the menu. */
  onCloseAll?: () => void;
  /** Tab right-click menu entry: close every tab but the one in view. */
  onCloseInactive?: () => void;
  onTabPointerDown: (key: string) => (e: ReactPointerEvent<HTMLDivElement>) => void;
}) {
  const { t } = useTranslation();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  useHorizontalWheelScroll(scrollRef);
  useActiveTabInView(scrollRef, activeKey, tabs.length);

  return (
    <div className="flex h-10 shrink-0 items-center border-b border-separator-border bg-background-primary-default select-none">
      <div
        ref={scrollRef}
        onKeyDown={(e) => handleTabListKeyDown(scrollRef, e)}
        className="group scrollbar-none flex min-w-0 flex-1 items-center overflow-x-auto px-2"
      >
        <div role="tablist" aria-label="tabs" className="flex min-w-0 items-center gap-1">
          {tabs.map((tab) => (
            <EditorTab
              key={tab.key}
              tab={tab}
              isActive={tab.key === activeKey}
              dragged={dropTarget?.draggedKey === tab.key}
              dropBefore={dropTarget?.key === tab.key ? dropTarget.before : null}
              closeLabel={t("common.close")}
              onShowMenu={onCloseAll || onCloseInactive ? setMenu : undefined}
              onSelect={onSelect}
              onClose={onClose}
              onPointerDown={onTabPointerDown(tab.key)}
              suppressClickRef={suppressClickRef}
            />
          ))}
        </div>
      </div>
      <EditorTabContextMenu
        menu={menu}
        onCloseAll={onCloseAll}
        onCloseInactive={onCloseInactive}
        onDismiss={() => setMenu(null)}
      />
    </div>
  );
}
