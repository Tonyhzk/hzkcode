import { useCallback, useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { useShallow } from "zustand/react/shallow";
import type { ComposerInputHandle } from "@/components/application/ai-chat/ai-chat-composer";
import { mentionToken } from "@/components/application/ai-chat/file-tags";
import { pickFiles } from "@/lib/platform";
import { useChatStore, type ActiveSession } from "../store";
import { recordPrompt } from "../prompt-history";
import { IMAGE_EXTENSIONS } from "./use-composer-images";

/** Composer submit/draft/attach/stop handlers plus the pending-@mention
 * bridge, so ChatConversation stays a composition layer. */
export function useComposerActions({
  active,
  sessionKey,
  streaming,
  images,
  clearImages,
  importImageFiles,
  supportsImages,
  composerInputRef,
}: {
  active: ActiveSession | null;
  sessionKey: string;
  streaming: boolean;
  images: string[];
  clearImages: () => void;
  importImageFiles: (paths: string[], supported: boolean) => void;
  supportsImages: boolean;
  composerInputRef: React.RefObject<ComposerInputHandle | null>;
}) {
  const { t } = useTranslation();
  const pendingMention = useChatStore((s) => s.pendingMention);
  // 会话控制写入期间不允许发送：避免身份/模式切换与新一轮请求交叉。
  const controlBusy = useChatStore((s) => s.controlBusy);
  const {
    setDraft,
    clearPendingMention,
    send,
    queueMessage,
    interrupt,
  } = useChatStore(
    useShallow((s) => ({
      setDraft: s.setDraft,
      clearPendingMention: s.clearPendingMention,
      send: s.send,
      queueMessage: s.queueMessage,
      interrupt: s.interrupt,
    })),
  );

  // 等待发送结果期间用户可能继续输入或添加附件；用最新值判断是否还该
  // 清理，不能直接清掉提交后才出现的内容。
  const imagesRef = useRef(images);
  imagesRef.current = images;

  const submit = useCallback(
    async (value: string) => {
      if (
        !active ||
        controlBusy ||
        (!value.trim() && images.length === 0)
      ) {
        return;
      }
      recordPrompt(value);
      // A turn is in flight: park the message in the session's queue; the
      // store drains it FIFO when the turn ends.
      if (streaming) {
        setDraft(sessionKey, "");
        clearImages();
        queueMessage(value, images);
        return;
      }
      const submittedImages = images;
      // 预检查可能拒绝发送；只有 store 确认接受后才清理，失败保留输入。
      const accepted = await send(value, submittedImages);
      if (!accepted) return;
      // 草稿由 store 在接受发送时清理；附件只清理本次提交的同一份数组。
      if (imagesRef.current === submittedImages) clearImages();
    },
    [
      active,
      controlBusy,
      images,
      streaming,
      sessionKey,
      setDraft,
      clearImages,
      send,
      queueMessage,
    ],
  );

  // File-tree "+" asks the composer to insert an @path mention at the caret.
  useEffect(() => {
    if (!pendingMention) return;
    clearPendingMention();
    const input = composerInputRef.current;
    if (!input) return;
    input.focus();
    input.insertText(`${mentionToken(pendingMention.path)} `);
  }, [pendingMention, clearPendingMention, composerInputRef]);

  const handleDraftChange = useCallback(
    (v: string) => setDraft(sessionKey, v),
    [sessionKey, setDraft],
  );

  // "Add → Files and folders": native multi-picker. Images flow through the
  // sandboxed image pipeline (chips); every other picked file becomes an
  // @mention at the caret — same as the file tree's "+" — so its content
  // stays live instead of a frozen sandbox copy.
  const handleAddAttachments = useCallback(() => {
    void (async () => {
      const picked = await pickFiles(t("chat.addFilesFolders"));
      if (picked.length === 0) return;
      const imagePaths: string[] = [];
      const mentionPaths: string[] = [];
      for (const path of picked) {
        const ext = path.split(".").pop()?.toLowerCase() ?? "";
        (IMAGE_EXTENSIONS.includes(ext) ? imagePaths : mentionPaths).push(path);
      }
      if (mentionPaths.length > 0) {
        const input = composerInputRef.current;
        if (input) {
          input.focus();
          input.insertText(`${mentionPaths.map(mentionToken).join(" ")} `);
        }
      }
      if (imagePaths.length > 0) importImageFiles(imagePaths, supportsImages);
    })();
  }, [t, composerInputRef, importImageFiles, supportsImages]);

  const handleStop = useCallback(() => void interrupt(), [interrupt]);
  const handlePickSkills = useCallback(
    () => composerInputRef.current?.openSlashPicker(),
    [composerInputRef],
  );

  return {
    submit,
    handleDraftChange,
    handleAddAttachments,
    handleStop,
    handlePickSkills,
  };
}
