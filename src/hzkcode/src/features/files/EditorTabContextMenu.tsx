import X from "lucide-react/dist/esm/icons/x";
import CircleX from "lucide-react/dist/esm/icons/circle-x";
import { useTranslation } from "react-i18next";
import { ContextMenu } from "@/components/context-menu";

/** Editor tab right-click menu: close-inactive / close-all, anchored at the
 * pointer like every other context menu in the app. */
export function EditorTabContextMenu({
  menu,
  onCloseAll,
  onCloseInactive,
  onDismiss,
}: {
  /** Anchor position; null when the menu is closed. */
  menu: { x: number; y: number } | null;
  onCloseAll?: () => void;
  onCloseInactive?: () => void;
  onDismiss: () => void;
}) {
  const { t } = useTranslation();
  if (!menu || (!onCloseAll && !onCloseInactive)) return null;
  return (
    <ContextMenu
      x={menu.x}
      y={menu.y}
      ariaLabel={t("chat.closeAllTabs")}
      entries={[
        ...(onCloseInactive
          ? [
              {
                id: "close-inactive",
                label: t("chat.closeInactiveTabs"),
                icon: <CircleX className="size-4" aria-hidden />,
                onSelect: onCloseInactive,
              },
            ]
          : []),
        ...(onCloseInactive && onCloseAll ? ["separator" as const] : []),
        ...(onCloseAll
          ? [
              {
                id: "close-all",
                label: t("chat.closeAllTabs"),
                icon: <X className="size-4" aria-hidden />,
                onSelect: onCloseAll,
              },
            ]
          : []),
      ]}
      onClose={onDismiss}
    />
  );
}
