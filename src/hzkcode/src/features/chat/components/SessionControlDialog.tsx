import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import UserRound from "lucide-react/dist/esm/icons/user-round";
import { Button } from "@/components/base/buttons/button";
import type { SessionControlApply, SessionControlState } from "@/lib/ipc";
import { cx } from "@/utils/cx";
import { formatTokens } from "@/utils/format-tokens";
import type { SessionIdentityOption } from "../session-control-view";
import {
  LARGE_PROMPT_TOKENS,
  identityDisplayName,
  identityGroupLabelKey,
  promptSizeFromUsage,
} from "../session-control-view";

/**
 * 身份应用对话框：身份列表 + 应用方式 + 缓存重建提示。
 * 选择由调用方保持（失败时弹层与选中项不丢），本组件只负责把
 * 「身份 + 方式」交给上层执行。
 */
export function SessionControlDialog({
  identities,
  initialIdentity,
  state,
  usage,
  busy,
  disabled = false,
  error,
  onApply,
  onClose,
  onRefresh,
}: {
  identities: SessionIdentityOption[];
  initialIdentity: SessionIdentityOption;
  state: SessionControlState | null;
  usage?: unknown;
  busy: boolean;
  /** 会话运行中：保留弹层与选择，只禁止应用。 */
  disabled?: boolean;
  error?: string | null;
  onApply: (identity: SessionIdentityOption, apply: SessionControlApply) => void;
  onClose: () => void;
  onRefresh?: () => void;
}) {
  const { t } = useTranslation();
  const [selected, setSelected] = useState<SessionIdentityOption>(initialIdentity);
  const [apply, setApply] = useState<SessionControlApply>("current");

  // 弹层每次由 Host 以新 key 重挂载；目录刷新只更新列表与描述，
  // 不覆盖用户已经改过的选择。

  const hasConversation = state?.hasConversation === true;
  const methods = useMemo(
    () => state?.availableApplyMethods.identity ?? [],
    [state],
  );

  // 默认身份不能追加：已选追加时退回当前会话。
  useEffect(() => {
    if (selected.value === null && apply === "append") setApply("current");
  }, [selected, apply]);

  useEffect(() => {
    if (!methods.includes(apply)) setApply(methods[0] ?? "current");
  }, [methods, apply]);

  const size = promptSizeFromUsage(usage);
  const isLarge = size !== null && size.promptTokens >= LARGE_PROMPT_TOKENS;
  // 目录刷新后以最新条目为准（描述可能变化），值相同时保持选中，
  // 不因 initialIdentity 换了对象而重置用户刚做的选择。
  const activeIdentity =
    identities.find((option) => option.value === selected.value) ?? selected;
  const base = state
    ? identityDisplayName(state.identity.base, identities)
    : null;
  const extensions = state
    ? state.identity.extensions.map(
        (extension) =>
          identityDisplayName(extension.agentType, identities) ??
          extension.agentType,
      )
    : [];

  const canApply =
    !busy &&
    !disabled &&
    state !== null &&
    methods.length > 0 &&
    (!hasConversation ||
      (methods.includes(apply) &&
        (activeIdentity.value !== null || apply !== "append")));

  const groupLabel = (option: SessionIdentityOption) => t(
    identityGroupLabelKey(option.group),
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/40"
      onClick={() => {
        if (!busy) onClose();
      }}
    >
      <div
        role="dialog"
        aria-label={t("chat.sessionIdentityTitle")}
        data-testid="session-control-dialog"
        className="flex max-h-[80vh] w-[440px] flex-col rounded-2lg border border-border-button-default bg-background-primary-default p-4 shadow-lg"
        onClick={(event) => event.stopPropagation()}
      >
        <p className="text-body-medium text-text-primary">
          {t("chat.sessionIdentityTitle")}
        </p>
        <div className="mt-1 flex flex-col gap-0.5 text-caption-1-regular text-text-tertiary">
          <span>
            {t("chat.sessionIdentityCurrent")}
            {": "}
            {base ?? t("chat.sessionIdentityNone")}
          </span>
          <span>
            {t("chat.sessionIdentityAppended")}
            {": "}
            {extensions.length > 0
              ? extensions.join(t("chat.sessionIdentityJoin"))
              : t("chat.sessionIdentityNone")}
          </span>
        </div>

        <div
          role="radiogroup"
          aria-label={t("chat.sessionIdentityTitle")}
          className="mt-3 min-h-0 flex-1 overflow-y-auto rounded-lg border border-border-primary-default p-1"
        >
          {identities.map((option, index) => {
            const showHeader =
              index === 0 || identities[index - 1]!.group !== option.group;
            const checked = selected.value === option.value;
            return (
              <div key={option.value ?? "__default__"}>
                {showHeader && (
                  <div className="px-2 pt-1.5 pb-1 text-caption-1-medium text-text-tertiary select-none">
                    {groupLabel(option)}
                  </div>
                )}
                <button
                  type="button"
                  role="radio"
                  aria-checked={checked}
                  data-identity={option.value ?? "__default__"}
                  onClick={() => setSelected(option)}
                  className={cx(
                    "flex w-full cursor-pointer items-center gap-2 rounded-lg px-2 py-1.5 text-left outline-none transition-colors",
                    "hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
                    checked && "bg-background-primary-hover",
                  )}
                >
                  {option.group === "default" ? (
                    <UserRound
                      aria-hidden
                      className="size-4 shrink-0 text-foreground-icon-secondary"
                    />
                  ) : option.icon ? (
                    <span aria-hidden className="w-4 shrink-0 text-center text-body-regular">
                      {option.icon}
                    </span>
                  ) : (
                    <Bot
                      aria-hidden
                      className="size-4 shrink-0 text-foreground-icon-secondary"
                    />
                  )}
                  <span className="min-w-0 flex-1 truncate text-body-regular text-text-primary">
                    {option.name}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        {hasConversation ? (
          <div className="mt-3 flex flex-col gap-1">
            <span className="text-caption-1-medium text-text-tertiary">
              {t("chat.sessionApplyMethod")}
            </span>
            <div role="radiogroup" aria-label={t("chat.sessionApplyMethod")}>
              {methods.map((method) => {
                const disabled = method === "append" && selected.value === null;
                return (
                  <button
                    key={method}
                    type="button"
                    role="radio"
                    aria-checked={apply === method}
                    aria-disabled={disabled || undefined}
                    data-apply={method}
                    disabled={disabled}
                    onClick={() => !disabled && setApply(method)}
                    className={cx(
                      "flex w-full flex-col rounded-lg px-2 py-1.5 text-left outline-none transition-colors",
                      disabled
                        ? "cursor-not-allowed opacity-50"
                        : "cursor-pointer hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
                      apply === method && !disabled && "bg-background-primary-hover",
                    )}
                  >
                    <span className="text-body-2-medium text-text-primary">
                      {t(`chat.sessionApply${method[0]!.toUpperCase()}${method.slice(1)}`)}
                    </span>
                    <span className="text-caption-1-regular text-text-tertiary">
                      {t(`chat.sessionApply${method[0]!.toUpperCase()}${method.slice(1)}Desc`)}
                    </span>
                  </button>
                );
              })}
            </div>
            <div
              data-testid="session-cache-hint"
              data-large={isLarge || undefined}
              className="px-1"
            >
              <p
                className={cx(
                  "text-caption-1-regular",
                  isLarge ? "text-text-error-primary" : "text-text-tertiary",
                )}
              >
                {isLarge
                  ? t("chat.sessionCacheLarge", {
                      tokens: formatTokens(size!.promptTokens),
                    })
                  : t("chat.sessionCacheRebuild")}
              </p>
              {size !== null && (size.cacheRead > 0 || size.cacheWrite > 0) && (
                <p className="text-caption-1-regular text-text-tertiary">
                  {t("chat.sessionCacheUsage", {
                    read: formatTokens(size.cacheRead),
                    write: formatTokens(size.cacheWrite),
                  })}
                </p>
              )}
            </div>
          </div>
        ) : (
          state !== null && (
            <p className="mt-2 px-1 text-caption-1-regular text-text-tertiary">
              {t("chat.sessionApplyDirect")}
            </p>
          )
        )}

        {state === null && (
          <div className="mt-2 flex items-center justify-between gap-2 px-1">
            <span className="text-caption-1-regular text-text-tertiary">
              {t("chat.sessionStateUnavailable")}
            </span>
            {onRefresh && (
              <button
                type="button"
                onClick={onRefresh}
                className="shrink-0 cursor-pointer text-caption-1-medium text-text-link-default outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                {t("common.refresh")}
              </button>
            )}
          </div>
        )}

        {disabled && (
          <p className="mt-2 px-1 text-caption-1-regular text-text-tertiary">
            {t("chat.sessionControlRunning")}
          </p>
        )}

        {error && (
          <p role="alert" className="mt-2 text-body-2-regular text-text-error-primary">
            {error}
          </p>
        )}

        <div className="mt-3 flex justify-end gap-2">
          <Button variant="secondary" size="small" disabled={busy} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            size="small"
            disabled={!canApply}
            onClick={() => onApply(activeIdentity, hasConversation ? apply : "current")}
          >
            {busy ? t("chat.sessionApplying") : t("chat.sessionApply")}
          </Button>
        </div>
      </div>
    </div>
  );
}
