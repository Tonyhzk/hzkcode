import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import ChevronDown from "lucide-react/dist/esm/icons/chevron-down";
import { Collapsible } from "@/components/application/collapsible/collapsible";
import {
  SettingsCard,
  SettingsRow,
  SettingsSectionLabel,
} from "@/components/application/settings/settings-rows";
import { Switch } from "@/components/base/switch/switch";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { cx } from "@/utils/cx";
import { cliFeatureGroup, type CliEnvGroup } from "./cliFeatureEnv";
import type { EnvField } from "./providerPresets";
import { EnvFieldControl } from "./ProviderFormSections";
import { useCliEnv } from "./useCliEnv";

/** Fold/expand duration of the master switch and the 高级设置 region. */
const FOLD_SECONDS = 0.2;

/** One on/off variable as a settings row: label + hint on the left, switch on
 *  the right (the 通用 page recipe). */
function ToggleRow({
  field,
  value,
  onChange,
}: {
  field: EnvField;
  value: string;
  onChange: (next: string) => void;
}) {
  const { t } = useTranslation();
  const label = t(field.labelKey);
  return (
    <SettingsRow
      label={label}
      description={field.hintKey ? t(field.hintKey) : undefined}
    >
      <Switch
        size="sm"
        aria-label={label}
        isSelected={value.trim() === "1"}
        onChange={(next) => onChange(next ? "1" : "")}
      />
    </SettingsRow>
  );
}

/** Block list with the dividers between them (never around them, so a folded
 *  region cannot leave a stray line at the card edge). */
function Blocks({
  blocks,
  trailingDivider = false,
}: {
  blocks: readonly { key: string; node: ReactNode }[];
  trailingDivider?: boolean;
}) {
  return (
    <>
      {blocks.map((block, index) => (
        <div
          key={block.key}
          className={cx(
            (index < blocks.length - 1 || trailingDivider) &&
              "border-b border-separator-border",
          )}
        >
          {block.node}
        </div>
      ))}
    </>
  );
}

/**
 * One feature group as a settings card: an optional master switch that folds
 * the body away when off, the body itself (switch rows, an optional tab
 * switcher, input grids), and a 高级设置 fold for the rarely touched tuning
 * values.
 */
export function CliEnvGroupCard({
  group,
  values,
  onChange,
}: {
  group: CliEnvGroup;
  values: Record<string, string>;
  onChange: (envKey: string, value: string) => void;
}) {
  const { t } = useTranslation();
  /** null = follow whether any advanced value is stored. */
  const [advancedOpen, setAdvancedOpen] = useState<boolean | null>(null);
  const [tab, setTab] = useState(group.tabs?.[0]?.id ?? "");

  const stored = (field: EnvField) => values[field.envKey] ?? "";
  const storedValue = (envKey: string) => values[envKey] ?? "";
  const isSet = (field: EnvField) => stored(field).trim() !== "";
  /** `showWhen` fields stay hidden — and keep their value — until their
   *  trigger picks them; the master switch folds everything below it. */
  const shown = (field: EnvField) =>
    !field.showWhen ||
    field.showWhen.oneOf.includes(storedValue(field.showWhen.envKey).trim());

  const master = group.fields.find((field) => field.master);
  const expanded = !master || stored(master).trim() === "1";

  const shared = group.fields.filter(
    (field) => field !== master && !field.tabKey && shown(field),
  );
  const advancedFields = shared.filter((field) => field.advanced);
  const advancedShown =
    advancedFields.length > 0 && (advancedOpen ?? advancedFields.some(isSet));
  const tabFields = group.fields.filter(
    (field) => field.tabKey === tab && shown(field),
  );

  const isToggle = (field: EnvField) => field.kind === "toggle";
  const inputGrid = (fields: readonly EnvField[]) => {
    const inputs = fields.filter((field) => !isToggle(field));
    if (inputs.length === 0) return null;
    return (
      <div className="grid grid-cols-1 gap-3 px-3 py-3 sm:grid-cols-2">
        {inputs.map((field) => (
          <EnvFieldControl
            key={field.envKey}
            field={field}
            value={stored(field)}
            onChange={(next) => onChange(field.envKey, next)}
          />
        ))}
      </div>
    );
  };
  const appendToggles = (
    blocks: { key: string; node: ReactNode }[],
    fields: readonly EnvField[],
    key: string,
  ) => {
    const toggles = fields.filter(isToggle);
    if (toggles.length === 0) return;
    blocks.push({
      key,
      node: toggles.map((field) => (
        <ToggleRow
          key={field.envKey}
          field={field}
          value={stored(field)}
          onChange={(next) => onChange(field.envKey, next)}
        />
      )),
    });
  };

  const body: { key: string; node: ReactNode }[] = [];
  const bodyFields = shared.filter((field) => !field.advanced);
  appendToggles(body, bodyFields, "body-toggles");
  const bodyInputs = inputGrid(bodyFields);
  if (bodyInputs) body.push({ key: "body-inputs", node: bodyInputs });
  if (group.tabs) {
    body.push({
      key: "tabs",
      node: (
        <div className="px-3 py-3">
          <PillTabList>
            {group.tabs.map((definition) => (
              <PillTab
                key={definition.id}
                variant="gray"
                icon={definition.icon}
                isSelected={definition.id === tab}
                onSelect={() => setTab(definition.id)}
              >
                {t(definition.labelKey)}
              </PillTab>
            ))}
          </PillTabList>
        </div>
      ),
    });
  }
  const tabInputs = inputGrid(tabFields);
  if (tabInputs) body.push({ key: "tab-inputs", node: tabInputs });
  appendToggles(body, tabFields, "tab-toggles");

  const advanced: { key: string; node: ReactNode }[] = [];
  const advancedInputs = inputGrid(advancedFields);
  if (advancedInputs) advanced.push({ key: "advanced-inputs", node: advancedInputs });
  appendToggles(advanced, advancedFields, "advanced-toggles");

  return (
    <div className="flex w-full flex-col gap-2">
      <SettingsSectionLabel>{t(group.titleKey)}</SettingsSectionLabel>
      <p className="px-3 text-body-2-regular text-text-secondary">
        {t(group.descKey)}
      </p>
      <SettingsCard>
        {master && (
          <div>
            <ToggleRow
              field={master}
              value={stored(master)}
              onChange={(next) => onChange(master.envKey, next)}
            />
          </div>
        )}
        <Collapsible open={expanded} seconds={FOLD_SECONDS}>
          <div
            className={cx(master && "border-t border-separator-border")}
          >
            <Blocks blocks={body} trailingDivider={advancedFields.length > 0} />
            {advancedFields.length > 0 && (
              <>
                <div>
                  <button
                    type="button"
                    aria-expanded={advancedShown}
                    onClick={() => setAdvancedOpen(!advancedShown)}
                    className="group flex min-h-[52px] w-full cursor-pointer items-center justify-between gap-4 py-2.5 pr-2.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                  >
                    <span className="text-body-regular text-text-secondary group-hover:text-text-primary">
                      {t("settings.cliAdvanced")}
                    </span>
                    <ChevronDown
                      className={cx(
                        "size-4 shrink-0 text-foreground-icon-secondary transition-transform",
                        !advancedShown && "-rotate-90",
                      )}
                      aria-hidden
                    />
                  </button>
                </div>
                <Collapsible open={advancedShown} seconds={FOLD_SECONDS}>
                  <div className="border-t border-separator-border">
                    <Blocks blocks={advanced} />
                  </div>
                </Collapsible>
              </>
            )}
          </div>
        </Collapsible>
      </SettingsCard>
    </div>
  );
}

/** A page's feature cards: one env store shared by every card on the page. */
export function CliEnvCards({ ids }: { ids: readonly string[] }) {
  const { t } = useTranslation();
  const { values, setEnv, error } = useCliEnv();
  return (
    <>
      {error && (
        <p role="alert" className="text-body-2-regular text-text-error-primary">
          {t("common.error")}: {error}
        </p>
      )}
      {ids.map((id) => (
        <CliEnvGroupCard
          key={id}
          group={cliFeatureGroup(id)}
          values={values}
          onChange={setEnv}
        />
      ))}
    </>
  );
}
