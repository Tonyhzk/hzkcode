import { useRef } from "react";
import { useTranslation } from "react-i18next";
import Eye from "lucide-react/dist/esm/icons/eye";
import PencilLine from "lucide-react/dist/esm/icons/pencil-line";
import Save from "lucide-react/dist/esm/icons/save";
import { Button } from "@/components/base/buttons/button";
import { WindowControls } from "@/components/application/window-controls";
import { needsWindowControls, useTitlebarStyle } from "@/features/settings/titlebar";
import { useWindowDragRegion } from "@/hooks/use-window-drag";
import { IS_MAC, isWeb } from "@/lib/platform";
import { windowContext } from "@/lib/window-context";
import { cx } from "@/utils/cx";

export function FileEditorHeader({
  path,
  name,
  dirty,
  readOnly,
  isMarkdown,
  mdMode,
  onMdModeChange,
  saving,
  onSave,
}: {
  path: string;
  name: string;
  dirty: boolean;
  readOnly: boolean;
  isMarkdown: boolean;
  mdMode: "edit" | "preview";
  onMdModeChange: (mode: "edit" | "preview") => void;
  saving: boolean;
  onSave: () => void;
}) {
  const { t } = useTranslation();
  // The header doubles as the drag surface of a standalone editor window
  // (and of the editor dock's top row); buttons keep their own behavior.
  const headerRef = useRef<HTMLDivElement>(null);
  useWindowDragRegion(headerRef);
  const titlebarStyle = useTitlebarStyle();
  // A standalone editor window is a window of its own: on macOS the native
  // traffic lights float over its top-left corner (leave 80px), on Windows
  // 仿 mac 模式 the three dots are drawn here — no sidebar or top bar carries
  // them in this window. The dock's header (main / chat windows) stays as-is:
  // there the window chrome lives on the sidebar, not the editor.
  const standalone = windowContext.kind === "editor";
  const customControls = standalone && needsWindowControls(titlebarStyle);
  const trafficLightInset = standalone && IS_MAC && !isWeb;

  return (
    <div
      ref={headerRef}
      className={cx(
        "flex h-10 shrink-0 items-center gap-2 border-b border-border-button-default",
        trafficLightInset ? "pl-[80px] pr-3" : "px-3",
      )}
    >
      {customControls && <WindowControls className="mr-1" />}
      <span className="truncate text-body-medium text-text-primary" title={path}>
        {name}
      </span>
      {dirty && (
        <span className="shrink-0 rounded-sm bg-badge-neutral-background px-1.5 py-0.5 text-caption-1-medium text-text-secondary">
          {t("files.unsavedChanges")}
        </span>
      )}
      {readOnly && (
        <span className="shrink-0 text-caption-1-regular text-text-tertiary">
          {t("files.fileTruncated")}
        </span>
      )}
      <div className="flex-1" />
      {isMarkdown && (
        <div className="flex shrink-0 items-center rounded-lg border border-border-button-default">
          <button
            type="button"
            onClick={() => onMdModeChange("edit")}
            className={cx(
              "flex h-6 items-center gap-1 rounded-l-lg px-2 text-caption-1-medium",
              mdMode === "edit"
                ? "bg-background-tertiary-default text-text-primary"
                : "text-text-tertiary hover:text-text-primary",
            )}
          >
            <PencilLine className="size-3" aria-hidden />
            {t("files.editMode")}
          </button>
          <button
            type="button"
            onClick={() => onMdModeChange("preview")}
            className={cx(
              "flex h-6 items-center gap-1 rounded-r-lg px-2 text-caption-1-medium",
              mdMode === "preview"
                ? "bg-background-tertiary-default text-text-primary"
                : "text-text-tertiary hover:text-text-primary",
            )}
          >
            <Eye className="size-3" aria-hidden />
            {t("files.preview")}
          </button>
        </div>
      )}
      {!readOnly && (
        <Button
          variant="secondary"
          size="xs"
          leadingIcon={Save}
          disabled={!dirty || saving}
          onClick={() => void onSave()}
        >
          {t("files.saveFile")}
        </Button>
      )}
    </div>
  );
}
