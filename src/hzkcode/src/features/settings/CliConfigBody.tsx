import Plus from "lucide-react/dist/esm/icons/plus";
import { Button } from "@/components/base/buttons/button";
import {
  SettingsCard,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { WorkspaceSortableList } from "@/components/application/ai-chat/workspace-sortable-list";
import { ipc } from "@/lib/ipc";
import { PSEUDO_LOCAL } from "./providers";
import { ChannelRow } from "./CliChannelRow";
import { CliEngineSettingsCard } from "./CliEngineSettingsCard";
import type { CliConfigState } from "./useCliConfig";

/**
 * The loaded CLI config UI:
 *   官方配置 fallback row
 *   → 供应商渠道 card (avatar/switch/⋯-menu rows + drag sorting)
 *   → empty state.
 */
export function CliConfigBody({ cli }: { cli: CliConfigState }) {
  const {
    t,
    engine,
    busy,
    entries,
    currentId,
    mutate,
    activate,
    setDialog,
    setPendingDelete,
  } = cli;

  return (
    <div className="flex w-full flex-col gap-6">
      <CliEngineSettingsCard
        cli={cli}
        onEditOfficial={() => cli.setOfficialEditing(true)}
      />

      <div className="flex w-full flex-col gap-2">
        <div className="flex items-center justify-between gap-3">
          <SettingsSectionLabel>
            {t("settings.cliChannels")}
            <span className="ml-2 text-body-2-regular font-normal text-text-tertiary">
              {t("settings.cliChannelsHint")}
            </span>
          </SettingsSectionLabel>
          <Button
            size="small"
            leadingIcon={Plus}
            disabled={busy}
            onClick={() => setDialog({})}
          >
            {t("settings.cliDialogAdd")}
          </Button>
        </div>

        <SettingsCard>
          <WorkspaceSortableList
            items={entries}
            onReorder={(ids) => void mutate(() => ipc.reorderProviders(engine, ids))}
            renderItem={(entry, drag) => (
              <ChannelRow
                engine={engine}
                entry={entry}
                current={currentId === entry.id}
                busy={busy}
                drag={drag}
                onToggle={(on) => activate(on ? entry.id : PSEUDO_LOCAL)}
                onEdit={() => setDialog({ entry })}
                onDelete={() => setPendingDelete(entry)}
              />
            )}
          />
        </SettingsCard>

        {entries.length === 0 && (
          <div className="mt-3 rounded-2xl border border-dashed border-border-button-default px-4 py-6 text-center">
            <p className="text-body-medium text-text-primary">
              {t("settings.cliEmptyTitle")}
            </p>
            <p className="mt-1 text-body-2-regular text-text-secondary">
              {t("settings.cliEmptyDesc")}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
