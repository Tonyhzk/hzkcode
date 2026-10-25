"use client";

import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import type { LucideIcon } from "lucide-react";
import Check from "lucide-react/dist/esm/icons/check";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { cx } from "@/utils/cx";
import { useDismissOnOutsidePress, useTriggerToggle } from "@/utils/use-dismiss-on-outside-press";
import {
  LEGACY_PLAN_OPTION,
  PERMISSION_BOUNDARY_OPTIONS,
  PERMISSION_SWITCH_OPTIONS,
} from "./composer-permissions";
import {
  BOUNDARY_MODES,
  DEFAULT_PERMISSION,
  getPermissionModeForBoundary,
  getPermissionModeSwitchAvailability,
  getPermissionSwitchMemory,
  nextModeSwitchMemory,
  permissionModeFromState,
  permissionModeLabelKeys,
  permissionModeStateFromMode,
  rememberPermissionSwitchMemory,
  resolvePermissionModeState,
  resolveSwitchProfiles,
  togglePermissionModeSwitch,
  type ComposerPermission,
  type PermissionBoundary,
  type PermissionSwitchKey,
  type PermissionSwitchProfiles,
} from "./permission-modes";

export type { ComposerPermission } from "./permission-modes";

/* Non-modal like every other composer menu: React Aria's popovers lock page
 * scroll by default, and the reflow that causes shunts sticky layout the
 * moment a menu opens. Non-modal also switches off React Aria's outside-press
 * dismissal, so the menu restores it with useDismissOnOutsidePress, the same
 * fix as Select and Dropdown. */
const PERMISSION_POPOVER = cx(
  "w-[360px] max-w-[calc(100vw-32px)]",
  "rounded-[20px] border border-border-button-default bg-background-primary-default p-1.5 shadow-dropdown",
  "transition duration-150 ease-out",
  "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
  "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
  "data-[placement=bottom]:origin-top-left data-[placement=top]:origin-bottom-left",
);

export interface PermissionMenuProps {
  /** Controlled mode. Left out, the picker keeps its own selection. */
  value?: ComposerPermission;
  defaultValue?: ComposerPermission;
  onChange?: (permission: ComposerPermission) => void;
  /** Where the header's "Learn more" link goes; the link renders only when a
   *  href or handler is provided (the app has no permission docs target yet). */
  learnMoreHref?: string;
  onLearnMore?: () => void;
  /** 当前引擎实际支持的模式（来自 EngineInfo.permissions）；省略表示全部可选。
   *  不支持的组合无法应用，选择器不会承诺引擎会忽略的模式。 */
  supported?: string[];
  className?: string;
}

interface PermissionDraft {
  mode: ComposerPermission;
  switchMemory: PermissionSwitchProfiles;
}

function draftFor(mode: ComposerPermission): PermissionDraft {
  return {
    mode,
    switchMemory: resolveSwitchProfiles(mode, getPermissionSwitchMemory()),
  };
}

interface PermissionRowProps {
  role: "radio" | "checkbox";
  icon: LucideIcon;
  flip?: boolean;
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onClick: () => void;
}

function PermissionRow({
  role,
  icon: Icon,
  flip,
  label,
  description,
  checked,
  disabled = false,
  title,
  onClick,
}: PermissionRowProps) {
  return (
    <button
      type="button"
      role={role}
      aria-checked={checked}
      aria-disabled={disabled || undefined}
      title={title}
      onClick={disabled ? undefined : onClick}
      className={cx(
        "flex w-full items-center gap-2 rounded-[14px] p-2 text-left outline-none transition-colors",
        disabled
          ? "cursor-not-allowed opacity-50"
          : "cursor-pointer hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
        checked && !disabled && "bg-background-primary-hover",
      )}
    >
      <Icon
        className={cx(
          "size-5 shrink-0 text-foreground-icon-secondary",
          flip && "-scale-y-100",
        )}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-body-medium text-text-secondary">
          {label}
        </span>
        <span className="truncate text-body-2-medium text-text-tertiary">
          {description}
        </span>
      </span>
      {role === "checkbox" ? (
        <span
          className={cx(
            "flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
            checked
              ? "border-button-primary bg-button-primary text-text-white"
              : "border-border-button-default",
          )}
          aria-hidden
        >
          {checked && <Check className="size-3" />}
        </span>
      ) : (
        <span
          className={cx(
            "size-2 shrink-0 rounded-full",
            checked
              ? "bg-button-primary"
              : "border border-border-button-default",
          )}
          aria-hidden
        />
      )}
    </button>
  );
}

/**
 * 权限选择器：边界（默认 / 只读 / 规划 / bypass）加三个开关决定真实模式。
 * 旧 `plan` 仍作为独立兼容行，只有当前选中时才显示，避免被当成新规划边界。
 * 弹层内全部是草稿；只有「应用」提交，取消与外点保持当前模式。
 */
export function PermissionMenu({
  value,
  defaultValue = DEFAULT_PERMISSION,
  onChange,
  learnMoreHref,
  onLearnMore,
  supported,
  className,
}: PermissionMenuProps) {
  const { t } = useTranslation();
  const [isOpen, setIsOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  useDismissOnOutsidePress(isOpen, () => setIsOpen(false), [triggerRef, popoverRef]);
  // Pressing the trigger while open closes the menu instead of reopening it.
  const allowOpenChange = useTriggerToggle(isOpen, triggerRef);
  const [internal, setInternal] = useState<ComposerPermission>(defaultValue);
  const selected = value ?? internal;
  const [draft, setDraft] = useState<PermissionDraft>(() => draftFor(selected));

  const modeSupported = (mode: ComposerPermission) =>
    supported === undefined || supported.includes(mode);
  const boundarySupported = (boundary: PermissionBoundary) =>
    BOUNDARY_MODES[boundary].some((mode) => modeSupported(mode));

  const state = resolvePermissionModeState(draft.mode, draft.switchMemory);
  const inView =
    permissionModeStateFromMode(draft.mode, draft.switchMemory) !== null;
  const applyDisabled = !modeSupported(draft.mode);

  const stageMode = (next: ComposerPermission) => {
    setDraft((prev) => ({
      mode: next,
      switchMemory: nextModeSwitchMemory(
        prev.mode,
        next,
        prev.switchMemory,
      ),
    }));
  };

  const stageBoundary = (boundary: PermissionBoundary) => {
    stageMode(
      getPermissionModeForBoundary(
        draft.mode,
        draft.switchMemory,
        boundary,
      ),
    );
  };

  const toggleSwitch = (key: PermissionSwitchKey) => {
    const next = togglePermissionModeSwitch(state, key);
    if (next === state) return;
    stageMode(permissionModeFromState(next));
  };

  const confirm = () => {
    if (applyDisabled) return;
    rememberPermissionSwitchMemory(draft.switchMemory);
    setInternal(draft.mode);
    if (draft.mode !== selected) onChange?.(draft.mode);
    setIsOpen(false);
  };

  const handleOpenChange = (next: boolean) => {
    if (!allowOpenChange(next)) return;
    if (next) setDraft(draftFor(selected));
    setIsOpen(next);
  };

  const currentLabel = permissionModeLabelKeys(selected)
    .map((key) => t(`chat.${key}`))
    .join(" · ");
  const currentBoundary: PermissionBoundary =
    selected === "plan"
      ? "plan"
      : resolvePermissionModeState(selected).boundary;
  const currentOption =
    PERMISSION_BOUNDARY_OPTIONS.find(
      (option) => option.id === currentBoundary,
    ) ?? PERMISSION_BOUNDARY_OPTIONS[0];
  const CurrentIcon = selected === "plan" ? LEGACY_PLAN_OPTION.icon : currentOption.icon;
  const currentFlip =
    selected === "plan" ? LEGACY_PLAN_OPTION.flip : currentOption.flip;
  const draftLabel = permissionModeLabelKeys(draft.mode)
    .map((key) => t(`chat.${key}`))
    .join(" · ");
  const showLegacyPlan = draft.mode === "plan" || selected === "plan";

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={handleOpenChange}>
      <AriaButton
        ref={triggerRef}
        aria-label={t("chat.permissionLabel", { label: currentLabel })}
        className={({ isHovered, isPressed, isFocusVisible }) =>
          cx(
            "flex h-[30px] shrink-0 cursor-pointer items-center gap-1 rounded-full py-[5px] pr-2.5 pl-2 outline-none transition-colors duration-150 ease",
            // Same surface as the model picker's hover: a step lighter than the
            // card in dark rather than darker.
            (isHovered || isPressed || isOpen) && "bg-background-primary-hover",
            isFocusVisible && "ring-2 ring-border-focus-ring",
            className,
          )
        }
      >
        <CurrentIcon
          className={cx(
            "size-4 shrink-0 text-foreground-icon-secondary",
            currentFlip && "-scale-y-100",
          )}
          aria-hidden
        />
        {/* Icon-only below md (aria-label on the trigger carries the mode);
            keeps the composer toolbar within narrow widths. */}
        <span className="text-body-medium whitespace-nowrap text-text-secondary max-md:hidden">
          {currentLabel}
        </span>
      </AriaButton>

      <AriaPopover
        ref={popoverRef}
        isNonModal
        placement="top start"
        offset={8}
        className={PERMISSION_POPOVER}
      >
        <AriaDialog
          aria-label={t("chat.permissionWorkMode")}
          className="flex max-h-[70vh] flex-col gap-1.5 overflow-y-auto pt-1 outline-none"
        >
          <div className="flex flex-col gap-0.5 px-2">
            <div className="flex items-center gap-2.5">
              <span className="min-w-0 flex-1 text-body-medium text-text-tertiary">
                {t("chat.permissionWorkMode")}
              </span>
              {(learnMoreHref || onLearnMore) &&
                (learnMoreHref ? (
                  <a
                    href={learnMoreHref}
                    target="_blank"
                    rel="noreferrer"
                    className="shrink-0 text-body-medium text-text-tertiary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                  >
                    {t("chat.permissionLearnMore")}
                  </a>
                ) : (
                  <button
                    type="button"
                    onClick={onLearnMore}
                    className="shrink-0 cursor-pointer text-body-medium text-text-tertiary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                  >
                    {t("chat.permissionLearnMore")}
                  </button>
                ))}
            </div>
            <span className="truncate text-body-2-medium text-text-secondary">
              {t("chat.permissionDraft", { label: draftLabel })}
            </span>
          </div>

          <div
            role="radiogroup"
            aria-label={t("chat.permissionWorkMode")}
            className="flex flex-col gap-1"
          >
            {PERMISSION_BOUNDARY_OPTIONS.map((option) => {
              const disabled = !boundarySupported(option.id);
              return (
                <PermissionRow
                  key={option.id}
                  role="radio"
                  icon={option.icon}
                  flip={option.flip}
                  label={t(`chat.${option.labelKey}`)}
                  description={t(`chat.${option.descriptionKey}`)}
                  checked={inView && state.boundary === option.id}
                  disabled={disabled}
                  title={disabled ? t("chat.permissionUnsupported") : undefined}
                  onClick={() => stageBoundary(option.id)}
                />
              );
            })}
          </div>

          <div className="flex flex-col gap-1 border-t border-border-primary-default pt-1.5">
            <span className="px-2 text-body-medium text-text-tertiary">
              {t("chat.permissionSwitchGroup")}
            </span>
            <div
              role="group"
              aria-label={t("chat.permissionSwitchGroup")}
              className="flex flex-col gap-1"
            >
              {PERMISSION_SWITCH_OPTIONS.map((option) => {
                const availability = getPermissionModeSwitchAvailability(
                  state,
                  option.id,
                );
                const disabled = availability !== "available";
                const checked =
                  availability === "included" ||
                  state.switches[option.id];
                const description =
                  availability === "included"
                    ? t("chat.permissionSwitchIncluded")
                    : availability === "disabled"
                      ? t("chat.permissionSwitchDisabled")
                      : t(`chat.${option.descriptionKey}`);
                return (
                  <PermissionRow
                    key={option.id}
                    role="checkbox"
                    icon={option.icon}
                    label={t(`chat.${option.labelKey}`)}
                    description={description}
                    checked={checked}
                    disabled={disabled}
                    title={disabled ? description : undefined}
                    onClick={() => toggleSwitch(option.id)}
                  />
                );
              })}
            </div>
          </div>

          {showLegacyPlan && (
            <div
              role="radiogroup"
              aria-label={t("chat.permissionLegacyPlan")}
              className="flex flex-col gap-1 border-t border-border-primary-default pt-1.5"
            >
              <PermissionRow
                role="radio"
                icon={LEGACY_PLAN_OPTION.icon}
                flip={LEGACY_PLAN_OPTION.flip}
                label={t(`chat.${LEGACY_PLAN_OPTION.labelKey}`)}
                description={t(`chat.${LEGACY_PLAN_OPTION.descriptionKey}`)}
                checked={draft.mode === "plan"}
                disabled={!modeSupported("plan")}
                title={
                  modeSupported("plan")
                    ? undefined
                    : t("chat.permissionUnsupported")
                }
                onClick={() => stageMode("plan")}
              />
            </div>
          )}

          <div className="flex items-center justify-end gap-1 border-t border-border-primary-default px-1 pt-1.5">
            <button
              type="button"
              onClick={() => setIsOpen(false)}
              className="cursor-pointer rounded-lg px-2.5 py-1 text-body-medium text-text-tertiary outline-none transition-colors hover:bg-background-primary-hover hover:text-text-secondary focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              {t("common.cancel")}
            </button>
            <button
              type="button"
              disabled={applyDisabled}
              title={
                applyDisabled ? t("chat.permissionUnsupported") : undefined
              }
              onClick={confirm}
              className={cx(
                "rounded-lg px-2.5 py-1 text-body-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-border-focus-ring",
                applyDisabled
                  ? "cursor-not-allowed bg-background-primary-hover text-text-tertiary"
                  : "cursor-pointer bg-button-primary text-text-white hover:opacity-90",
              )}
            >
              {t("chat.permissionApply")}
            </button>
          </div>
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
