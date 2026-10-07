import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";

/** The 回退 choice modal: rewind the conversation (the next send truncates
 *  the transcript to this message), revert the workspace files to their
 *  state at it, or both. The file options appear only for user messages
 *  whose transcript actually carries a file-history snapshot — the
 *  per-message fact the CLI's own `fileHistoryCanRestore` checks. */
export function RewindDialog({
  engine,
  sessionId,
  target,
  onPick,
  onClose,
}: {
  engine: string;
  sessionId: string | null;
  target: { uuid: string; role: "user" | "assistant" };
  onPick: (mode: "conversation" | "files" | "both") => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  // Bound to the target uuid: a stale probe result from a previous target
  // must never enable the file options for the current one.
  const [filesState, setFilesState] = useState<{
    uuid: string;
    available: boolean;
  } | null>(null);
  const filesAvailable =
    target.role === "user" && sessionId && filesState?.uuid === target.uuid
      ? filesState.available
      : null;
  useEffect(() => {
    if (target.role !== "user" || !sessionId) return;
    let cancelled = false;
    ipc
      .sessionFileHistoryAvailable(engine, sessionId, target.uuid)
      .then((value) => {
        if (!cancelled) setFilesState({ uuid: target.uuid, available: value });
      })
      .catch(() => {
        if (!cancelled) setFilesState({ uuid: target.uuid, available: false });
      });
    return () => {
      cancelled = true;
    };
  }, [engine, sessionId, target]);

  const option =
    "w-full cursor-pointer rounded-lg border border-border-button-default px-3 py-2 text-left text-body-2-regular text-text-primary transition-colors hover:bg-background-secondary-hover";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-label={t("chat.rewindTitle")}
        className="w-[380px] rounded-2lg border border-border-button-default bg-background-primary-default p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-body-medium text-text-primary">
          {t("chat.rewindTitle")}
        </p>
        <p className="mt-1 text-body-2-regular text-text-tertiary">
          {t("chat.rewindDesc")}
        </p>
        <div className="mt-3 flex flex-col gap-1.5">
          <button
            type="button"
            className={option}
            onClick={() => onPick("conversation")}
          >
            {t("chat.rewindConversation")}
          </button>
          {target.role === "user" &&
            sessionId &&
            (filesAvailable === null ? null : filesAvailable ? (
              <>
                <button
                  type="button"
                  className={option}
                  onClick={() => onPick("files")}
                >
                  {t("chat.rewindFiles")}
                </button>
                <button
                  type="button"
                  className={option}
                  onClick={() => onPick("both")}
                >
                  {t("chat.rewindBoth")}
                </button>
              </>
            ) : (
              <p className="px-1 text-body-2-regular text-text-tertiary">
                {t("chat.rewindFilesUnavailable")}
              </p>
            ))}
        </div>
        <div className="mt-3 flex justify-end">
          <button
            type="button"
            onClick={onClose}
            className="cursor-pointer rounded-lg border border-border-button-default px-3 py-1 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover"
          >
            {t("common.cancel")}
          </button>
        </div>
      </div>
    </div>
  );
}
