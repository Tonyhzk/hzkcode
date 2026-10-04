import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  type Dispatch,
  type SetStateAction,
} from "react";
import { useTranslation } from "react-i18next";
import type { TFunction } from "i18next";
import { ipc, type CliConfig } from "@/lib/ipc";
import { newId } from "@/lib/id";
import {
  PSEUDO_LOCAL,
  notifyCliConfigChanged,
  providerEntries,
  type EngineId,
  type ProviderEntry,
} from "./providers";
import type { ProviderFormValue } from "./ProviderDialog";
import { errorText } from "@/lib/errors";
/** Add (no entry) or edit (with entry) dialog state. */
type DialogState = { entry?: ProviderEntry } | null;

export interface CliConfigState {
  t: TFunction;
  config: CliConfig | null;
  engine: EngineId;
  error: string | null;
  busy: boolean;
  dialog: DialogState;
  setDialog: Dispatch<SetStateAction<DialogState>>;
  pendingDelete: ProviderEntry | null;
  setPendingDelete: Dispatch<SetStateAction<ProviderEntry | null>>;
  currentId: string;
  entries: ProviderEntry[];
  mutate: <T>(fn: () => Promise<T>) => Promise<T | undefined>;
  activate: (id: string) => void;
  saveProvider: (value: ProviderFormValue) => void;
  confirmDelete: () => void;
}

/**
 * State + mutation funnel for CliConfigSection.
 *
 * Semantics (single source of truth is the backend's single `current`):
 *   - Each row carries a Switch showing whether it is current; flipping a
 *     switch on makes that channel current (single-select, radio-style).
 *     Flipping the current custom channel off falls back to 官方配置.
 *   - 官方配置 is the built-in fallback (the program's own config file),
 *     used whenever no channel is current.
 */
export function useCliConfig(engine: EngineId): CliConfigState {
  const { t } = useTranslation();
  const [config, setConfig] = useState<CliConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dialog, setDialog] = useState<DialogState>(null);
  const [pendingDelete, setPendingDelete] = useState<ProviderEntry | null>(null);
  useEffect(() => {
    let cancelled = false;
    ipc
      .getCliConfig()
      .then((c) => {
        if (!cancelled) setConfig(c);
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Mutations go through one funnel: run → tell the chat tree → re-read.
  // Re-reading after each write keeps the UI on the backend's persisted
  // state (map order, current) instead of drifting on optimistic copies.
  const mutate = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    try {
      const result = await fn();
      notifyCliConfigChanged();
      setConfig(await ipc.getCliConfig());
      setError(null);
      return result;
    } catch (e) {
      setError(errorText(e));
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);

  const section = config?.[engine];
  // Unset current uses the CLI's own configuration without a channel overlay.
  const currentId = section?.current || PSEUDO_LOCAL;
  const entries = useMemo(() => providerEntries(engine, section), [engine, section]);

  const activate = (id: string) => {
    if (id !== currentId) void mutate(() => ipc.setCurrentProvider(engine, id));
  };

  const saveProvider = (value: ProviderFormValue) => {
    const rawObj =
      dialog?.entry?.raw && typeof dialog.entry.raw === "object"
        ? (dialog.entry.raw as Record<string, unknown>)
        : {};
    // The dialog owns env/settingsConfig (JSON editor) and the custom model
    // list outright; unknown top-level keys (source, …) survive.
    const next: Record<string, unknown> = { ...rawObj };
    for (const key of [
      "name",
      "remark",
      "baseUrl",
      "apiKey",
      "model",
      "customModels",
      "settingsConfig",
      "env",
    ]) {
      delete next[key];
    }
    const put = (key: string, val: string) => {
      const trimmed = val.trim();
      if (trimmed) next[key] = trimmed;
    };
    put("name", value.name);
    put("remark", value.remark);
    put("baseUrl", value.baseUrl);
    put("apiKey", value.apiKey);
    if (value.customModels.length > 0) next.customModels = value.customModels;
    // The JSON editor is the source of truth for env; the flat `model`
    // field is migrated into it (HZKCODE_MODEL) at dialog open.
    try {
      const parsed: unknown = JSON.parse(value.settingsJson || "{}");
      if (parsed && typeof parsed === "object" && Object.keys(parsed).length > 0) {
        next.settingsConfig = parsed;
      }
    } catch {
      // The dialog blocks submit on invalid JSON.
    }
    const id = dialog?.entry?.id ?? newId();
    setDialog(null);
    void mutate(() => ipc.upsertProvider(engine, id, next));
  };

  const confirmDelete = () => {
    if (!pendingDelete) return;
    const id = pendingDelete.id;
    setPendingDelete(null);
    void mutate(() => ipc.deleteProvider(engine, id));
  };

  return {
    t,
    config,
    engine,
    error,
    busy,
    dialog,
    setDialog,
    pendingDelete,
    setPendingDelete,
    currentId,
    entries,
    mutate,
    activate,
    saveProvider,
    confirmDelete,
  };
}
