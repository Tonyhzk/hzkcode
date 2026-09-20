import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { useNavigate, useSearchParams } from "react-router-dom";
import Puzzle from "lucide-react/dist/esm/icons/puzzle";
import {
  SettingsModal,
  type SettingsNavGroup,
} from "@/components/application/settings/settings-modal";
import {
  pluginIdFromRegistryKey,
  settingsRegistry,
  useRegistry,
} from "@hzkcode/plugin-sdk";
import { PluginBoundary } from "@/features/plugins/boundary/PluginBoundary";
import { ENGINE_IDS, type EngineId } from "./providers";
import { CliHeaderActions } from "./CliHeaderActions";
// Side-effect import: registers all builtin sections into settingsRegistry.
import "./sections";

/** A nav group plus its rail order, sorted before handing to the modal. */
type RailGroup = SettingsNavGroup & { order: number };
/** Rail meta for known nav groups (label + rail order). A group the SDK adds
 *  later isn't listed here — it falls back to label = group id, appended
 *  after the known rails, so new groups render instead of silently
 *  vanishing (empty groups are filtered out as before). */
const GROUP_META: Record<string, { labelKey: string; order: number }> = {
  settings: { labelKey: "settings.title", order: 0 },
};
const KNOWN_GROUP_COUNT = Object.keys(GROUP_META).length;

/** Unknown page params fall back to General. */
const renderPage = (key: string) => {
  const def = settingsRegistry.get(key);
  if (!def) {
    const fallback = settingsRegistry.get("general");
    return fallback ? <fallback.component /> : null;
  }
  const Component = def.component;
  // Plugin-rendered pages are wrapped so a render crash unmounts only the
  // plugin subtree (plan acceptance 1b); host pages stay unwrapped.
  if (key.startsWith("plugin:")) {
    return (
      <PluginBoundary pluginId={pluginIdFromRegistryKey(key)}>
        <Component />
      </PluginBoundary>
    );
  }
  return <Component />;
};
/** The CLI page gets the docs/version/update cluster next to the title. */
const renderHeaderActions = (key: string) => {
  if (!key.startsWith("cli:")) return null;
  const engine = key.slice("cli:".length);
  if (!(ENGINE_IDS as readonly string[]).includes(engine)) return null;
  return <CliHeaderActions engine={engine as EngineId} />;
};

/**
 * Settings route: overlay for the BoardUI settings modal. ChatPage itself is mounted once
 * by App on every route, so opening and closing settings never rebuilds
 * the chat tree.
 *
 * Nav groups and pages come from settingsRegistry: builtin sections register
 * in ./sections, plugin sections arrive via ctx.ui.registerSettingsSection
 * (plan §4.2 #1).
 */
export default function SettingsPage() {
  const { t, i18n } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const sections = useRegistry(settingsRegistry);
  // Legacy links land on the CLI page: ?page=cliConfig → the CLI section.
  const rawPage = searchParams.get("page") ?? "general";
  const pageParam = rawPage === "cliConfig" ? `cli:${ENGINE_IDS[0]}` : rawPage;

  const groups = useMemo<RailGroup[]>(() => {
    const sorted = [...sections].sort((a, b) => a.order - b.order);
    // Bucket by group in first-seen order; unknown groups (new SDK group
    // values) keep their own rail instead of joining nothing.
    const byGroup = new Map<string, SettingsNavGroup["items"]>();
    for (const def of sorted) {
      const item = {
        key: def.key,
        label: def.label(),
        icon: def.icon ?? Puzzle,
      };
      const bucket = byGroup.get(def.group);
      if (bucket) bucket.push(item);
      else byGroup.set(def.group, [item]);
    }
    // Re-render the rail on language flips: labels are functions of i18n.
    return [...byGroup.entries()]
      .flatMap(([group, items], index) => {
        const meta = GROUP_META[group];
        return [
          {
            label: meta ? t(meta.labelKey) : group,
            order: meta?.order ?? KNOWN_GROUP_COUNT + index,
            items,
          },
        ];
      })
      .sort((a, b) => a.order - b.order);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, t, i18n.language]);

  const titles = useMemo(() => {
    const map: Record<string, string> = {};
    for (const def of sections) map[def.key] = def.label();
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sections, i18n.language]);

  return (
    <SettingsModal
      isOpen
      onClose={() => navigate("/")}
      defaultPage={pageParam}
      ariaLabel={t("settings.title")}
      groups={groups}
      titles={titles}
      renderPage={renderPage}
      renderHeaderActions={renderHeaderActions}
    />
  );
}
