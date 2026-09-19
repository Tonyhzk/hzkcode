/** 自定义供应商 group — raw-text editor over models.json (pi) / models.yml
 *  (omp) with loose backend validation (extracted from PiFamilyAuthSection).
 *  All state stays with the parent; this file is presentational. */
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import type { PiFamilyModelsConfigReadResult } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { BrandIcon, ROW, StatusDot } from "./PiFamilyAuthShared";

interface ModelsConfigEditorProps {
  modelsConfig: PiFamilyModelsConfigReadResult | null;
  draft: string;
  saving: boolean;
  error: string | null;
  onDraftChange: (value: string) => void;
  onSave: () => void;
  onCancel: () => void;
}

/** Raw models.json/models.yml editor. Focus moves into the textarea when
 *  the editor opens (an explicit user action) via a mount-time ref — the
 *  no-autofocus-safe way to place initial focus. */
function ModelsConfigEditor({
  modelsConfig,
  draft,
  saving,
  error,
  onDraftChange,
  onSave,
  onCancel,
}: ModelsConfigEditorProps) {
  const { t } = useTranslation();
  // Stable identity: focus runs once on mount, not on every re-render.
  const focusTextarea = useCallback((el: HTMLTextAreaElement | null) => {
    el?.focus();
  }, []);
  return (
    <div className="border-b border-separator-border px-2 py-3 last:border-b-0">
      <label
        className="mb-1.5 block text-body-2-medium text-text-secondary"
        htmlFor="pi-family-models-config-text"
      >
        {modelsConfig?.file.format === "yaml" ? "models.yml · YAML" : "models.json · JSONC"}
      </label>
      <textarea
        ref={focusTextarea}
        id="pi-family-models-config-text"
        value={draft}
        autoComplete="off"
        spellCheck={false}
        rows={16}
        onChange={(event) => onDraftChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            onCancel();
          }
        }}
        className="w-full resize-y rounded-lg bg-background-tertiary p-2.5 font-mono text-[12px] leading-relaxed text-text-primary outline-none"
      />
      <p className="mt-1.5 text-body-2-regular text-text-tertiary">
        {t("settings.piAuthCustomEditorTips")}
      </p>
      {error ? (
        <p className="mt-1.5 text-body-2-regular text-text-error-primary" role="alert">
          {error}
        </p>
      ) : null}
      <div className="mt-2 flex items-center gap-2">
        <button
          type="button"
          disabled={saving}
          onClick={() => onSave()}
          className="rounded-lg bg-accent-500 px-3 py-1 text-body-2-medium text-white disabled:opacity-50"
        >
          {saving ? t("settings.piAuthSaving") : t("settings.piAuthSave")}
        </button>
        <button
          type="button"
          onClick={onCancel}
          className="rounded-lg border border-border-button-default px-3 py-1 text-body-2-medium text-text-primary"
        >
          {t("common.cancel")}
        </button>
        <span className="min-w-0 truncate text-body-2-regular text-text-tertiary">
          {t("settings.piAuthSaveHint", { path: modelsConfig?.file.path ?? "" })}
        </span>
      </div>
    </div>
  );
}

interface PiFamilyCustomSectionProps {
  modelsConfig: PiFamilyModelsConfigReadResult | null;
  editorOpen: boolean;
  draft: string;
  saving: boolean;
  error: string | null;
  onToggleEditor: () => void;
  onDraftChange: (value: string) => void;
  onSave: () => void;
}

export function PiFamilyCustomSection({
  modelsConfig,
  editorOpen,
  draft,
  saving,
  error,
  onToggleEditor,
  onDraftChange,
  onSave,
}: PiFamilyCustomSectionProps) {
  const { t } = useTranslation();
  return (
    <div className="flex w-full flex-col gap-2">
      <div className="flex items-center justify-between gap-3">
        <SettingsSectionLabel>
          {t("settings.piAuthCustomTitle")}
          <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
            {t("settings.piAuthCustomHint", { path: modelsConfig?.file.path ?? "" })}
          </span>
        </SettingsSectionLabel>
        <button
          type="button"
          className="shrink-0 rounded-lg border border-border-button-default px-2.5 py-1 text-body-2-medium text-text-primary hover:bg-background-secondary-hover"
          onClick={onToggleEditor}
        >
          {editorOpen ? t("settings.piAuthCollapse") : t("settings.piAuthEditConfig")}
        </button>
      </div>
      <SettingsCard>
        {modelsConfig?.parseError ? (
          <div className={cx(ROW, "text-body-regular text-text-error-primary")} role="alert">
            {t("settings.piAuthCustomParseError")}: {modelsConfig.parseError}
          </div>
        ) : null}
        {(modelsConfig?.providers ?? []).map((provider) => (
          <div className={ROW} key={provider.id}>
            <BrandIcon iconSrc={null} />
            <div className="flex min-w-0 flex-1 flex-col">
              <p className="truncate text-body-regular text-text-primary">
                {provider.name ?? provider.id}
              </p>
              <code className="w-fit truncate rounded border border-dashed border-border-button-default px-1 py-px text-[11px] text-text-tertiary">
                {provider.baseUrl ?? provider.id}
              </code>
            </div>
            {provider.api ? (
              <code className="shrink-0 rounded bg-background-tertiary px-1.5 py-0.5 text-[11px] text-text-secondary">
                {provider.api}
              </code>
            ) : null}
            <span className="shrink-0 text-body-2-regular text-text-tertiary">
              {t("settings.piAuthCustomModelCount", { count: provider.modelCount })}
            </span>
            <span className="flex shrink-0 items-center gap-1.5 text-body-2-regular text-text-secondary">
              <StatusDot on={provider.hasApiKey} />
              {provider.hasApiKey
                ? t("settings.piAuthCustomHasKey")
                : t("settings.piAuthCustomNoKey")}
            </span>
          </div>
        ))}
        {modelsConfig && modelsConfig.providers.length === 0 && !modelsConfig.parseError ? (
          <div className={cx(ROW, "text-body-regular text-text-tertiary")}>
            {modelsConfig.file.exists
              ? t("settings.piAuthCustomEmpty")
              : t("settings.piAuthCustomMissing")}
          </div>
        ) : null}
        {editorOpen ? (
          <ModelsConfigEditor
            modelsConfig={modelsConfig}
            draft={draft}
            saving={saving}
            error={error}
            onDraftChange={onDraftChange}
            onSave={onSave}
            onCancel={onToggleEditor}
          />
        ) : null}
        <div className="flex items-center gap-2 py-2 pr-2.5 text-[11px] text-text-tertiary">
          <code className="min-w-0 truncate">{modelsConfig?.file.path ?? ""}</code>
          <span className="shrink-0 rounded bg-background-tertiary px-1 py-px">0600</span>
        </div>
      </SettingsCard>
    </div>
  );
}
