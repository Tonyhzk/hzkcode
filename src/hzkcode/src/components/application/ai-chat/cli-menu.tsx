"use client";

import { useState } from "react";
import type { Ref } from "react";
import { useTranslation } from "react-i18next";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { menuPopoverSurface } from "@/components/base/dropdown/menu-styles";
import { CLI_DISPLAY_NAMES } from "@/components/foundations/icons/engine-brands";
import { EngineIcon } from "@/components/foundations/icons/engine-icon";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";
import { EFFORT_LEVELS, EFFORT_LABEL_KEYS, type EffortLevel } from "./effort-levels";
import { EngineModelPanel, type ChannelOption } from "./engine-model-panel";

export type { EffortLevel } from "./effort-levels";

/**
 * Composer's model switcher. The product ships a single engine, so there is
 * no engine/tool layer to pick from: the trigger names the current pick —
 * "{model} · {effort}" — and the popover opens straight into the model
 * panel (search field over the model list over the effort slider). */

/** Model panel popover: same shadcn-style surface as the other ai_chat
 *  popovers — 8px radius, 4px padding, no header label. */
const PANEL_POPOVER_CLASSES = menuPopoverSurface({
  width: "w-80",
  origin: "origin-bottom-left",
  radius: "rounded-lg",
  padding: "p-1",
});

/* ---------------------------------------------------------------- options */

export interface MenuOption {
  id: string;
  label: string;
  /** Engine is installed and spawnable — drives the status dot. */
  available?: boolean;
  disabled?: boolean;
  disabledReason?: string;
}

export interface ModelOption {
  /** "" selects the CLI/provider default model. */
  id: string;
  label: string;
  /** Secondary line under the label (e.g. "Custom High model"). */
  description?: string;
  /** Catalog provider ("kimi-code"); derived from the "provider/model" id
   *  when the catalog entry is missing. Two or more distinct providers turn
   *  the list into labeled sections. */
  provider?: string;
}

/* --------------------------------------------------------------- trigger */

/** Trigger min-width lock while the popover is open: snapshot on open, clear
 *  on close, so shorter model labels can't shrink the trigger mid-session
 *  and slide the top-end popover. Adjusted during render (prev-prop pattern)
 *  so every open/close path — trigger press, outside press, Esc — flips it,
 *  not just onOpenChange. */
function useLockedMinWidth(isOpen: boolean, triggerRef: Ref<HTMLButtonElement>) {
  const [lockedMinWidth, setLockedMinWidth] = useState<number | undefined>();
  const [prevIsOpen, setPrevIsOpen] = useState(isOpen);
  if (prevIsOpen !== isOpen) {
    setPrevIsOpen(isOpen);
    if (!isOpen) {
      setLockedMinWidth(undefined);
    } else {
      const node =
        triggerRef && typeof triggerRef !== "function" ? triggerRef.current : null;
      if (node) setLockedMinWidth(node.offsetWidth);
    }
  }
  return lockedMinWidth;
}

/** Borderless trigger carrying the whole selection at a glance:
 *  "{model} · {effort}". The model part drops out when the engine has no
 *  model list at all — the engine name stands in. min-w-0 lets the trigger
 *  shrink instead of pushing the send button out of the composer on narrow
 *  widths; below md it collapses to icon + truncated model (aria-label
 *  carries the full selection). */
function CliMenuTrigger({
  triggerRef,
  engine,
  engineName,
  model,
  effort,
  isOpen,
}: {
  triggerRef: Ref<HTMLButtonElement>;
  engine: string;
  /** Display name of the active engine; the fallback label when the engine
   *  has no model list. */
  engineName: string;
  /** Selected model of the active engine, when it has a model list. */
  model: ModelOption | undefined;
  effort: EffortLevel;
  /** While open, lock the trigger's min-width so model picks don't shrink it
   *  and nudge the top-end popover. */
  isOpen: boolean;
}) {
  const { t } = useTranslation();
  // Snapshot width on open; clear on close. Shorter model labels then can't
  // shrink the trigger mid-session and slide the popover.
  const lockedMinWidth = useLockedMinWidth(isOpen, triggerRef);
  const selection = model ? model.label : engineName;
  return (
    <AriaButton
      ref={triggerRef}
      aria-label={`${selection} · ${t(EFFORT_LABEL_KEYS[effort])}`}
      style={lockedMinWidth ? { minWidth: lockedMinWidth } : undefined}
      className="group flex min-w-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 outline-none focus-visible:ring-2 focus-visible:ring-border-focus-ring"
    >
      <EngineIcon engine={engine} size={16} className="shrink-0 text-foreground-icon-secondary" />
      <span className="flex min-w-0 items-center gap-1 text-body-2-medium whitespace-nowrap text-text-secondary transition-colors duration-150 ease group-hover:text-text-primary">
        {model ? (
          <span className="max-w-44 truncate max-md:max-w-28">{model.label}</span>
        ) : (
          <span className="shrink-0 max-md:hidden">{engineName}</span>
        )}
        <span aria-hidden className="shrink-0 text-text-tertiary max-md:hidden">
          ·
        </span>
        {/* Reserve the widest localized level so the right-aligned popover stays put. */}
        <span className="inline-grid shrink-0 max-md:hidden">
          {EFFORT_LEVELS.map(level => (
            <span key={level} aria-hidden={level !== effort} className={cx("col-start-1 row-start-1", level !== effort && "invisible")}>
              {t(EFFORT_LABEL_KEYS[level])}
            </span>
          ))}
        </span>
      </span>
    </AriaButton>
  );
}

/* ------------------------------------------------------------------ menu */

/**
 * Model switcher: a borderless trigger that opens the model panel directly.
 * A model pick stays in-panel so effort can be adjusted without reopening.
 */
export function CliMenu({
  options,
  value,
  modelsByEngine,
  models,
  onModelChange,
  efforts,
  onEffortChange,
  channelsByEngine,
  selectedChannels,
  onChannelChange,
  onRefreshModels,
  loadingEngines,
}: {
  options: MenuOption[];
  value: string;
  /** Per-engine model lists; concrete ids only, CLI default first. */
  modelsByEngine: Record<string, ModelOption[]>;
  /** Selected model id per engine. */
  models: Record<string, string>;
  onModelChange: (engine: string, id: string) => void;
  /** Per-engine reasoning effort, rendered under the model list. */
  efforts: Record<string, EffortLevel>;
  onEffortChange: (engine: string, level: EffortLevel) => void;
  channelsByEngine?: Record<string, ChannelOption[]>;
  selectedChannels?: Record<string, string>;
  onChannelChange?: (engine: string, id: string) => void;
  /** Re-probe provider configs and model catalogs (panel refresh button). */
  onRefreshModels?: () => void | Promise<void>;
  /** Engine ids whose catalog probe has not returned yet (loading hint). */
  loadingEngines?: readonly string[];
}) {
  const { t } = useTranslation();
  const { isOpen, triggerRef, popoverRef, setOpen } = usePopoverState();
  const current = options.find((o) => o.id === value);
  const engineName = CLI_DISPLAY_NAMES[value] ?? current?.label ?? value;

  const selectedModelId = models[value] ?? "";
  const selectedModel = (modelsByEngine[value] ?? []).find((m) => m.id === selectedModelId);
  const triggerEffort: EffortLevel = efforts[value] ?? "medium";
  const [query, setQuery] = useState("");

  const handleOpenChange = (o: boolean) => {
    if (!setOpen(o)) return;
    if (!o) setQuery("");
  };

  // A model pick stays in-panel so effort can be adjusted in the same panel.
  const pickModel = (engine: string, id: string) => onModelChange(engine, id);
  const pickChannel = (engine: string, id: string) => onChannelChange?.(engine, id);

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={handleOpenChange}>
      <CliMenuTrigger
        triggerRef={triggerRef}
        engine={value}
        engineName={engineName}
        model={selectedModel}
        effort={triggerEffort}
        isOpen={isOpen}
      />

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top end"
        offset={8}
        className={PANEL_POPOVER_CLASSES}
      >
        <AriaDialog aria-label={t("chat.modelPicker")} className="outline-none">
          <EngineModelPanel
            option={current ?? { id: value, label: engineName }}
            models={modelsByEngine[value] ?? []}
            selectedModelId={selectedModelId}
            query={query}
            onQueryChange={setQuery}
            effort={triggerEffort}
            onPickModel={pickModel}
            onEffortChange={onEffortChange}
            channels={channelsByEngine?.[value]}
            selectedChannelId={selectedChannels?.[value]}
            onPickChannel={onChannelChange ? pickChannel : undefined}
            onRefresh={onRefreshModels}
            loading={loadingEngines?.includes(value)}
          />
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
