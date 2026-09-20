import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { ipc, type AppSettings } from "@/lib/ipc";
import { errorText } from "@/lib/errors";
import { CLI_FEATURE_GROUPS } from "./cliFeatureEnv";
import { EnvFieldControl } from "./ProviderFormSections";

/** Save coalescing: a text field fires per keystroke, and settings.json is a
 *  whole-file write. */
const SAVE_DEBOUNCE_MS = 500;

/**
 * Global CLI feature switches — 联网搜索、OSS 上传、飞书通知、用户记忆、二脑、
 * 自动模式、状态汇报与 CLI 代理。The app stores them in its own settings and
 * injects them into every engine spawn, so they apply to all sessions without
 * a shell profile; per-channel values (endpoint, key, model tiers) live in the
 * channel dialog instead.
 */
export function CliFeaturesCard() {
  const { t } = useTranslation();
  const [settings, setSettings] = useState<AppSettings | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pending = useRef<AppSettings | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    ipc
      .getAppSettings()
      .then(setSettings)
      .catch((e) => setError(errorText(e)));
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  const flush = () => {
    const next = pending.current;
    pending.current = null;
    if (!next) return;
    ipc
      .updateAppSettings(next)
      .then(() => setError(null))
      .catch((e) => setError(errorText(e)));
  };

  const setEnv = (envKey: string, value: string) => {
    if (!settings) return;
    const cliEnv = { ...(settings.cliEnv ?? {}) };
    if (value.trim()) cliEnv[envKey] = value;
    else delete cliEnv[envKey];
    const next = { ...settings, cliEnv };
    setSettings(next);
    pending.current = next;
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(flush, SAVE_DEBOUNCE_MS);
  };

  const values = settings?.cliEnv ?? {};

  return (
    <div className="flex w-full flex-col gap-4">
      <SettingsSectionLabel>
        {t("settings.cliFeatures")}
        <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
          {t("settings.cliFeaturesHint")}
        </span>
      </SettingsSectionLabel>
      {error && (
        <p role="alert" className="text-body-2-regular text-text-error-primary">
          {error}
        </p>
      )}
      {CLI_FEATURE_GROUPS.map((group) => {
        const rows = group.fields.filter((field) => field.kind === "toggle");
        const rest = group.fields.filter((field) => field.kind !== "toggle");
        return (
          <SettingsCard key={group.titleKey}>
            <div className="flex flex-col gap-3 p-3">
              <p className="text-body-medium text-text-primary">
                {t(group.titleKey)}
              </p>
              {rows.map((field) => (
                <EnvFieldControl
                  key={field.envKey}
                  field={field}
                  value={values[field.envKey] ?? ""}
                  onChange={(next) => setEnv(field.envKey, next)}
                />
              ))}
              {rest.length > 0 && (
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {rest.map((field) => (
                    <EnvFieldControl
                      key={field.envKey}
                      field={field}
                      value={values[field.envKey] ?? ""}
                      onChange={(next) => setEnv(field.envKey, next)}
                    />
                  ))}
                </div>
              )}
            </div>
          </SettingsCard>
        );
      })}
    </div>
  );
}
