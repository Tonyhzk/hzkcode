import type { EngineId } from "./providers";
import { CliConfigBody } from "./CliConfigBody";
import { CliDeleteConfirm, CliProviderDialog } from "./CliConfigDialogs";
import { useCliConfig } from "./useCliConfig";

/**
 * One CLI's page under the settings nav — the BoardUI ai-chat "Tools"
 * template language:
 *   供应商渠道 card (channels with drag sorting)
 *   → empty state.
 *
 * State and mutations live in useCliConfig; the loaded UI is CliConfigBody
 * and the dialogs are CliConfigDialogs.
 */
export function CliConfigSection({ engine }: { engine: EngineId }) {
  const cli = useCliConfig(engine);
  const { t, config, error } = cli;
  return (
    <div className="flex w-full flex-col gap-6">
      {error && (
        <p role="alert" className="text-body-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}
      {!config && !error && (
        <p className="text-body-regular text-text-tertiary">{t("common.loading")}</p>
      )}
      {config && <CliConfigBody cli={cli} />}
      <CliProviderDialog cli={cli} />
      <CliDeleteConfirm cli={cli} />
    </div>
  );
}
