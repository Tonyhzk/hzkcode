import Download from "lucide-react/dist/esm/icons/download";
import Upload from "lucide-react/dist/esm/icons/upload";
import ShieldCheck from "lucide-react/dist/esm/icons/shield-check";
import { Button } from "@/components/base/buttons/button";
import { Input } from "@/components/base/input/input";
import { ModalShell } from "@/components/dialogs";
import { SettingsCard, SettingsRow, SettingsSectionLabel } from "@/components/application/settings/settings-rows";
import type { ConfigBackupWarning } from "@/lib/ipc";
import { useConfigBackup } from "./useConfigBackup";

const WARNING_KEYS: Record<string, string> = {
  machine_paths_review: "backup.warnings.paths",
  network_review: "backup.warnings.network",
  permission_mode: "backup.warnings.permission",
  path_skipped: "backup.warnings.skipped",
  prompt_skipped: "backup.warnings.promptSkipped",
  relay_disabled: "backup.warnings.relay",
  pairing_reset: "backup.warnings.pairing",
  workspace_preserved: "backup.warnings.workspaces",
};

export function ConfigBackupSection() {
  const flow = useConfigBackup();
  const { t } = flow;
  const warningText = (warning: ConfigBackupWarning) => t(
    WARNING_KEYS[warning.code] ?? "backup.warnings.review",
    { field: warning.field ?? "" },
  );
  const title = flow.result ? t("backup.restored") : flow.preview
    ? t("backup.preview") : t(flow.mode === "export" ? "backup.export" : "backup.import");

  return (
    <div className="flex w-full flex-col gap-6">
      {!flow.available && <p role="note" className="text-body-regular text-text-secondary">{t("backup.desktopOnly")}</p>}
      <div className="flex flex-col gap-2">
        <SettingsSectionLabel>{t("backup.title")}</SettingsSectionLabel>
        <SettingsCard>
          <SettingsRow label={t("backup.export")} description={t("backup.exportHint")}>
            <Button size="small" leadingIcon={Download} disabled={!flow.available} onClick={() => flow.open("export")}>
              {t("backup.export")}
            </Button>
          </SettingsRow>
          <SettingsRow label={t("backup.import")} description={t("backup.importHint")}>
            <Button size="small" variant="secondary" leadingIcon={Upload} disabled={!flow.available} onClick={() => flow.open("import")}>
              {t("backup.import")}
            </Button>
          </SettingsRow>
        </SettingsCard>
      </div>
      {flow.exportedPath && (
        <div role="status" className="rounded-xl bg-background-tertiary-default p-3 text-body-regular text-text-primary">
          <p>{t("backup.exported")}</p>
          <p data-selectable className="mt-1 break-all text-body-2-regular text-text-secondary">{flow.exportedPath}</p>
        </div>
      )}
      <div className="flex flex-col gap-3 text-body-2-regular text-text-secondary">
        <p className="flex items-center gap-2 font-medium text-text-primary"><ShieldCheck className="size-4 shrink-0" aria-hidden />{t("backup.encrypted")}</p>
        <p>{t("backup.included")}</p>
        <p>{t("backup.excluded")}</p>
        <p>{t("backup.machineNote")}</p>
        <p>{t("backup.recoveryNote")}</p>
      </div>
      {flow.mode && (
        <ModalShell
          label={title}
          onClose={flow.close}
          className="w-[520px] max-w-[calc(100vw-32px)] max-h-[calc(100vh-48px)] overflow-y-auto p-6"
        >
          <form className="flex flex-col gap-4" onSubmit={(event) => {
            event.preventDefault();
            if (flow.result) void flow.restart();
            else if (flow.preview) void flow.confirmImport();
            else void flow.submit();
          }}>
            <h2 className="text-title-3-medium text-text-primary">{title}</h2>
            {!flow.preview && !flow.result && (
              <>
                {flow.mode === "import" && (
                  <div className="flex flex-col gap-2">
                    <p className="text-body-medium text-text-primary">{t("backup.file")}</p>
                    <p data-selectable className="break-all text-body-2-regular text-text-secondary">{flow.filePath || t("backup.noFile")}</p>
                    <Button size="small" variant="secondary" className="self-start" disabled={flow.busy} onClick={() => void flow.chooseFile()}>{t("backup.chooseFile")}</Button>
                  </div>
                )}
                <Input
                  label={t("backup.password")}
                  hint={flow.mode === "export" ? t("backup.passwordHint") : undefined}
                  type="password"
                  autoComplete={flow.mode === "export" ? "new-password" : "off"}
                  value={flow.password}
                  maxLength={1024}
                  isDisabled={flow.busy}
                  onChange={flow.setPassword}
                />
                {flow.mode === "export" && (
                  <Input
                    label={t("backup.confirmation")}
                    type="password"
                    autoComplete="new-password"
                    value={flow.confirmation}
                    maxLength={1024}
                    isDisabled={flow.busy}
                    isInvalid={!!flow.confirmation && flow.confirmation !== flow.password}
                    hint={flow.confirmation && flow.confirmation !== flow.password ? t("backup.passwordMismatch") : undefined}
                    onChange={flow.setConfirmation}
                  />
                )}
              </>
            )}
            {flow.preview && (
              <>
                <dl data-selectable className="grid grid-cols-2 gap-x-4 gap-y-2 text-body-2-regular text-text-secondary">
                  <dt>{t("backup.source")}</dt><dd className="break-all">{flow.preview.appVersion}</dd>
                  <dt>{t("backup.created")}</dt><dd className="break-all">{new Date(Number(flow.preview.exportedAt)).toLocaleString()}</dd>
                  <dt>{t("backup.platform")}</dt><dd>{flow.preview.platform}</dd>
                  <dt>{t("backup.providers")}</dt><dd>{flow.preview.providerCount}</dd>
                  <dt>{t("backup.agents")}</dt><dd>{flow.preview.agentCount}</dd>
                  <dt>{t("backup.prompts")}</dt><dd>{flow.preview.promptCount}</dd>
                  <dt>{t("backup.preferences")}</dt><dd>{flow.preview.preferenceCount}</dd>
                </dl>
                <p className="text-body-2-regular text-text-secondary">{t("backup.applyNote")}</p>
                {flow.preview.warnings.length > 0 && (
                  <ul className="list-disc space-y-2 ps-5 text-body-2-regular text-text-secondary">
                    {flow.preview.warnings.map((warning, index) => <li key={index}>{warningText(warning)}</li>)}
                  </ul>
                )}
                <p className="text-body-2-regular font-medium text-text-primary">{t("backup.restartNote")}</p>
              </>
            )}
            {flow.result && (
              <>
                <p role="status" className="text-body-regular text-text-primary">{t("backup.restarting")}</p>
                <p className="text-body-medium text-text-primary">{t("backup.backupPath")}</p>
                <p data-selectable className="break-all text-body-2-regular text-text-secondary">{flow.result.backupPath}</p>
                {flow.result.warnings.map((warning, index) => (
                  <p key={index} className="text-body-2-regular text-text-secondary">{warningText(warning)}</p>
                ))}
              </>
            )}
            {flow.error && <p role="alert" className="text-body-2-regular text-text-error-primary">{flow.error}</p>}
            <div className="flex flex-wrap justify-end gap-2">
              {!flow.result && (
                <Button size="small" variant="secondary" disabled={flow.busy} onClick={flow.close}>{t("common.cancel")}</Button>
              )}
              {flow.preview && <Button size="small" variant="secondary" disabled={flow.busy} onClick={flow.back}>{t("backup.back")}</Button>}
              <Button
                size="small"
                type="submit"
                disabled={flow.busy || (!flow.preview && !flow.result && !flow.canSubmit)}
              >
                {flow.busy ? t("backup.working") : flow.result ? t("backup.restart") : flow.preview
                  ? t("backup.restore") : t(flow.mode === "export" ? "backup.export" : "backup.decrypt")}
              </Button>
            </div>
          </form>
        </ModalShell>
      )}
    </div>
  );
}
