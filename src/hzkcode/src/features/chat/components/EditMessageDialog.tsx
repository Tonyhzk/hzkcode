import { useState } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { TextArea } from "@/components/base/input/textarea";
import { ipc } from "@/lib/ipc";

/** 编辑消息 modal：重写一条用户消息的文本（引擎的 `--edit-message`，就地
 *  只改文本、不重新生成回复）。归档段消息可编辑，但压缩摘要不会随之更新
 *  ——成功后留在对话框里提示，确认后再关闭。失败按引擎返回的错误码映射为
 *  可读文案，保留草稿以便修正重试。 */
export function EditMessageDialog({
  engine,
  sessionId,
  workspacePath,
  target,
  onSaved,
  onClose,
}: {
  engine: string;
  sessionId: string;
  workspacePath: string;
  /** uuid、正文（编辑框初值）与需原样保留的隐藏尾块（旧身份块）。 */
  target: { uuid: string; text: string; tail?: string };
  /** 保存成功：把新文本落到内存（磁盘已由编辑命令改好）。返回的 Promise
   *  在可回退集合刷新（含失效回退点清理）完成后 resolve——保存流程会等它
   *  完成再关闭对话框，避免随即重试/继续时读到旧的待回退点。 */
  onSaved: (uuid: string, text: string) => void | Promise<void>;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState(target.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [archived, setArchived] = useState(false);

  const messageFor = (code: string | null, detail: string): string => {
    const keys: Record<string, string> = {
      invalid_session: "chat.editErrInvalidSession",
      session_live: "chat.editErrSessionLive",
      rotation_pending: "chat.editErrRotationPending",
      not_found: "chat.editErrNotFound",
      not_editable: "chat.editErrNotEditable",
      file_changed: "chat.editErrFileChanged",
      write_failed: "chat.editErrWriteFailed",
      unsupported_platform: "chat.editErrUnsupported",
    };
    if (code && keys[code]) return t(keys[code]);
    return detail || t("chat.editErrUnknown");
  };

  const save = async () => {
    // Emptiness is judged on the trimmed draft, but the original text is
    // what gets saved — leading indentation and trailing newlines of a
    // message (pasted code, for one) must survive verbatim.
    const body = draft;
    if (!body.trim() || busy) return;
    setBusy(true);
    setError("");
    try {
      // 旧历史的身份尾块对界面隐藏但仍属于原始文本：保存时原样拼回，
      // 一次正文编辑不该把它（或同条消息里的图片等其他块）删掉。
      const full = target.tail
        ? `${body.replace(/\s+$/, "")}\n\n${target.tail.replace(/^\s+/, "")}`
        : body;
      const outcome = await ipc.editMessage(
        engine,
        sessionId,
        workspacePath,
        target.uuid,
        full,
      );
      if (outcome.errorCode) {
        setError(messageFor(outcome.errorCode, outcome.detail));
        setBusy(false);
        return;
      }
      await onSaved(target.uuid, full);
      if (outcome.archived) {
        setArchived(true);
        setBusy(false);
        return;
      }
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
        // While the one-shot edit runs, closing would let the file change
        // behind a user who believes they cancelled.
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={t("chat.editTitle")}
        className="flex w-[480px] flex-col rounded-2lg border border-border-button-default bg-background-primary-default p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-body-medium text-text-primary">{t("chat.editTitle")}</p>
        <p className="mt-1 text-body-2-regular text-text-tertiary">
          {t("chat.editDesc")}
        </p>
        {archived && (
          <p
            role="status"
            className="mt-2 text-body-2-regular text-text-warning-primary"
          >
            {t("chat.editArchivedNote")}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-body-2-regular text-text-error-primary">
            {error}
          </p>
        )}
        <TextArea
          rows={6}
          spellCheck={false}
          aria-label={t("chat.editTitle")}
          value={draft}
          onChange={setDraft}
          isDisabled={archived || busy}
          inputClassName="mt-3"
        />
        <div className="mt-3 flex justify-end gap-2">
          {archived ? (
            <Button variant="primary" size="small" onClick={onClose}>
              {t("common.close")}
            </Button>
          ) : (
            <>
              <Button
                variant="secondary"
                size="small"
                disabled={busy}
                onClick={onClose}
              >
                {t("common.cancel")}
              </Button>
              <Button
                variant="primary"
                size="small"
                disabled={busy || !draft.trim()}
                onClick={() => void save()}
              >
                {t("common.save")}
              </Button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
