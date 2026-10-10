import { useState } from "react";
import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import FileText from "lucide-react/dist/esm/icons/file-text";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import { PillTab, PillTabList } from "@/components/base/tabs/pill-tab";
import { AgentsPane } from "./AgentsPane";
import { PromptsPane } from "./PromptsPane";
import { BehaviorPane } from "./BehaviorPane";

/**
 * 智能体 + 提示词 settings page: a pill-tab switcher between the agent
 * library (AgentsPane), the custom-prompt library (PromptsPane) and the
 * engine behaviour switches (BehaviorPane). Each pane owns its own store
 * subscriptions and dialogs; this shell only holds the active tab.
 */
export function AgentsPromptsSection() {
  const { t } = useTranslation();
  const [tab, setTab] = useState<"agents" | "prompts" | "behavior">("agents");

  return (
    <div className="flex w-full flex-col gap-4">
      <PillTabList>
        <PillTab
          variant="gray"
          icon={Bot}
          isSelected={tab === "agents"}
          onSelect={() => setTab("agents")}
        >
          {t("settings.agentPromptTabAgents")}
        </PillTab>
        <PillTab
          variant="gray"
          icon={FileText}
          isSelected={tab === "prompts"}
          onSelect={() => setTab("prompts")}
        >
          {t("settings.agentPromptTabPrompts")}
        </PillTab>
        <PillTab
          variant="gray"
          icon={SlidersHorizontal}
          isSelected={tab === "behavior"}
          onSelect={() => setTab("behavior")}
        >
          {t("settings.agentPromptTabBehavior")}
        </PillTab>
      </PillTabList>
      {tab === "agents" ? (
        <AgentsPane />
      ) : tab === "prompts" ? (
        <PromptsPane />
      ) : (
        <BehaviorPane />
      )}
    </div>
  );
}
