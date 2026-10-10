import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { ipc } from "@/lib/ipc";

/** 删除消息确认 modal：删除会直接改写会话文件（该条目从转录移除、后续
 *  消息重接），不可恢复，所以先确认再执行；压缩前（归档段）的消息同样
 *  可删。失败按引擎返回的错误码映射为可读文案，保留对话框可重试。 */
export function DeleteMessageDialog({
  engine,
  sessionId,
  workspacePath,
  target,
  onDeleted,
  onClose,
}: {
  engine: string;
  sessionId: string;
  workspacePath: string;
  /** 要删除的转录条目 uuid。 */
  target: { uuid: string };
  /** 删除成功：刷新消息列表与回退锚点（返回 Promise 时等待完成再关闭）。 */
  onDeleted: () => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const messageFor = (code: string | null, detail: string): string => {
    const keys: Record<string, string> = {
      invalid_session: "chat.deleteErrInvalidSession",
      session_live: "chat.deleteErrSessionLive",
      rotation_pending: "chat.deleteErrRotationPending",
      not_found: "chat.deleteErrNotFound",
      not_deletable: "chat.deleteErrNotDeletable",
      file_changed: "chat.deleteErrFileChanged",
      write_failed: "chat.deleteErrWriteFailed",
      unsupported_platform: "chat.deleteErrUnsupported",
    };
    if (code && keys[code]) return t(keys[code]);
    return detail || t("chat.deleteErrUnknown");
  };

  const remove = async () => {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const outcome = await ipc.deleteMessage(
        engine,
        sessionId,
        workspacePath,
        target.uuid,
      );
      if (outcome.errorCode) {
        setError(messageFor(outcome.errorCode, outcome.detail));
        setBusy(false);
        return;
      }
      await onDeleted();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => {
        // 改写进行中时不关闭：避免用户以为取消了、实际文件已被改动。
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={t("chat.deleteTitle")}
        className="flex w-[440px] flex-col rounded-2lg border border-border-button-default bg-background-primary-default p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-body-medium text-text-primary">{t("chat.deleteTitle")}</p>
        <p className="mt-1 text-body-2-regular text-text-tertiary">
          {t("chat.deleteDesc")}
        </p>
        {error && (
          <p role="alert" className="mt-2 text-body-2-regular text-text-error-primary">
            {error}
          </p>
        )}
        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="small" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="danger"
            size="small"
            disabled={busy}
            onClick={() => void remove()}
          >
            {t("chat.deleteConfirm")}
          </Button>
        </div>
      </div>
    </div>
  );
}
