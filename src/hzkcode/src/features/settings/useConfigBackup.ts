import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc, type ConfigBackupImportResult, type ConfigBackupPreview } from "@/lib/ipc";
import { isWeb, pickFile, pickSavePath } from "@/lib/platform";
import { windowContext } from "@/lib/window-context";
import { useChatStore } from "@/features/chat/store";
import { useFilesStore } from "@/features/files/store";
import { checkBackupStorage, collectBackupPreferences, restoreBackupPreferences } from "./backup-preferences";

const ERROR_KEYS: Record<string, string> = {
  backup_invalid: "backup.errors.invalid",
  password_invalid: "backup.errors.password",
  backup_version: "backup.errors.version",
  backup_too_large: "backup.errors.size",
  backup_stale: "backup.errors.stale",
  backup_busy: "backup.errors.busy",
  backup_desktop_only: "backup.errors.desktop",
  backup_decrypt_failed: "backup.errors.decrypt",
  backup_io: "backup.errors.io",
  backup_rollback_failed: "backup.errors.rollback",
  backup_path_invalid: "backup.errors.path",
  backup_crypto: "backup.errors.crypto",
  backup_restart_required: "backup.errors.restartRequired",
  backup_dirty: "backup.errors.dirty",
  backup_storage: "backup.errors.storage",
};

function assertImportIdle() {
  if (Object.keys(useFilesStore.getState().dirtyPaths).length > 0) throw new Error("backup_dirty");
  const chat = useChatStore.getState();
  if (Object.keys(chat.streamingByKey).length || Object.keys(chat.controlBusyByKey).length
    || Object.values(chat.bySession).some((session) => session.queue.length > 0)) {
    throw new Error("backup_busy");
  }
}

export function useConfigBackup() {
  const { t } = useTranslation();
  const [mode, setMode] = useState<"export" | "import" | null>(null);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [filePath, setFilePath] = useState("");
  const [preview, setPreview] = useState<ConfigBackupPreview | null>(null);
  const [result, setResult] = useState<ConfigBackupImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const working = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  const available = !isWeb && windowContext.kind === "main";
  const passwordValid = Array.from(password).length >= 8 && password.length <= 1024;
  const canSubmit = !busy && (mode === "export"
    ? passwordValid && password === confirmation
    : !!filePath && !!password);

  const messageFor = (error: unknown) => {
    const code = error instanceof Error ? error.message : String(error);
    return t(ERROR_KEYS[code] ?? "backup.errors.unknown");
  };

  const run = async (operation: () => Promise<void>) => {
    if (working.current || !available) return;
    working.current = true;
    setBusy(true);
    setError(null);
    try {
      await operation();
    } catch (e) {
      if (mounted.current) setError(messageFor(e));
    } finally {
      working.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const open = (next: "export" | "import") => {
    if (!available || working.current || result) return;
    setMode(next);
    setPassword("");
    setConfirmation("");
    setFilePath("");
    setPreview(null);
    setError(null);
    setExportedPath(null);
  };
  const close = () => {
    if (working.current || result) return;
    setMode(null);
    setPassword("");
    setConfirmation("");
    setPreview(null);
    setError(null);
  };
  const chooseFile = () => run(async () => {
    const path = await pickFile(t("backup.import"), [{ name: "HZK CODE", extensions: ["hzkbackup"] }]);
    if (path && mounted.current) {
      setFilePath(path);
      setPreview(null);
    }
  });
  const submit = () => {
    if (!canSubmit) return Promise.resolve();
    return run(async () => {
      if (mode === "export") {
        const defaultPath = `HZK-CODE-${new Date().toISOString().replace(/[:.]/g, "-")}.hzkbackup`;
        const selected = await pickSavePath(t("backup.export"), defaultPath);
        if (!selected || !mounted.current) return;
        const path = selected.toLowerCase().endsWith(".hzkbackup") ? selected : `${selected}.hzkbackup`;
        const saved = await ipc.configBackupExport(path, password, collectBackupPreferences());
        if (mounted.current) {
          setExportedPath(saved.path);
          setPassword("");
          setConfirmation("");
          setMode(null);
        }
      } else {
        assertImportIdle();
        const next = await ipc.configBackupPreview(filePath, password);
        if (mounted.current) {
          setPreview(next);
          setPassword("");
        }
      }
    });
  };

  const finishImport = async (imported: ConfigBackupImportResult) => {
    try {
      restoreBackupPreferences(imported.preferences);
    } catch {
      setError(t("backup.preferencesFailed"));
      return;
    }
    try {
      await ipc.restartApp();
    } catch {
      if (mounted.current) setError(t("backup.restartFailed"));
    }
  };
  const confirmImport = () => run(async () => {
    if (!preview || result) return;
    assertImportIdle();
    try {
      checkBackupStorage();
    } catch {
      throw new Error("backup_storage");
    }
    const imported = await ipc.configBackupImport(preview.token, collectBackupPreferences());
    // 后端已提交后只允许重试偏好恢复和重启，不再次导入。
    setResult(imported);
    setPreview(null);
    await finishImport(imported);
  });
  const restart = () => run(async () => {
    if (result) await finishImport(result);
  });
  const back = () => {
    if (working.current || result) return;
    setPreview(null);
    setPassword("");
    setError(null);
  };

  return {
    t, mode, password, setPassword, confirmation, setConfirmation,
    filePath, preview, result, busy, error, exportedPath, available, canSubmit,
    open, close, chooseFile, submit, confirmImport, restart, back,
  };
}
