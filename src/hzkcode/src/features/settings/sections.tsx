import Settings from "lucide-react/dist/esm/icons/settings";
import Keyboard from "lucide-react/dist/esm/icons/keyboard";
import Globe from "lucide-react/dist/esm/icons/globe";
import FolderSymlink from "lucide-react/dist/esm/icons/folder-symlink";
import Info from "lucide-react/dist/esm/icons/info";
import Bot from "lucide-react/dist/esm/icons/bot";
import Smartphone from "lucide-react/dist/esm/icons/smartphone";
import ChartColumn from "lucide-react/dist/esm/icons/chart-column";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import i18n from "@/lib/i18n";
import type { SettingsNavItem } from "@/components/application/settings/settings-modal";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { settingsRegistry } from "@hzkcode/plugin-sdk";
import { cx } from "@/utils/cx";
import { GeneralSection } from "./GeneralSection";
import { ProxySection } from "./ProxySection";
import { WorkspacesSection } from "./WorkspacesSection";
import { AgentsPromptsSection } from "./agents-prompts/AgentsPromptsSection";
import { CliConfigSection } from "./CliConfigSection";
import { CliFeaturesSection } from "./CliFeaturesSection";
import { AboutSection } from "./AboutSection";
import { WebAccessSection } from "./WebAccessSection";
import { UsageSection } from "./UsageSection";
import { ShortcutsSection } from "@/features/shortcuts/ShortcutsSection";
import { ENGINE_IDS, type EngineId } from "./providers";

/**
 * Builtin settings sections, registered through the same extension-point
 * registry plugins use (plan §4.2 #1 — the settings page is the dogfood
 * surface). Module-scope side effect, imported once by SettingsPage; the
 * registry's upsert semantics make HMR re-runs harmless.
 *
 * Rail layout (see GROUP_META in SettingsPage): 模型与能力 keeps what the
 * engine runs (channels + the global feature switches), 应用 is the local
 * app's own settings, 数据与连接 covers agents/remote access/usage, and the
 * tail holds about. Feature switches live on their own page — the 模型配置
 * page stays channels + model answers only.
 */

/** Nav-rail mark for one CLI engine: the rail colors every icon
 *  foreground-icon-secondary (gray), which reads as disabled on a brand
 *  mark, so pin the wrapper at icon-primary. Image and gradient marks
 *  (claude) carry their own colors and ignore the text color either way. */
const engineNavIcon = (engine: EngineId): SettingsNavItem["icon"] => {
  const EngineNavIcon = ({ className }: { className?: string }) => (
    <EngineIcon engine={engine} size={20} className={cx(className, "text-foreground-icon-primary")} />
  );
  return EngineNavIcon;
};

ENGINE_IDS.forEach((engine) => {
  settingsRegistry.register({
    id: `cli:${engine}`,
    key: `cli:${engine}`,
    label: () => i18n.t("settings.cliConfig"),
    icon: engineNavIcon(engine),
    group: "model",
    // Leads the rail: the CLI's own configuration (endpoint, credential,
    // model mapping) is what every install has to touch first.
    order: 0,
    component: () => <CliConfigSection engine={engine} />,
  });
});
settingsRegistry.register({
  id: "features",
  key: "features",
  label: () => i18n.t("settings.features"),
  icon: SlidersHorizontal,
  group: "model",
  order: 1,
  component: CliFeaturesSection,
});
settingsRegistry.register({
  id: "general",
  key: "general",
  label: () => i18n.t("settings.general"),
  icon: Settings,
  group: "app",
  order: 0,
  component: GeneralSection,
});
settingsRegistry.register({
  id: "proxy",
  key: "proxy",
  label: () => i18n.t("settings.proxy"),
  icon: Globe,
  group: "app",
  order: 1,
  component: ProxySection,
});
settingsRegistry.register({
  id: "workspaces",
  key: "workspaces",
  label: () => i18n.t("settings.workspaces"),
  icon: FolderSymlink,
  group: "app",
  order: 2,
  component: WorkspacesSection,
});
settingsRegistry.register({
  id: "shortcuts",
  key: "shortcuts",
  label: () => i18n.t("shortcuts.sectionTitle"),
  icon: Keyboard,
  group: "app",
  order: 3,
  component: ShortcutsSection,
});
settingsRegistry.register({
  id: "agentsPrompts",
  key: "agentsPrompts",
  label: () => i18n.t("settings.agentsPrompts"),
  icon: Bot,
  group: "data",
  order: 0,
  component: AgentsPromptsSection,
});
settingsRegistry.register({
  id: "webAccess",
  key: "webAccess",
  label: () => i18n.t("settings.webAccess"),
  icon: Smartphone,
  group: "data",
  order: 1,
  component: WebAccessSection,
});
settingsRegistry.register({
  id: "usage",
  key: "usage",
  label: () => i18n.t("usage.title"),
  icon: ChartColumn,
  group: "data",
  order: 2,
  component: UsageSection,
});
settingsRegistry.register({
  id: "about",
  key: "about",
  label: () => i18n.t("settings.about"),
  icon: Info,
  group: "misc",
  order: 0,
  component: AboutSection,
});
