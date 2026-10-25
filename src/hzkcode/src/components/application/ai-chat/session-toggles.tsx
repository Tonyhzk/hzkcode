import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import SlidersHorizontal from "lucide-react/dist/esm/icons/sliders-horizontal";
import { useNavigate } from "react-router-dom";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { Input } from "@/components/base/input/input";
import { Tooltip, TooltipContent } from "@/components/base/tooltip/tooltip";
import { isUsableSessionProxyUrl } from "@/components/application/ai-chat/proxy-url";
import { ipc } from "@/lib/ipc";
import { listenSettingsChanged } from "@/lib/events";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { parseContextWindowDraft } from "@/features/chat/context-window-draft";
import { useAgentStore } from "@/features/agents/agent-store";
import { usePendingIdentityStore } from "@/features/agents/pending-identity";
import type { ApiModeChoice, PromptModeChoice } from "@/features/chat/session-control-view";
import {
  EMPTY_SESSION_CONTROL_CATALOG,
  LARGE_PROMPT_TOKENS,
  identityDisplayName,
  promptSizeFromUsage,
  sessionControlErrorKey,
  sessionIdentityOptions,
} from "@/features/chat/session-control-view";
import { formatTokens } from "@/utils/format-tokens";
import { cx } from "@/utils/cx";
import { usePopoverState } from "@/utils/use-dismiss-on-outside-press";

/** 会话 API 协议的可选值；reset 回到渠道模型默认。 */
const API_MODES: Exclude<ApiModeChoice, "reset">[] = [
  "anthropic",
  "responses",
  "chat_completions",
];

function apiModeLabel(mode: string, t: (key: string) => string): string {
  switch (mode) {
    case "anthropic":
      return t("chat.sessionApiModeAnthropic");
    case "responses":
      return t("chat.sessionApiModeResponses");
    case "chat_completions":
      return t("chat.sessionApiModeChatCompletions");
    default:
      return mode;
  }
}

/**
 * Per-session switches for the composer footer — the conversation-side
 * adaptation of the CLI's session commands: 会话代理 (`/proxy`, pins
 * HZKCODE_PROXY_ENABLED on the configured address), 第二大脑
 * (`/second-brain`), 上下文窗口 (`/maxtokens`), plus the 3.5.1 offline
 * session-control entries (提示词模式 / 身份 / 持续模式 / API 协议).
 * 跟随默认 keeps the app/shell default; every GUI send is its own process,
 * so the choices ride each send of this session (session-control entries are
 * saved in the session file instead).
 */
export function SessionToggles() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const {
    isOpen,
    triggerRef,
    popoverRef,
    close,
    setOpen,
    shouldCloseOnInteractOutside,
  } = usePopoverState();

  const active = useChatStore((s) => s.active);
  const sessionKeyValue = useChatStore((s) => {
    const a = s.active;
    return a ? sessionKey(a.engine, a.sessionId, a.workspacePath) : null;
  });
  const proxyEnabled = useChatStore((s) => {
    const a = s.active;
    if (!a) return null;
    const key = sessionKey(a.engine, a.sessionId, a.workspacePath);
    return s.bySession[key]?.proxyEnabled ?? null;
  });
  const secondBrainEnabled = useChatStore((s) => {
    const a = s.active;
    if (!a) return null;
    const key = sessionKey(a.engine, a.sessionId, a.workspacePath);
    return s.bySession[key]?.secondBrainEnabled ?? null;
  });
  const autoCompactWindow = useChatStore((s) => {
    const a = s.active;
    if (!a) return null;
    const key = sessionKey(a.engine, a.sessionId, a.workspacePath);
    return s.bySession[key]?.autoCompactWindow ?? null;
  });
  const setSessionProxy = useChatStore((s) => s.setSessionProxy);
  const setSessionSecondBrain = useChatStore((s) => s.setSessionSecondBrain);
  const setSessionAutoCompactWindow = useChatStore(
    (s) => s.setSessionAutoCompactWindow,
  );

  // 3.5.1 离线会话控制：状态由 state 层刷新并保存在会话里。
  const sessionControl = useChatStore((s) => {
    const a = s.active;
    if (!a) return null;
    const key = sessionKey(a.engine, a.sessionId, a.workspacePath);
    return s.bySession[key]?.sessionControl ?? null;
  });
  const controlBusy = useChatStore((s) => s.controlBusy);
  const usage = useChatStore((s) => {
    const a = s.active;
    if (!a) return null;
    const key = sessionKey(a.engine, a.sessionId, a.workspacePath);
    return s.bySession[key]?.usage ?? null;
  });
  const streaming = useChatStore((s) => {
    const a = s.active;
    if (!a) return false;
    const key = sessionKey(a.engine, a.sessionId, a.workspacePath);
    return s.bySession[key]?.streaming ?? false;
  });
  const refreshSessionControl = useChatStore((s) => s.refreshSessionControl);
  const applySessionControl = useChatStore((s) => s.applySessionControl);
  const requestIdentity = usePendingIdentityStore((s) => s.requestIdentity);
  const agents = useAgentStore((s) => s.agents);
  const builtInAgents = useAgentStore((s) => s.builtInAgents);

  const controlState = sessionControl?.state ?? null;
  const controlCatalog =
    sessionControl?.catalog ?? EMPTY_SESSION_CONTROL_CATALOG;
  const identityOptions = useMemo(
    () =>
      sessionIdentityOptions({
        catalog: controlCatalog,
        agents,
        builtInAgents,
        defaultName: t("chat.sessionIdentityDefault"),
      }),
    [controlCatalog, agents, builtInAgents, t],
  );
  const interactionModes = useMemo(
    () =>
      controlCatalog.interactionModes.filter((mode) => mode.slug !== "default"),
    [controlCatalog],
  );

  const [controlError, setControlError] = useState<string | null>(null);
  const [pendingPrompt, setPendingPrompt] = useState<PromptModeChoice | null>(
    null,
  );
  const disabled = streaming || controlBusy;
  // 提示词模式的应用方式由引擎给出的可用方式决定，不能拿 hasConversation
  // 代替：已有历史可能只含模型不可见的元数据指导。
  const promptMethods = controlState?.availableApplyMethods.promptMode ?? [];
  const promptSize = promptSizeFromUsage(usage);
  const promptSizeLarge =
    promptSize !== null && promptSize.promptTokens >= LARGE_PROMPT_TOKENS;

  // 每次打开菜单或切换会话都重读一次权威状态（catalog + state）；失败
  // 保留上一次结果，不把旧选择当成已生效。
  useEffect(() => {
    if (!isOpen) return;
    setControlError(null);
    setPendingPrompt(null);
    // 自带角色名称随语言本地化；尚未加载时补读一次，避免身份入口显示
    // 稳定 id 或误回退到默认身份。
    const agentStore = useAgentStore.getState();
    if (!agentStore.loaded) void agentStore.refresh();
    let cancelled = false;
    void refreshSessionControl().then((result) => {
      // 切换会话或关闭弹层后，旧读取结果不能写到新会话的界面上。
      if (cancelled) return;
      if (!result) {
        setControlError(t("chat.sessionStateUnavailable"));
        return;
      }
      if (result.is_error) {
        setControlError(t(sessionControlErrorKey(result.error_code)));
      }
    });
    return () => {
      cancelled = true;
    };
  }, [isOpen, sessionKeyValue, refreshSessionControl, t]);

  // The address the CLI reads for `HZKCODE_PROXY_ENABLED=1` (模型配置 → 功能
  // 开关 → 会话代理地址 already writes this key).
  const [address, setAddress] = useState<string | null>(null);
  const read = useCallback(() => {
    void ipc
      .getAppSettings()
      .then((s) => setAddress(s.cliEnv?.HZKCODE_PROXY_URL?.trim() || null))
      .catch(() => {});
  }, []);
  useEffect(() => read(), [read]);
  useTauriEvent(() => listenSettingsChanged(read));

  // Draft for the context-window input: re-synced when the popover opens and
  // whenever the stored override changes.
  const [windowDraft, setWindowDraft] = useState("");
  const [windowError, setWindowError] = useState(false);
  useEffect(() => {
    if (!isOpen) return;
    setWindowDraft(autoCompactWindow == null ? "" : String(autoCompactWindow));
    setWindowError(false);
  }, [isOpen, autoCompactWindow]);

  // A typed value must not be silently dropped: closing the popover (a click
  // outside lands the popover's dismiss) commits a valid, changed draft the
  // same way Enter and 应用 do. Invalid drafts are still discarded.
  const windowDraftRef = useRef(windowDraft);
  windowDraftRef.current = windowDraft;
  const autoCompactWindowRef = useRef(autoCompactWindow);
  autoCompactWindowRef.current = autoCompactWindow;
  const sessionKeyRef = useRef(sessionKeyValue);
  sessionKeyRef.current = sessionKeyValue;
  const wasOpenRef = useRef(false);
  useEffect(() => {
    const wasOpen = wasOpenRef.current;
    wasOpenRef.current = isOpen;
    if (!wasOpen || isOpen) return;
    const key = sessionKeyRef.current;
    if (!key) return;
    const value = parseContextWindowDraft(windowDraftRef.current);
    if (value == null || value === autoCompactWindowRef.current) return;
    setSessionAutoCompactWindow(key, value);
  }, [isOpen, setSessionAutoCompactWindow]);

  if (!active || !sessionKeyValue) return null;

  const selectProxy = (value: boolean | null) => {
    setSessionProxy(sessionKeyValue, value);
    close();
  };
  const selectBrain = (value: boolean | null) => {
    setSessionSecondBrain(sessionKeyValue, value);
    close();
  };
  // The CLI's /maxtokens as a control: a positive token count pinned on the
  // next sends; 恢复默认 clears the override (an empty draft fails validation
  // rather than standing for the default). Enter, 应用, and closing the
  // popover after an edit all commit the same way.
  const applyWindow = () => {
    const value = parseContextWindowDraft(windowDraft);
    if (value == null) {
      setWindowError(true);
      return;
    }
    setWindowError(false);
    setSessionAutoCompactWindow(sessionKeyValue, value);
  };
  const resetWindow = () => {
    setWindowError(false);
    setSessionAutoCompactWindow(sessionKeyValue, null);
    setWindowDraft("");
  };
  const proxyUsable = isUsableSessionProxyUrl(address);
  const proxyOptions: { value: boolean | null; label: string; disabled?: boolean }[] = [
    { value: null, label: t("chat.sessionProxyFollow") },
    { value: true, label: t("chat.sessionProxyOn"), disabled: !proxyUsable },
    { value: false, label: t("chat.sessionProxyOff") },
  ];
  const brainOptions: { value: boolean | null; label: string; disabled?: boolean }[] = [
    { value: null, label: t("chat.sessionProxyFollow") },
    { value: true, label: t("chat.sessionProxyOn") },
    { value: false, label: t("chat.sessionProxyOff") },
  ];

  const applyControl = async (
    command: Parameters<typeof applySessionControl>[0],
  ) => {
    if (disabled) return false;
    const keyAtStart = sessionKeyValue;
    setControlError(null);
    const ok = await applySessionControl(command);
    // 等待期间切换了会话：不把旧会话的结果写进新会话的菜单。
    if (sessionKeyRef.current !== keyAtStart) return false;
    if (!ok) {
      setControlError(
        useChatStore.getState().actionError ?? t("chat.sessionErrUnknown"),
      );
      return false;
    }
    return true;
  };

  const applyPrompt = async (
    value: PromptModeChoice,
    method: "current" | "clone",
  ) => {
    const ok = await applyControl({
      operation: "prompt-mode",
      value,
      apply: method,
    });
    if (ok) setPendingPrompt(null);
  };

  const selectPrompt = (value: PromptModeChoice) => {
    if (disabled || !controlState) return;
    if (promptMethods.includes("clone")) {
      setPendingPrompt(value);
      return;
    }
    void applyPrompt(value, promptMethods[0] ?? "current");
  };

  const selectInteraction = (value: string) => {
    if (disabled || !controlState) return;
    void applyControl({ operation: "interaction-mode", value });
  };

  const selectApi = (value: string) => {
    if (disabled || !controlState) return;
    void applyControl({ operation: "api-mode", value });
  };

  const openIdentityDialog = () => {
    if (disabled || !controlState) return;
    const base = controlState.identity.base;
    const current =
      base === null
        ? identityOptions[0]
        : (identityOptions.find((option) => option.value === base) ??
          identityOptions.find((option) => option.builtIn?.name === base) ?? {
            value: base,
            name: base,
            description: null,
            group: "external" as const,
            source: null,
          });
    if (!current) return;
    requestIdentity(sessionKeyValue, current);
    close();
  };

  const promptModeLabel = controlState
    ? t(
        controlState.promptMode.effective === "compact"
          ? "chat.sessionPromptModeCompact"
          : "chat.sessionPromptModeFull",
      )
    : t("chat.sessionValueUnavailable");
  const interactionModeLabel = controlState
    ? (interactionModes.find(
        (mode) => mode.slug === controlState.interactionMode.effective,
      )?.name ?? controlState.interactionMode.effective)
    : t("chat.sessionValueUnavailable");
  const apiModeLabelText = controlState
    ? apiModeLabel(controlState.apiMode.effective, t)
    : t("chat.sessionValueUnavailable");
  const baseIdentityLabel = controlState
    ? identityDisplayName(controlState.identity.base, identityOptions) ??
      t("chat.sessionIdentityNone")
    : t("chat.sessionValueUnavailable");
  const appendedIdentityLabels = controlState
    ? controlState.identity.extensions.map(
        (extension) =>
          identityDisplayName(extension.agentType, identityOptions) ??
          extension.agentType,
      )
    : [];

  const renderOptions = (
    options: { value: boolean | null; label: string; disabled?: boolean }[],
    current: boolean | null,
    onSelect: (value: boolean | null) => void,
  ) => (
    <div role="radiogroup" className="flex flex-col gap-1">
      {options.map((option) => {
        const checked = current === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={option.disabled || undefined}
            onClick={() => !option.disabled && onSelect(option.value)}
            className={cx(
              "flex w-full items-center rounded-[14px] px-2 py-1.5 text-left outline-none transition-colors",
              option.disabled
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
              checked && !option.disabled && "bg-background-primary-hover",
            )}
          >
            <span className="truncate text-body-medium text-text-secondary">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );

  /** 单选行（会话控制入口）：aria-checked 由状态决定，禁用时同样保留展示。 */
  const renderControlOptions = ({
    options,
    current,
    onSelect,
    testId,
  }: {
    options: { value: string; label: string; disabled?: boolean }[];
    /** null = 未设置会话覆盖，对应 reset 行。 */
    current: string | null;
    onSelect: (value: string) => void;
    testId: string;
  }) => (
    <div role="radiogroup" className="flex flex-col gap-1" data-testid={testId}>
      {options.map((option) => {
        const checked =
          current === null
            ? option.value === "reset"
            : option.value === current;
        const optionDisabled = disabled || option.disabled;
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={optionDisabled || undefined}
            disabled={optionDisabled}
            data-value={option.value}
            onClick={() => !optionDisabled && onSelect(option.value)}
            className={cx(
              "flex w-full items-center rounded-[14px] px-2 py-1.5 text-left outline-none transition-colors",
              optionDisabled
                ? "cursor-not-allowed opacity-50"
                : "cursor-pointer hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
              checked && !optionDisabled && "bg-background-primary-hover",
            )}
          >
            <span className="truncate text-body-medium text-text-secondary">
              {option.label}
            </span>
          </button>
        );
      })}
    </div>
  );

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <Tooltip>
        <AriaButton
          ref={triggerRef}
          aria-label={t("chat.sessionToggles")}
          className={cx(
            "flex cursor-pointer items-center rounded-full p-1.5 outline-none transition-colors duration-150 ease focus-visible:ring-2 focus-visible:ring-border-focus-ring",
            proxyEnabled === true ||
            secondBrainEnabled === true ||
            autoCompactWindow != null ||
            controlState?.identity.base != null ||
            (controlState?.identity.extensions.length ?? 0) > 0 ||
            controlState?.promptMode.override != null ||
            controlState?.interactionMode.override != null ||
            controlState?.apiMode.override != null
              ? "text-notification-success-foreground"
              : proxyEnabled === false || secondBrainEnabled === false
                ? "text-foreground-icon-secondary"
                : "text-foreground-icon-tertiary",
          )}
        >
          <SlidersHorizontal className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
        </AriaButton>
        <TooltipContent>{t("chat.sessionToggles")}</TooltipContent>
      </Tooltip>
      <AriaPopover
        ref={popoverRef}
        isNonModal
        shouldCloseOnInteractOutside={shouldCloseOnInteractOutside}
        placement="top end"
        offset={8}
        className={cx(
          "w-[300px] max-w-[calc(100vw-32px)]",
          "rounded-[20px] border border-border-button-default bg-background-primary-default p-1.5 shadow-dropdown",
          "transition duration-150 ease-out",
          "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
          "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
        )}
      >
        <AriaDialog
          aria-label={t("chat.sessionToggles")}
          className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto outline-none"
        >
          <div className="flex items-center gap-2.5 px-2 pt-1 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1 truncate">{t("chat.sessionProxy")}</span>
          </div>
          {renderOptions(proxyOptions, proxyEnabled, selectProxy)}
          <div className="flex items-center gap-2 border-t border-border-primary-default px-2 pt-1.5 pb-1">
            {address ? (
              <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-tertiary" title={address}>
                {address}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate text-caption-1-regular text-text-tertiary">
                {t("chat.sessionProxyNoAddress")}
              </span>
            )}
            {!proxyUsable && (
              <button
                type="button"
                onClick={() => {
                  close();
                  // The session proxy address lives on the 网络代理 page.
                  navigate("/settings?page=proxy");
                }}
                className="shrink-0 cursor-pointer text-caption-1-medium text-text-link-default outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
              >
                {t("chat.sessionProxyGoSettings")}
              </button>
            )}
          </div>
          <div className="flex items-center gap-2.5 border-t border-border-primary-default px-2 pt-1.5 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1 truncate">{t("chat.secondBrain")}</span>
          </div>
          {renderOptions(brainOptions, secondBrainEnabled, selectBrain)}
          <div className="flex items-center gap-2.5 border-t border-border-primary-default px-2 pt-1.5 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1 truncate">{t("chat.sessionContextWindow")}</span>
          </div>
          <div className="flex items-center gap-1 px-2">
            <Input
              size="small"
              className="min-w-0"
              aria-label={t("chat.sessionContextWindow")}
              placeholder={t("chat.sessionContextWindowPlaceholder")}
              value={windowDraft}
              onChange={(next) => {
                setWindowDraft(next);
                setWindowError(false);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  event.stopPropagation();
                  applyWindow();
                }
              }}
            />
            <button
              type="button"
              onClick={applyWindow}
              className="shrink-0 cursor-pointer rounded-md px-1.5 py-1 text-caption-1-medium text-text-link-default outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
            >
              {t("chat.sessionContextWindowApply")}
            </button>
          </div>
          <div className="flex items-center gap-2 px-2 pb-0.5">
            <span
              className={cx(
                "min-w-0 flex-1 truncate text-caption-1-regular",
                windowError ? "text-foreground-icon-error" : "text-text-tertiary",
              )}
            >
              {windowError
                ? t("chat.sessionContextWindowInvalid")
                : t("chat.sessionContextWindowHint")}
            </span>
            <button
              type="button"
              onClick={resetWindow}
              disabled={autoCompactWindow == null}
              className="shrink-0 cursor-pointer text-caption-1-medium text-text-link-default outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-default disabled:text-text-tertiary disabled:no-underline"
            >
              {t("chat.sessionContextWindowReset")}
            </button>
          </div>

          {/* 提示词模式：full / compact / 启动默认；是否需要选择应用
              方式由引擎给出的可用方式决定。 */}
          <div className="flex items-center gap-2 border-t border-border-primary-default px-2 pt-1.5 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1 truncate">{t("chat.sessionPromptMode")}</span>
            <span className="shrink-0 text-caption-1-regular text-text-tertiary">
              {promptModeLabel}
            </span>
          </div>
          {pendingPrompt === null ? (
            controlState ? (
              renderControlOptions({
                testId: "session-prompt-mode",
                current: controlState.promptMode.override,
                onSelect: (value) => selectPrompt(value as PromptModeChoice),
                options: [
                  { value: "full", label: t("chat.sessionPromptModeFull") },
                  { value: "compact", label: t("chat.sessionPromptModeCompact") },
                  { value: "reset", label: t("chat.sessionPromptModeReset") },
                ],
              })
            ) : (
              <div className="px-2 text-caption-1-regular text-text-tertiary">
                {controlBusy
                  ? t("chat.sessionStateLoading")
                  : t("chat.sessionStateUnavailable")}
              </div>
            )
          ) : (
            <div className="flex flex-col gap-1 px-2 pb-1">
              <span className="text-caption-1-regular text-text-tertiary">
                {t("chat.sessionPromptModeApplyTitle")}
              </span>
              <div className="flex gap-1">
                {promptMethods.map((method) => (
                  <button
                    key={method}
                    type="button"
                    disabled={disabled}
                    onClick={() => void applyPrompt(pendingPrompt, method)}
                    className="cursor-pointer rounded-md px-1.5 py-1 text-caption-1-medium text-text-link-default outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:text-text-tertiary disabled:no-underline"
                  >
                    {t(
                      method === "clone"
                        ? "chat.sessionPromptModeClone"
                        : "chat.sessionPromptModeCurrent",
                    )}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={() => setPendingPrompt(null)}
                  className="cursor-pointer rounded-md px-1.5 py-1 text-caption-1-medium text-text-tertiary outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring"
                >
                  {t("common.cancel")}
                </button>
              </div>
              <span
                className={cx(
                  "text-caption-1-regular",
                  promptSizeLarge
                    ? "text-text-error-primary"
                    : "text-text-tertiary",
                )}
              >
                {promptSizeLarge
                  ? t("chat.sessionCacheLarge", {
                      tokens: formatTokens(promptSize.promptTokens),
                    })
                  : t("chat.sessionCacheRebuild")}
              </span>
            </div>
          )}
          <div className="px-2 pb-0.5 text-caption-1-regular text-text-tertiary">
            {t("chat.sessionPromptModeHint")}
          </div>

          {/* 身份：当前基础身份与追加信息；选择走到共用对话框。 */}
          <div className="flex items-center gap-2 border-t border-border-primary-default px-2 pt-1.5 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1 truncate">{t("chat.sessionIdentity")}</span>
            <span className="min-w-0 shrink-0 truncate text-caption-1-regular text-text-tertiary">
              {baseIdentityLabel}
            </span>
          </div>
          {appendedIdentityLabels.length > 0 && (
            <div className="px-2 text-caption-1-regular text-text-tertiary">
              {t("chat.sessionIdentityAppended")}
              {": "}
              {appendedIdentityLabels.join(t("chat.sessionIdentityJoin"))}
            </div>
          )}
          <button
            type="button"
            data-testid="session-identity-open"
            disabled={disabled || !controlState}
            onClick={openIdentityDialog}
            className="mx-2 cursor-pointer rounded-md py-1 text-left text-caption-1-medium text-text-link-default outline-none hover:underline focus-visible:ring-2 focus-visible:ring-border-focus-ring disabled:cursor-not-allowed disabled:text-text-tertiary disabled:no-underline"
          >
            {t("chat.sessionIdentityTitle")}
          </button>

          {/* 持续行为模式：只追加尾部指导，不改身份与权限。 */}
          <div className="flex items-center gap-2 border-t border-border-primary-default px-2 pt-1.5 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1 truncate">{t("chat.sessionInteractionMode")}</span>
            <span className="min-w-0 shrink-0 truncate text-caption-1-regular text-text-tertiary">
              {interactionModeLabel}
            </span>
          </div>
          {controlState && (
            renderControlOptions({
              testId: "session-interaction-mode",
              current:
                controlState.interactionMode.override === "default"
                  ? null
                  : controlState.interactionMode.override,
              onSelect: selectInteraction,
              options: [
                { value: "reset", label: t("chat.sessionInteractionModeReset") },
                ...interactionModes.map((mode) => ({
                  value: mode.slug,
                  label: mode.name,
                })),
              ],
            })
          )}
          <div className="px-2 pb-0.5 text-caption-1-regular text-text-tertiary">
            {t("chat.sessionInteractionModeHint")}
          </div>

          {/* 会话 API 协议：reset 回到渠道模型默认。 */}
          <div className="flex items-center gap-2 border-t border-border-primary-default px-2 pt-1.5 text-body-medium text-text-tertiary">
            <span className="min-w-0 flex-1 truncate">{t("chat.sessionApiMode")}</span>
            <span className="min-w-0 shrink-0 truncate text-caption-1-regular text-text-tertiary">
              {apiModeLabelText}
            </span>
          </div>
          {controlState && (
            renderControlOptions({
              testId: "session-api-mode",
              current: controlState.apiMode.override,
              onSelect: selectApi,
              options: [
                ...API_MODES.map((mode) => ({
                  value: mode as ApiModeChoice,
                  label: apiModeLabel(mode, t),
                })),
                { value: "reset", label: t("chat.sessionApiModeReset") },
              ],
            })
          )}
          <div className="px-2 pb-0.5 text-caption-1-regular text-text-tertiary">
            {t("chat.sessionApiModeHint")}
          </div>

          {disabled && (
            <div className="px-2 text-caption-1-regular text-text-tertiary">
              {t("chat.sessionControlRunning")}
            </div>
          )}
          {controlError && (
            <div role="alert" className="px-2 pb-0.5 text-caption-1-regular text-foreground-icon-error">
              {controlError}
            </div>
          )}
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}
