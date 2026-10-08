import { useState } from "react";
import { useTranslation } from "react-i18next";
import { ipc } from "@/lib/ipc";
import { migrateChannelEnv, type EngineId } from "./providers";
import type { ProviderFormValue } from "./ProviderDialog";
import {
  CLAUDE_ENV_FIELD_KEYS,
  OFFICIAL_BASE_URL,
  PRESETS,
  claudeTemplateJson,
  findMatchedPreset,
  type ProviderPreset,
} from "./providerPresets";

const EMPTY_FORM: ProviderFormValue = {
  name: "",
  remark: "",
  baseUrl: "",
  apiKey: "",
  model: "",
  customModels: [],
  settingsJson: "",
};

/** The dialog's channel controls seed from (and write back into) the
 *  settings.json env the channel stores. */
function emptyEnvValues(): Record<string, string> {
  return Object.fromEntries(CLAUDE_ENV_FIELD_KEYS.map((key) => [key, ""]));
}

function envValuesFrom(settingsJson: string): Record<string, string> {
  const values = emptyEnvValues();
  try {
    const env = (
      JSON.parse(settingsJson) as { env?: Record<string, unknown> } | null
    )?.env;
    if (!env) return values;
    for (const key of CLAUDE_ENV_FIELD_KEYS) {
      const value = env[key];
      if (typeof value === "string") values[key] = value;
    }
  } catch {
    // Broken JSON: the editor's own error state covers it.
  }
  return values;
}

function presetEnvValues(env: Record<string, string> | undefined): Record<string, string> {
  const values = emptyEnvValues();
  for (const key of CLAUDE_ENV_FIELD_KEYS) {
    if (env?.[key]) values[key] = env[key];
  }
  return values;
}

/** The stored settings.json with its legacy model spellings migrated (see
 *  migrateChannelEnv): suffix-stripped model ids, the implied 1M window, and
 *  normalized tier spells. Broken JSON returns unchanged — the editor's own
 *  error state covers it. */
function migrateSettingsJson(settingsJson: string): string {
  try {
    const parsed = JSON.parse(settingsJson) as Record<string, unknown> | null;
    const env = parsed?.env;
    if (!parsed || !env || typeof env !== "object") return settingsJson;
    const migrated = migrateChannelEnv(env as Record<string, unknown>);
    if (migrated === env) return settingsJson;
    return JSON.stringify({ ...parsed, env: migrated }, null, 2);
  } catch {
    return settingsJson;
  }
}

/** Initial form state: seed the JSON editor from the stored settingsConfig
 *  (edit, legacy spellings migrated so a save lands the normalized values),
 *  the flat fields (legacy channels), or the official-direct template
 *  (add). */
function initialForm(initial?: ProviderFormValue): ProviderFormValue {
  const base: ProviderFormValue = { ...EMPTY_FORM, ...initial };
  if (base.settingsJson.trim()) {
    return { ...base, settingsJson: migrateSettingsJson(base.settingsJson) };
  }
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

/**
 * Form state + mutations for ProviderDialog: the flat ProviderFormValue, the
 * claude channel controls mirrored into the JSON editor both ways, preset
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
  // Channel controls start empty on add (the template's env carries the
  // defaults); on edit they mirror the stored settings.json — through the
  // same migration the JSON editor seed applies.
  const [envValues, setEnvValues] = useState<Record<string, string>>(() =>
    initial?.settingsJson
      ? envValuesFrom(migrateSettingsJson(initial.settingsJson))
      : emptyEnvValues(),
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

  /** One channel control's edit: keep the value map and the JSON in step. */
  const setEnvValue = (envKey: string, next: string) => {
    setEnvValues((values) => ({ ...values, [envKey]: next }));
    updateClaudeEnv(envKey, next);
  };

  const onJsonChange = (text: string) => {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      const env = (parsed.env ?? {}) as Record<string, unknown>;
      const read = (key: string) => {
        const v = env[key];
        return typeof v === "string" ? v : "";
      };
      setEnvValues(envValuesFrom(text));
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
    setEnvValues(presetEnvValues(preset.env));
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
    setEnvValues(emptyEnvValues());
    setValue((v) => ({
      ...v,
      baseUrl: OFFICIAL_BASE_URL,
      settingsJson: claudeTemplateJson(OFFICIAL_BASE_URL, v.apiKey.trim()),
    }));
    setJsonError("");
    resetFetch();
  };

  const selectCustom = () => {
    setEnvValues(emptyEnvValues());
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
    envValues,
    setEnvValue,
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
  envValues: Record<string, string>;
  setEnvValue: (envKey: string, value: string) => void;
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
