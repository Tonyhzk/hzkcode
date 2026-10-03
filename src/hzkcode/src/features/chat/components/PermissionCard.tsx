import { useState } from "react";
import { useTranslation } from "react-i18next";
import Check from "lucide-react/dist/esm/icons/check";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import ShieldAlert from "lucide-react/dist/esm/icons/shield-alert";
import type { Message } from "@/lib/ipc";
import { sessionKey, useChatStore } from "../store";

/**
 * Tool-permission panel (dock form): the CLI parked a `can_use_tool` ask on
 * the control protocol and the turn only continues once the user approves or
 * denies it. Mirrors the AskUserQuestion dock — it takes over the composer
 * area instead of pushing chat content around.
 */
export function PermissionCard({ message }: { message: Message }) {
  const { t } = useTranslation();
  const respondToPermission = useChatStore((s) => s.respondToPermission);
  const active = useChatStore((s) => s.active);
  const [showInput, setShowInput] = useState(false);
  const key = active
    ? sessionKey(active.engine, active.sessionId, active.workspacePath)
    : "";
  const permission = message.permission;
  if (!permission) return null;
  const { toolName, title, description, input } = permission;
  const inputText = input === undefined ? "" : JSON.stringify(input, null, 2);
  const btn =
    "inline-flex cursor-pointer items-center gap-1 rounded-md px-2.5 py-1 text-caption-1-medium transition-colors";

  return (
    <div className="flex w-full flex-col gap-2.5 text-left">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <span className="rounded-md bg-background-tertiary-default px-1.5 py-0.5 text-caption-1-regular text-text-secondary">
          {toolName}
        </span>
        <span className="min-w-0 flex-1 truncate text-caption-1-medium text-text-primary">
          {title || t("chat.permissionAskTitle")}
        </span>
      </div>
      {description && (
        <p className="text-caption-1-regular text-text-secondary">
          {description}
        </p>
      )}
      {inputText && inputText !== "null" && (
        <div className="flex flex-col gap-1">
          <button
            type="button"
            onClick={() => setShowInput((v) => !v)}
            className="inline-flex cursor-pointer items-center gap-1 self-start text-caption-1-regular text-text-tertiary hover:text-text-secondary"
          >
            <ChevronDown
              className={`size-3.5 transition-transform ${showInput ? "" : "-rotate-90"}`}
              aria-hidden
            />
            {t("chat.permissionInput")}
          </button>
          {showInput && (
            <pre
              data-selectable
              className="max-h-40 overflow-auto rounded-md border border-border-secondary bg-background-tertiary-default px-2.5 py-2 text-caption-1-regular text-text-secondary"
            >
              {inputText}
            </pre>
          )}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-caption-1-regular text-text-tertiary">
          {t("chat.permissionWaiting")}
        </span>
        <div className="ml-auto flex items-center gap-2">
          <button
            type="button"
            onClick={() => key && void respondToPermission(key, message.seq, "deny")}
            className={`${btn} border border-border-secondary bg-background-secondary-default text-text-secondary hover:bg-background-tertiary-hover`}
          >
            {t("chat.permissionDeny")}
          </button>
          <button
            type="button"
            onClick={() => key && void respondToPermission(key, message.seq, "allow")}
            className={`${btn} bg-button-primary text-text-white`}
          >
            {t("chat.permissionAllow")}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Timeline record for a permission ask: while pending the interaction lives
 * in the dock that takes over the composer, so this row is only a muted
 * placeholder; once settled it becomes the read-only history entry.
 */
export function PermissionRecord({ message }: { message: Message }) {
  const { t } = useTranslation();
  const permission = message.permission;
  if (!permission) return null;
  const { status, toolName, title } = permission;
  return (
    <div className="flex max-w-[85%] flex-col gap-1 rounded-xl border border-border-secondary bg-background-secondary-default px-3.5 py-2.5 text-left">
      <div className="flex items-center gap-1.5 text-caption-1-medium text-text-secondary">
        <ShieldAlert
          className="size-3.5 shrink-0 text-foreground-icon-secondary"
          aria-hidden
        />
        {t("chat.permissionAskTitle")}
      </div>
      <div className="text-caption-1-regular text-text-primary">
        {title || toolName}
      </div>
      {status === "pending" && (
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.permissionWaiting")}
        </div>
      )}
      {status === "allowed" && (
        <div className="flex items-center gap-1 text-caption-1-regular text-text-secondary">
          <Check className="size-3" aria-hidden />
          {t("chat.permissionAllowed")}
        </div>
      )}
      {status === "denied" && (
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.permissionDenied")}
        </div>
      )}
      {status === "cancelled" && (
        <div className="text-caption-1-regular text-text-tertiary">
          {t("chat.permissionCancelled")}
        </div>
      )}
    </div>
  );
}
