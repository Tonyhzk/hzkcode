import { useState, type FormEvent } from "react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/base/buttons/button";
import { Checkbox } from "@/components/base/checkbox/checkbox";
import { Input } from "@/components/base/input/input";
import { Select, SelectItem } from "@/components/base/select/select";
import { TextArea } from "@/components/base/input/textarea";
import { ModalShell } from "@/components/dialogs";
import { cx } from "@/utils/cx";
import type { AgentConfig } from "@/lib/ipc";
import { TOOL_CATALOG, TOOL_CATALOG_NAMES } from "@/features/agents/tool-catalog";
import i18n from "@/lib/i18n";

/** Emoji quick-pick row under the icon field — one click fills the input. */
const QUICK_ICONS = ["🤖", "🧠", "🛠️", "🎨", "📝", "🔍", "🧪", "📊", "🚀", "💡", "🐛", "📚"];

const NAME_MAX = 64;
const PROMPT_MAX = 100000;
const UNSET_OPTION_ID = "__unset__";

/** Identity model: an engine alias resolved against the channel, or follow. */
const MODEL_OPTIONS: readonly { id: string; labelKey: string }[] = [
  { id: UNSET_OPTION_ID, labelKey: "settings.agentModelFollow" },
  { id: "opus", labelKey: "settings.agentModelHigh" },
  { id: "sonnet", labelKey: "settings.agentModelMid" },
  { id: "haiku", labelKey: "settings.agentModelLow" },
];

const EFFORT_OPTIONS = ["low", "medium", "high", "xhigh", "max"] as const;

/** Context components (CLI identity frontmatter values, in card order). */
const CONTEXT_COMPONENTS: readonly { id: string; labelKey: string }[] = [
  { id: "prompts", labelKey: "settings.agentContextPrompts" },
  { id: "claudemd", labelKey: "settings.agentContextClaudemd" },
  { id: "memory", labelKey: "settings.agentContextMemory" },
];

export interface AgentEditorValue {
  name: string;
  prompt?: string;
  icon?: string;
  /** Tool whitelist; null keeps every tool available (all boxes checked). */
  tools: string[] | null;
  /** Engine alias (opus/sonnet/haiku) or null to follow the session. */
  model: string | null;
  /** Context components; null injects the full set. */
  context: string[] | null;
  /** Reasoning effort or null to follow the session. */
  effort: string | null;
}

/**
 * Create/edit one agent. The parent owns the store mutation (and its error
 * reporting); this dialog only collects and validates the fields, then calls
 * onSubmit with trimmed values. The prompt is required — the engine rejects
 * empty agent prompts, and the definition is what carries the identity's
 * tool/model/context settings on resume.
 */
export function AgentEditorDialog({
  initial,
  onSubmit,
  onCancel,
}: {
  /** Present in edit mode; absent creates a new agent. */
  initial?: AgentConfig;
  onSubmit: (value: AgentEditorValue) => void;
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [name, setName] = useState(initial?.name ?? "");
  const [icon, setIcon] = useState(initial?.icon ?? "");
  const [prompt, setPrompt] = useState(initial?.prompt ?? "");
  // Tool whitelist: no stored list means "everything allowed", which the
  // picker shows as all boxes checked (and stores back as null).
  const [tools, setTools] = useState<Set<string>>(
    () => new Set(initial?.tools ?? TOOL_CATALOG_NAMES),
  );
  const [model, setModel] = useState(initial?.model ?? "");
  const [context, setContext] = useState<Set<string>>(
    () => new Set(initial?.context ?? CONTEXT_COMPONENTS.map((c) => c.id)),
  );
  const [effort, setEffort] = useState(initial?.effort ?? "");

  const catalogLanguage: "zh" | "en" = i18n.resolvedLanguage?.startsWith("en")
    ? "en"
    : "zh";

  const trimmedName = name.trim();
  const valid =
    trimmedName.length > 0 &&
    trimmedName.length <= NAME_MAX &&
    prompt.trim().length > 0 &&
    prompt.length <= PROMPT_MAX;

  const toggleTool = (tool: string, on: boolean) => {
    setTools((prev) => {
      const next = new Set(prev);
      if (on) next.add(tool);
      else next.delete(tool);
      return next;
    });
  };
  const toggleContext = (component: string, on: boolean) => {
    setContext((prev) => {
      const next = new Set(prev);
      if (on) next.add(component);
      else next.delete(component);
      return next;
    });
  };

  const allContextChecked =
    context.size === CONTEXT_COMPONENTS.length;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!valid) return;
    onSubmit({
      name: trimmedName,
      icon: icon.trim() || undefined,
      prompt: prompt.trim(),
      // The picker is a whitelist: the checked set is saved explicitly even
      // when everything is checked (unlisted built-ins must stay denied);
      // only agents from before this field existed keep "unrestricted".
      tools: TOOL_CATALOG_NAMES.filter((tool) => tools.has(tool)),
      model: model || null,
      context: allContextChecked
        ? null
        : CONTEXT_COMPONENTS.map((c) => c.id).filter((id) => context.has(id)),
      effort: effort || null,
    });
  };

  return (
    <ModalShell
      onClose={onCancel}
      label={initial ? t("settings.agentDialogEdit") : t("settings.agentDialogNew")}
      className="w-[560px]"
    >
      <form
        onSubmit={submit}
        className="flex max-h-[72vh] flex-col gap-3 overflow-y-auto pr-1"
      >
        <Input
          label={t("settings.agentName")}
          placeholder={t("settings.agentNamePlaceholder")}
          value={name}
          onChange={setName}
          maxLength={NAME_MAX}
          size="small"
          autoFocus
        />
        <div className="flex flex-col gap-1.5">
          <Input
            label={t("settings.agentIcon")}
            placeholder={t("settings.agentIconPlaceholder")}
            value={icon}
            onChange={setIcon}
            size="small"
          />
          <div className="flex flex-wrap gap-1 px-1">
            {QUICK_ICONS.map((emoji) => (
              <button
                key={emoji}
                type="button"
                aria-label={emoji}
                onClick={() => setIcon(emoji)}
                className={cx(
                  "flex size-8 cursor-pointer items-center justify-center rounded-lg text-base",
                  "transition-colors hover:bg-background-secondary-hover",
                  "outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                  icon === emoji && "bg-background-tertiary-default",
                )}
              >
                {emoji}
              </button>
            ))}
          </div>
        </div>
        <TextArea
          label={t("settings.agentPromptLabel")}
          placeholder={t("settings.agentPromptPlaceholder")}
          value={prompt}
          onChange={setPrompt}
          maxLength={PROMPT_MAX}
          rows={5}
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-body-medium text-text-secondary">
            {t("settings.agentModelLabel")}
          </span>
          <Select
            aria-label={t("settings.agentModelLabel")}
            selectedKey={model || UNSET_OPTION_ID}
            onSelectionChange={(key) =>
              setModel(key === UNSET_OPTION_ID ? "" : String(key))
            }
          >
            {MODEL_OPTIONS.map((option) => (
              <SelectItem key={option.id} id={option.id}>
                {t(option.labelKey)}
              </SelectItem>
            ))}
          </Select>
          <p className="text-body-2-regular text-text-tertiary">
            {t("settings.agentModelHint")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-body-medium text-text-secondary">
            {t("settings.agentEffortLabel")}
          </span>
          <Select
            aria-label={t("settings.agentEffortLabel")}
            selectedKey={effort || UNSET_OPTION_ID}
            onSelectionChange={(key) =>
              setEffort(key === UNSET_OPTION_ID ? "" : String(key))
            }
          >
            <SelectItem id={UNSET_OPTION_ID}>
              {t("settings.agentEffortFollow")}
            </SelectItem>
            {EFFORT_OPTIONS.map((level) => (
              <SelectItem key={level} id={level}>
                {level}
              </SelectItem>
            ))}
          </Select>
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-body-medium text-text-secondary">
            {t("settings.agentContextLabel")}
          </span>
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            {CONTEXT_COMPONENTS.map((component) => (
              <Checkbox
                key={component.id}
                size="sm"
                isSelected={context.has(component.id)}
                onChange={(on) => toggleContext(component.id, on)}
              >
                {t(component.labelKey)}
              </Checkbox>
            ))}
          </div>
          <p className="text-body-2-regular text-text-tertiary">
            {t("settings.agentContextHint")}
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <div className="flex items-center justify-between gap-3">
            <span className="text-body-medium text-text-secondary">
              {t("settings.agentToolsLabel")}
            </span>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => setTools(new Set(TOOL_CATALOG_NAMES))}
                className={cx(
                  "cursor-pointer text-body-2-regular text-text-tertiary",
                  "hover:text-text-secondary",
                )}
              >
                {t("settings.agentToolsSelectAll")}
              </button>
              <button
                type="button"
                onClick={() => setTools(new Set())}
                className={cx(
                  "cursor-pointer text-body-2-regular text-text-tertiary",
                  "hover:text-text-secondary",
                )}
              >
                {t("settings.agentToolsClearAll")}
              </button>
            </div>
          </div>
          <div
            className={cx(
              "flex max-h-56 flex-col gap-3 overflow-y-auto rounded-lg",
              "border border-border-secondary p-2.5",
            )}
          >
            {TOOL_CATALOG.map((group) => (
              <div key={group.id} className="flex flex-col gap-1.5">
                <span className="text-body-2-medium text-text-tertiary">
                  {group.title[catalogLanguage]}
                </span>
                <div className="grid grid-cols-2 gap-x-3 gap-y-1">
                  {group.entries.map((entry) => (
                    <Checkbox
                      key={entry.name}
                      size="sm"
                      isSelected={tools.has(entry.name)}
                      onChange={(on) => toggleTool(entry.name, on)}
                    >
                      <span className="flex min-w-0 items-baseline gap-1.5">
                        <span className="truncate">
                          {entry.label[catalogLanguage]}
                        </span>
                        <span className="shrink-0 text-body-2-regular text-text-tertiary">
                          {entry.name}
                        </span>
                      </span>
                    </Checkbox>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <p className="text-body-2-regular text-text-tertiary">
            {t("settings.agentToolsHint")}
          </p>
        </div>

        <div className="mt-1 flex justify-end gap-2">
          <Button variant="secondary" size="small" onClick={onCancel}>
            {t("common.cancel")}
          </Button>
          <Button type="submit" variant="primary" size="small" disabled={!valid}>
            {initial ? t("common.confirm") : t("common.create")}
          </Button>
        </div>
      </form>
    </ModalShell>
  );
}
