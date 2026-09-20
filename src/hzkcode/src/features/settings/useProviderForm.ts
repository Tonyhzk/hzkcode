import { useState, type Dispatch, type SetStateAction } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import type { EngineId } from "./providers";
import type { ProviderFormValue } from "./ProviderDialog";
import {
  OFFICIAL_BASE_URL,
  PRESETS,
  claudeTemplateJson,
  findMatchedPreset,
  type ClaudeModelSlot,
  type ProviderPreset,
} from "./providerPresets";

const EMPTY_FORM: ProviderFormValue = {
  name: "",
  remark: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  settingsJson: "",
};

const EMPTY_SLOTS: Record<ClaudeModelSlot, string> = { sonnet: "", opus: "", haiku: "" };

/** Initial form state: seed the JSON editor from the stored settingsConfig
 *  (edit), the flat fields (legacy channels), or the official-direct
 *  template (add). */
function initialForm(initial?: ProviderFormValue): ProviderFormValue {
  const base: ProviderFormValue = { ...EMPTY_FORM, ...initial };
  if (base.settingsJson.trim()) return base;
  if (initial) {
    // Legacy flat channel: migrate its fields into the default template.
    const extra: Record<string, string> = {};
    if (base.model.trim()) extra.HZKCODE_MODEL = base.model.trim();
    return {
      ...base,
      settingsJson: claudeTemplateJson(base.baseUrl.trim(), base.apiKey.trim(), extra),
    };
  }
  // New channel: official direct selected, matching the reference dialog.
  return {
    ...base,
    baseUrl: OFFICIAL_BASE_URL,
    settingsJson: claudeTemplateJson(OFFICIAL_BASE_URL, ""),
  };
}

/** Claude model-slot values parsed out of a settings.json text. */
function slotsFromJson(settingsJson: string): Record<ClaudeModelSlot, string> {
  try {
    const parsed: unknown = JSON.parse(settingsJson);
    const env = (parsed as Record<string, unknown> | null)?.env;
    if (!env || typeof env !== "object") return { ...EMPTY_SLOTS };
    const read = (key: string) => {
      const v = (env as Record<string, unknown>)[key];
      return typeof v === "string" ? v : "";
    };
    return {
      sonnet: read("HZKCODE_DEFAULT_MID_MODEL"),
      opus: read("HZKCODE_DEFAULT_HIGH_MODEL"),
      haiku: read("HZKCODE_DEFAULT_LOW_MODEL"),
    };
  } catch {
    return { ...EMPTY_SLOTS };
  }
}

/**
 * Form state + mutations for ProviderDialog: the flat ProviderFormValue, the
 * claude model slots mirrored into the JSON editor both ways, preset
 * selection, 拉取模型, and validity/submit mapping. The dialog component
 * itself only wires these into the section components.
 */
export function useProviderForm({
  engine,
  initial,
  onSubmit,
}: {
  engine: EngineId;
  initial?: ProviderFormValue;
  onSubmit: (value: ProviderFormValue) => void;
}): ProviderForm {
  const { t } = useTranslation();
  const [value, setValue] = useState<ProviderFormValue>(() => initialForm(initial));
  // Model slots start empty on add (the template's env carries the defaults,
  // same as the reference); on edit they mirror the stored settings.json.
  const [slots, setSlots] = useState<Record<ClaudeModelSlot, string>>(() =>
    initial?.settingsJson ? slotsFromJson(initial.settingsJson) : { ...EMPTY_SLOTS },
  );
  const [jsonError, setJsonError] = useState("");
  const [fetchedModels, setFetchedModels] = useState<string[]>([]);
  const [fetching, setFetching] = useState(false);
  const [fetchError, setFetchError] = useState("");

  const presets = PRESETS[engine] ?? [];
  const patch = (p: Partial<ProviderFormValue>) => setValue((v) => ({ ...v, ...p }));

  // ── JSON <-> field sync ───────────────────────────────────────────────────

  /** Write one env key into the JSON editor's text. A text the user broke
   *  (invalid JSON) is left untouched — the editor error is already shown. */
  const updateClaudeEnv = (key: string, val: string) => {
    let parsed: Record<string, unknown>;
    try {
      parsed = value.settingsJson ? (JSON.parse(value.settingsJson) as Record<string, unknown>) : {};
    } catch {
      return;
    }
    const prevEnv = (parsed.env ?? {}) as Record<string, unknown>;
    const nextEnv = { ...prevEnv };
    if (val.trim()) nextEnv[key] = val;
    else delete nextEnv[key];
    const next =
      Object.keys(nextEnv).length > 0
        ? { ...parsed, env: nextEnv }
        : Object.fromEntries(Object.entries(parsed).filter(([k]) => k !== "env"));
    patch({ settingsJson: JSON.stringify(next, null, 2) });
    setJsonError("");
  };

  const onJsonChange = (text: string) => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const env = (parsed.env ?? {}) as Record<string, unknown>;
      const read = (key: string) => {
        const v = env[key];
        return typeof v === "string" ? v : "";
      };
      setSlots({
        sonnet: read("HZKCODE_DEFAULT_MID_MODEL"),
        opus: read("HZKCODE_DEFAULT_HIGH_MODEL"),
        haiku: read("HZKCODE_DEFAULT_LOW_MODEL"),
      });
      setValue((v) => ({
        ...v,
        settingsJson: text,
        baseUrl: read("HZKCODE_BASE_URL"),
        apiKey: read("HZKCODE_API_KEY"),
      }));
      setJsonError("");
    } catch {
      setValue((v) => ({ ...v, settingsJson: text }));
      setJsonError(t("settings.cliJsonError"));
    }
  };

  const handleFormatJson = () => {
    try {
      patch({ settingsJson: JSON.stringify(JSON.parse(value.settingsJson), null, 2) });
      setJsonError("");
    } catch {
      setJsonError(t("settings.cliJsonError"));
    }
  };

  // ── presets ───────────────────────────────────────────────────────────────

  const selectPreset = (preset: ProviderPreset) => {
    const slotEnv = preset.env ?? {};
    setSlots({
      sonnet: slotEnv.HZKCODE_DEFAULT_MID_MODEL ?? "",
      opus: slotEnv.HZKCODE_DEFAULT_HIGH_MODEL ?? "",
      haiku: slotEnv.HZKCODE_DEFAULT_LOW_MODEL ?? "",
    });
    setValue((v) => ({
      ...v,
      name: preset.name,
      baseUrl: preset.baseUrl,
      settingsJson: claudeTemplateJson(preset.baseUrl, v.apiKey.trim(), slotEnv),
    }));
    setJsonError("");
    resetFetch();
  };

  const selectOfficial = () => {
    setSlots({ ...EMPTY_SLOTS });
    setValue((v) => ({
      ...v,
      baseUrl: OFFICIAL_BASE_URL,
      settingsJson: claudeTemplateJson(OFFICIAL_BASE_URL, v.apiKey.trim()),
    }));
    setJsonError("");
    resetFetch();
  };

  const selectCustom = () => {
    setSlots({ ...EMPTY_SLOTS });
    setValue((v) => ({
      ...v,
      baseUrl: "",
      settingsJson: claudeTemplateJson("", v.apiKey.trim()),
    }));
    setJsonError("");
    resetFetch();
  };

  // ── fetch models ──────────────────────────────────────────────────────────

  function resetFetch() {
    setFetchedModels([]);
    setFetchError("");
  }

  const handleFetchModels = async () => {
    const baseUrl = value.baseUrl.trim();
    const apiKey = value.apiKey;
    if (!baseUrl) {
      setFetchError(t("settings.cliFetchModelsNeedUrl"));
      return;
    }
    setFetching(true);
    setFetchError("");
    try {
      const result = await ipc.fetchProviderModels(baseUrl, apiKey);
      setFetchedModels(result.models);
      if (result.models.length === 0) setFetchError(t("settings.cliFetchModelsEmpty"));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      setFetchError(message || t("settings.cliFetchModelsError"));
    } finally {
      setFetching(false);
    }
  };

  // ── validity & submit ─────────────────────────────────────────────────────

  const official = value.baseUrl === OFFICIAL_BASE_URL;
  const matchedPreset = findMatchedPreset(presets, value.baseUrl);

  const jsonValid = (() => {
    try {
      JSON.parse(value.settingsJson || "{}");
      return true;
    } catch {
      return false;
    }
  })();
  const valid = value.name.trim() !== "" && value.baseUrl.trim() !== "" && jsonValid;

  const submit = () => {
    if (!valid) return;
    onSubmit(value);
  };

  return {
    value,
    patch,
    slots,
    setSlots,
    jsonError,
    fetchedModels,
    fetching,
    fetchError,
    presets,
    official,
    matchedPreset,
    jsonValid,
    valid,
    updateClaudeEnv,
    onJsonChange,
    handleFormatJson,
    selectPreset,
    selectOfficial,
    selectCustom,
    handleFetchModels,
    submit,
  };
}

/** State + handler bundle returned by useProviderForm; the section
 *  components take it as a single `form` prop. */
export interface ProviderForm {
  value: ProviderFormValue;
  patch: (p: Partial<ProviderFormValue>) => void;
  slots: Record<ClaudeModelSlot, string>;
  setSlots: Dispatch<SetStateAction<Record<ClaudeModelSlot, string>>>;
  jsonError: string;
  fetchedModels: string[];
  fetching: boolean;
  fetchError: string;
  presets: ProviderPreset[];
  official: boolean;
  matchedPreset: ProviderPreset | undefined;
  jsonValid: boolean;
  valid: boolean;
  updateClaudeEnv: (key: string, val: string) => void;
  onJsonChange: (text: string) => void;
  handleFormatJson: () => void;
  selectPreset: (preset: ProviderPreset) => void;
  selectOfficial: () => void;
  selectCustom: () => void;
  handleFetchModels: () => Promise<void>;
  submit: () => void;
}
