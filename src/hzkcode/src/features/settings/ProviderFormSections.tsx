import { useState } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import Cloud from "lucide-react/dist/esm/icons/cloud";
import Eye from "lucide-react/dist/esm/icons/eye";
import EyeOff from "lucide-react/dist/esm/icons/eye-off";
import Globe from "lucide-react/dist/esm/icons/globe";
import X from "lucide-react/dist/esm/icons/x";
import { Input } from "@/components/base/input/input";
import { TextArea } from "@/components/base/input/textarea";
import { Select, SelectItem } from "@/components/base/select/select";
import { Switch } from "@/components/base/switch/switch";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import {
  has1mSuffix,
  mergeCustomModels,
  with1mSuffix,
  without1mSuffix,
  type EngineId,
} from "./providers";
import {
  CLAUDE_ENV_GROUPS,
  isOfficialAnthropicEndpoint,
  type EnvField,
  type ProviderPreset,
} from "./providerPresets";
import type { ProviderForm } from "./useProviderForm";

const FETCH_DATALIST_ID = "cli-provider-fetched-models";
/** Sentinel for "leave the variable unset" in the select controls. */
const UNSET_OPTION_ID = "__unset__";
/** Sentinel option that reveals the free-text model input (labeled selects). */
const CUSTOM_OPTION_ID = "__custom__";

/** Brand mark for a preset button: explicit per-preset assets keep relay
 *  providers distinct from the model they happen to serve by default. */
function PresetIcon({ preset }: { preset: ProviderPreset }) {
  return (
    <img
      src={preset.iconSrc}
      alt=""
      className={cx("size-3.5 object-contain", preset.iconClassName)}
      aria-hidden
    />
  );
}

/** Official direct-connection card: selecting it pins the channel to the
 *  vendor's own endpoint. */
function OfficialPresetSection({
  engine,
  official,
  onSelect,
}: {
  engine: EngineId;
  official: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body-2-medium text-text-secondary">
        {t("settings.cliOfficialSection")}
      </p>
      <button
        type="button"
        aria-pressed={official}
        onClick={onSelect}
        className={cx(
          "flex w-full cursor-pointer items-center gap-3 rounded-2lg border p-3 text-left transition-colors",
          official
            ? "border-border-focus-ring bg-background-secondary-default"
            : "border-border-button-default hover:bg-background-secondary-hover",
        )}
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-background-tertiary-default text-foreground-icon-primary">
          <EngineIcon engine={engine} size={16} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col">
          <span className="text-body-medium text-text-primary">
            {t("settings.cliOfficialPreset")}
          </span>
          <span className="text-body-2-regular text-text-secondary">
            {t("settings.cliOfficialPresetDesc")}
          </span>
        </span>
      </button>
    </div>
  );
}

/** Third-party relay preset grid, plus the 自定义配置 escape hatch that
 *  unlocks the URL without prefilling anything. */
function ProxyPresetSection({
  presets,
  official,
  matchedPreset,
  onSelectCustom,
  onSelectPreset,
}: {
  presets: ProviderPreset[];
  official: boolean;
  matchedPreset: ProviderPreset | undefined;
  onSelectCustom: () => void;
  onSelectPreset: (preset: ProviderPreset) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body-2-medium text-text-secondary">
        {t("settings.cliProxySection")}
      </p>
      <div className="grid grid-cols-3 gap-2">
        {/* 自定义配置: pure escape hatch — unlocks the URL without
            prefilling anything. */}
        <button
          type="button"
          aria-pressed={!official && !matchedPreset}
          onClick={onSelectCustom}
          className={cx(
            "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-body-2-regular transition-colors",
            !official && !matchedPreset
              ? "border-border-focus-ring bg-background-secondary-default text-text-primary"
              : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover",
          )}
        >
          <Globe className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{t("settings.cliPresetCustom")}</span>
        </button>
        {presets.map((preset) => (
          <button
            key={preset.name}
            type="button"
            aria-pressed={matchedPreset?.name === preset.name}
            onClick={() => onSelectPreset(preset)}
            className={cx(
              "flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-2 text-body-2-regular transition-colors",
              matchedPreset?.name === preset.name
                ? "border-border-focus-ring bg-background-secondary-default text-text-primary"
                : "border-border-button-default text-text-secondary hover:bg-background-secondary-hover",
            )}
          >
            <span className="shrink-0 text-foreground-icon-secondary">
              <PresetIcon preset={preset} />
            </span>
            <span className="truncate">{preset.name}</span>
          </button>
        ))}
      </div>
      <p className="text-body-2-regular text-text-tertiary">
        {t("settings.cliProxyHint")}
      </p>
    </div>
  );
}

/** 拉取模型 button plus its result/error readout; the fetched ids feed the
 *  shared datalist behind the model inputs. */
function FetchModelsControl({
  fetching,
  error,
  count,
  disabled,
  onFetch,
}: {
  fetching: boolean;
  error: string;
  count: number;
  disabled: boolean;
  onFetch: () => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2">
      <button
        type="button"
        onClick={onFetch}
        disabled={fetching || disabled}
        className="shrink-0 rounded-lg border border-border-button-default px-2 py-0.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover disabled:opacity-50"
      >
        {fetching ? t("settings.cliFetchModelsLoading") : t("settings.cliFetchModels")}
      </button>
      {error ? (
        <span className="text-body-2-regular text-text-error-primary">{error}</span>
      ) : count > 0 ? (
        <span className="text-body-2-regular text-text-tertiary">
          {t("settings.cliFetchModelsCount", { count })}
        </span>
      ) : null}
    </div>
  );
}

/** Official card plus the relay preset grid. */
export function ProviderPresetSections({
  engine,
  form,
}: {
  engine: EngineId;
  form: ProviderForm;
}) {
  return (
    <>
      <OfficialPresetSection
        engine={engine}
        official={form.official}
        onSelect={form.selectOfficial}
      />
      {form.presets.length > 0 && (
        <ProxyPresetSection
          presets={form.presets}
          official={form.official}
          matchedPreset={form.matchedPreset}
          onSelectCustom={form.selectCustom}
          onSelectPreset={form.selectPreset}
        />
      )}
    </>
  );
}

/** name/remark plus the flat URL/key pair. Both fields mirror every
 *  keystroke into the JSON editor's env. */
export function ProviderBasicFields({ form }: { form: ProviderForm }) {
  const { t } = useTranslation();
  const [showKey, setShowKey] = useState(false);
  const { value, patch } = form;
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      <Input
        label={t("settings.cliName")}
        isRequired
        size="small"
        placeholder={t("settings.cliNamePlaceholder")}
        value={value.name}
        onChange={(name) => patch({ name })}
        autoFocus
      />
      <Input
        label={t("settings.cliRemark")}
        size="small"
        placeholder={t("settings.cliRemarkPlaceholder")}
        value={value.remark}
        onChange={(remark) => patch({ remark })}
      />
      <Input
        label={t("settings.cliBaseUrl")}
        isRequired
        size="small"
        placeholder="https://…"
        value={value.baseUrl}
        onChange={(baseUrl) => {
          patch({ baseUrl });
          form.updateClaudeEnv("HZKCODE_BASE_URL", baseUrl);
        }}
        isDisabled={form.official}
      />
      <div className="relative">
        <Input
          label={t("settings.cliApiKey")}
          isRequired
          size="small"
          type={showKey ? "text" : "password"}
          placeholder="sk-ant-..."
          value={value.apiKey}
          onChange={(apiKey) => {
            patch({ apiKey });
            form.updateClaudeEnv("HZKCODE_API_KEY", apiKey);
          }}
          fieldClassName="pr-8"
        />
        <button
          type="button"
          aria-label={t("settings.cliApiKey")}
          onClick={() => setShowKey((s) => !s)}
          className="absolute right-2 bottom-1.5 flex size-5 items-center justify-center rounded text-foreground-icon-tertiary hover:text-foreground-icon-primary"
        >
          {showKey ? (
            <EyeOff className="size-4" aria-hidden />
          ) : (
            <Eye className="size-4" aria-hidden />
          )}
        </button>
      </div>
    </div>
  );
}

/** One control from an env-field schema: a switch for on/off variables, a
 *  dropdown for fixed option lists, an input for text and numbers (model ids
 *  carry the 拉取模型 datalist). Shared by the channel dialog and the global
 *  feature card. */
export function EnvFieldControl({
  field,
  value,
  onChange,
  grouped = true,
}: {
  field: EnvField;
  value: string;
  onChange: (next: string) => void;
  /** true = lay the label above the control; false = inline label + switch. */
  grouped?: boolean;
}) {
  const { t } = useTranslation();
  // The labeled-select branch's 自定义 state: the select must keep showing
  // 自定义 even while the free-text id is still empty.
  const [customMode, setCustomMode] = useState(false);
  const hint = field.hintKey ? t(field.hintKey) : undefined;
  if (field.kind === "toggle") {
    const on = value.trim() === "1";
    return (
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <span className="text-body-medium text-text-primary">
            {t(field.labelKey)}
          </span>
          {hint && (
            <span className="text-body-2-regular text-text-tertiary">{hint}</span>
          )}
        </div>
        <Switch
          size="sm"
          aria-label={t(field.labelKey)}
          isSelected={on}
          onChange={(next) => onChange(next ? "1" : "")}
        />
      </div>
    );
  }
  if (field.kind === "select" && field.optionLabelKeys) {
    // Tier picker (the channel's default model): labeled options over the
    // tier aliases; a stored value outside them — or an explicit 自定义
    // pick — reveals the free-text model input with its 1M switch.
    const options = field.options ?? [];
    const labelKeys = field.optionLabelKeys;
    const stored = value.trim();
    const isCustom =
      !!field.allowCustom &&
      (customMode || (stored !== "" && !options.includes(stored)));
    const selectedKey = isCustom
      ? CUSTOM_OPTION_ID
      : options.includes(stored)
        ? stored
        : (field.emptyShows ?? options[0] ?? UNSET_OPTION_ID);
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-body-medium text-text-secondary">
          {t(field.labelKey)}
        </span>
        <Select
          aria-label={t(field.labelKey)}
          selectedKey={selectedKey}
          onSelectionChange={(key) => {
            const next = String(key);
            if (next === CUSTOM_OPTION_ID) {
              setCustomMode(true);
              // Never carry a tier alias over as the custom id text; a value
              // that already is a custom id stays in the input.
              if (options.includes(stored)) onChange("");
              return;
            }
            setCustomMode(false);
            onChange(next);
          }}
        >
          {options.map((option) => {
            const labelKey = labelKeys[option];
            return (
              <SelectItem key={option} id={option}>
                {labelKey ? t(labelKey) : option}
              </SelectItem>
            );
          })}
          {field.allowCustom && (
            <SelectItem key={CUSTOM_OPTION_ID} id={CUSTOM_OPTION_ID}>
              {t("settings.cliFieldCustomModel")}
            </SelectItem>
          )}
        </Select>
        {isCustom && (
          <div className="flex flex-col gap-1.5">
            <div className="flex items-center justify-end gap-1.5">
              <span className="text-body-2-regular text-text-tertiary">
                {t("settings.cliField1m")}
              </span>
              <Switch
                size="sm"
                aria-label={`${t(field.labelKey)}: ${t("settings.cliField1m")}`}
                isSelected={has1mSuffix(value)}
                isDisabled={value.trim() === ""}
                onChange={(next) =>
                  onChange(next ? with1mSuffix(value) : without1mSuffix(value))
                }
              />
            </div>
            <Input
              size="small"
              list={FETCH_DATALIST_ID}
              aria-label={t(field.labelKey)}
              placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
              value={value}
              onChange={onChange}
            />
          </div>
        )}
        {hint && <p className="text-body-2-regular text-text-tertiary">{hint}</p>}
      </div>
    );
  }
  if (field.kind === "select") {
    return (
      <div className="flex flex-col gap-1.5">
        <span className="text-body-medium text-text-secondary">
          {t(field.labelKey)}
        </span>
        <Select
          aria-label={t(field.labelKey)}
          selectedKey={value.trim() || UNSET_OPTION_ID}
          onSelectionChange={(key) =>
            onChange(key === UNSET_OPTION_ID ? "" : String(key))
          }
        >
          {(field.options ?? []).map((option) => (
            <SelectItem key={option || UNSET_OPTION_ID} id={option || UNSET_OPTION_ID}>
              {option || t("settings.cliFieldUnset")}
            </SelectItem>
          ))}
        </Select>
        {hint && <p className="text-body-2-regular text-text-tertiary">{hint}</p>}
      </div>
    );
  }
  if (field.oneM) {
    // Model fields carry the 1M-context switch: it rewrites the value's
    // `[1m]` suffix (append when absent, replace a different one, drop on
    // uncheck) instead of asking the user to spell the suffix out.
    const switchLabel = `${t(field.labelKey)}: ${t("settings.cliField1m")}`;
    return (
      <div className="flex flex-col gap-1.5">
        <div className="flex items-center justify-between gap-2">
          <span className="text-body-medium text-text-secondary">
            {t(field.labelKey)}
          </span>
          <div className="flex shrink-0 items-center gap-1.5">
            <span className="text-body-2-regular text-text-tertiary">
              {t("settings.cliField1m")}
            </span>
            <Switch
              size="sm"
              aria-label={switchLabel}
              isSelected={has1mSuffix(value)}
              isDisabled={value.trim() === ""}
              onChange={(next) =>
                onChange(next ? with1mSuffix(value) : without1mSuffix(value))
              }
            />
          </div>
        </div>
        <Input
          size="small"
          list={FETCH_DATALIST_ID}
          aria-label={t(field.labelKey)}
          placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
          value={value}
          onChange={onChange}
        />
        {hint && <p className="text-body-2-regular text-text-tertiary">{hint}</p>}
      </div>
    );
  }
  return (
    <Input
      label={t(field.labelKey)}
      size="small"
      inputMode={field.kind === "number" ? "numeric" : undefined}
      list={field.kind === "text" ? FETCH_DATALIST_ID : undefined}
      placeholder={field.placeholderKey ? t(field.placeholderKey) : undefined}
      hint={grouped ? hint : undefined}
      value={value}
      onChange={onChange}
    />
  );
}

/** 自定义模型: comma-separated batch input plus the removable list; the
 *  saved ids merge into the chat model picker for this channel. */
function CustomModelsField({ form }: { form: ProviderForm }) {
  const { t } = useTranslation();
  const [draft, setDraft] = useState("");
  const { customModels } = form.value;
  const merged = mergeCustomModels(customModels, draft);
  const add = () => {
    if (merged.length === customModels.length) return;
    form.patch({ customModels: merged });
    setDraft("");
  };
  const remove = (id: string) =>
    form.patch({ customModels: customModels.filter((m) => m !== id) });
  return (
    <div className="flex flex-col gap-2">
      <p className="text-body-medium text-text-primary">
        {t("settings.cliCustomModels")}
      </p>
      <p className="text-body-2-regular text-text-tertiary">
        {t("settings.cliCustomModelsDialogDesc")}
      </p>
      <div
        className="flex items-center gap-2"
        onKeyDownCapture={(event) => {
          // Enter adds the batch instead of submitting the dialog form.
          if (event.key !== "Enter") return;
          event.preventDefault();
          add();
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            size="small"
            aria-label={t("settings.cliCustomModels")}
            placeholder={t("settings.cliCustomModelsPlaceholder")}
            value={draft}
            onChange={setDraft}
          />
        </div>
        <button
          type="button"
          onClick={add}
          disabled={merged.length === customModels.length}
          className="h-8 shrink-0 rounded-lg border border-border-button-default px-2.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover disabled:opacity-50"
        >
          {t("settings.cliCustomModelsAdd")}
        </button>
      </div>
      {customModels.length === 0 ? (
        <p className="text-body-2-regular text-text-tertiary">
          {t("settings.cliCustomModelsEmpty")}
        </p>
      ) : (
        <ul className="flex flex-wrap gap-1.5">
          {customModels.map((id) => (
            <li
              key={id}
              className="flex max-w-full items-center gap-1 rounded-lg border border-border-button-default bg-background-secondary-default py-0.5 pr-1 pl-2 text-body-2-regular text-text-secondary"
            >
              <span className="truncate">{id}</span>
              <button
                type="button"
                aria-label={`${t("settings.cliDelete")} ${id}`}
                onClick={() => remove(id)}
                className="flex size-5 shrink-0 items-center justify-center rounded text-foreground-icon-tertiary hover:bg-background-secondary-hover hover:text-text-error-primary"
              >
                <X className="size-3" aria-hidden />
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** Relay warning, channel controls, and the collapsible raw JSON editor. */
export function ClaudeFormSections({ form }: { form: ProviderForm }) {
  const { t } = useTranslation();
  const [jsonOpen, setJsonOpen] = useState(false);
  const { value } = form;
  return (
    <>
      {!isOfficialAnthropicEndpoint(value.baseUrl) && (
        <div className="flex items-center gap-1.5 rounded-lg border border-border-button-default bg-background-secondary-default px-3 py-2 text-body-2-regular text-text-secondary">
          <Cloud className="size-3.5 shrink-0" aria-hidden />
          <span>{t("settings.cliProxyWarning")}</span>
        </div>
      )}

      <div className="flex flex-col gap-4">
        <div className="flex items-center justify-between gap-2">
          <p className="text-body-medium text-text-primary">
            {t("settings.cliModelMapping")}
          </p>
          <FetchModelsControl
            fetching={form.fetching}
            error={form.fetchError}
            count={form.fetchedModels.length}
            disabled={!value.baseUrl.trim()}
            onFetch={() => void form.handleFetchModels()}
          />
        </div>
        <datalist id={FETCH_DATALIST_ID}>
          {form.fetchedModels.map((model) => (
            <option key={model} value={model} />
          ))}
        </datalist>
        {CLAUDE_ENV_GROUPS.map((group) => (
          <div key={group.titleKey} className="flex flex-col gap-2">
            <p className="text-body-2-medium text-text-secondary">
              {t(group.titleKey)}
            </p>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {group.fields.map((field) => (
                <EnvFieldControl
                  key={field.envKey}
                  field={field}
                  value={form.envValues[field.envKey] ?? ""}
                  onChange={(next) => form.setEnvValue(field.envKey, next)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <CustomModelsField form={form} />

      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            aria-expanded={jsonOpen}
            onClick={() => setJsonOpen((o) => !o)}
            className="flex items-center gap-1 text-body-medium text-text-primary"
          >
            <ChevronDown
              className={cx("size-3.5 transition-transform", !jsonOpen && "-rotate-90")}
              aria-hidden
            />
            {t("settings.cliJsonConfig")}
          </button>
          <button
            type="button"
            onClick={form.handleFormatJson}
            className="rounded-lg border border-border-button-default px-2 py-0.5 text-body-2-medium text-text-secondary transition-colors hover:bg-background-secondary-hover"
          >
            {t("settings.cliFormatJson")}
          </button>
        </div>
        {jsonOpen && (
          <>
            <p className="text-body-2-regular text-text-tertiary">
              {t("settings.cliJsonConfigDesc")}
            </p>
            <TextArea
              mono
              rows={14}
              spellCheck={false}
              aria-label={t("settings.cliJsonConfig")}
              value={value.settingsJson}
              onChange={form.onJsonChange}
              isInvalid={!form.jsonValid}
              hint={form.jsonError || undefined}
              inputClassName="whitespace-pre"
            />
          </>
        )}
      </div>
    </>
  );
}
