import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useTranslation } from "react-i18next";
import { useNavigate } from "react-router-dom";
import {
  Button as AriaButton,
  Dialog as AriaDialog,
  DialogTrigger as AriaDialogTrigger,
  Popover as AriaPopover,
} from "react-aria-components";
import { Input } from "@/components/base/input/input";
import { isUsableSessionProxyUrl } from "@/components/application/ai-chat/proxy-url";
import { ipc } from "@/lib/ipc";
import { listenSettingsChanged } from "@/lib/events";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { parseContextWindowDraft } from "@/features/chat/context-window-draft";
import { useAgentStore } from "@/features/agents/agent-store";
import { usePendingIdentityStore } from "@/features/agents/pending-identity";
import type {
  ApiModeChoice,
  PromptModeChoice,
} from "@/features/chat/session-control-view";
import {
  EMPTY_SESSION_CONTROL_CATALOG,
  LARGE_PROMPT_TOKENS,
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

const SESSION_POPOVER_CLASSES = cx(
  "max-w-[calc(100vw-32px)]",
  "rounded-[20px] border border-border-button-default bg-background-primary-default p-1.5 shadow-dropdown",
  "transition duration-150 ease-out",
  "data-[entering]:opacity-0 data-[entering]:scale-95 data-[entering]:blur-[2px]",
  "data-[exiting]:opacity-0 data-[exiting]:scale-95 data-[exiting]:blur-[2px]",
);

const ENTRY_BUTTON_CLASSES =
  "flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-md px-1.5 outline-none transition-colors duration-150 ease";

const SESSION_CONTROLS_CLASSES =
  "relative flex w-full min-w-0 items-center gap-0.5";

const SESSION_CONTROLS_MEASURE_VIEWPORT_CLASSES =
  "pointer-events-none invisible absolute left-0 top-0 h-0 w-full overflow-hidden";

const SESSION_CONTROLS_MEASURE_CLASSES = "flex w-max gap-0.5";

const CompactMenuContext = createContext<{ close: () => void } | null>(null);

/**
 * 输入框外侧状态栏的七个会话入口：身份直接打开共用对话框，其余各自只展开
 * 对应的功能面板。每次 GUI 发送都是新进程，会话开关随每次发送注入；
 * 会话控制项保存在会话文件里。
 */
export function SessionControls() {
  const sessionKeyValue = useChatStore((s) => {
    const a = s.active;
    return a ? sessionKey(a.engine, a.sessionId, a.workspacePath) : null;
  });
  if (!sessionKeyValue) return null;
  // 会话切换时整体重建：旧弹层、草稿与异步结果都不会带到新会话。
  return (
    <SessionControlsInner
      key={sessionKeyValue}
      sessionKeyValue={sessionKeyValue}
    />
  );
}

function SessionControlsInner({ sessionKeyValue }: { sessionKeyValue: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();

  const sessionControl = useChatStore(
    (s) => s.bySession[sessionKeyValue]?.sessionControl ?? null,
  );
  const controlBusy = useChatStore((s) => s.controlBusy);
  const proxyEnabled = useChatStore(
    (s) => s.bySession[sessionKeyValue]?.proxyEnabled ?? null,
  );
  const secondBrainEnabled = useChatStore(
    (s) => s.bySession[sessionKeyValue]?.secondBrainEnabled ?? null,
  );
  const autoCompactWindow = useChatStore(
    (s) => s.bySession[sessionKeyValue]?.autoCompactWindow ?? null,
  );
  const usage = useChatStore(
    (s) => s.bySession[sessionKeyValue]?.usage ?? null,
  );
  const streaming = useChatStore(
    (s) => s.bySession[sessionKeyValue]?.streaming ?? false,
  );
  const setSessionProxy = useChatStore((s) => s.setSessionProxy);
  const setSessionSecondBrain = useChatStore((s) => s.setSessionSecondBrain);
  const setSessionAutoCompactWindow = useChatStore(
    (s) => s.setSessionAutoCompactWindow,
  );
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

  const mountedRef = useRef(true);
  useEffect(() => {
    // StrictMode 开发重放会先 cleanup 再 setup；setup 必须重置标记，
    // 否则第二次挂载后读取与写结果都会被当成已卸载而丢弃。
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // 七个入口的自然宽度由一份不可交互的测量行给出；容器放不下时收成一个
  // 菜单。零宽（尚未布局或 jsdom）不切换，避免初始化瞬间闪动。
  const containerRef = useRef<HTMLDivElement | null>(null);
  const measureRef = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const container = containerRef.current;
    const measure = measureRef.current;
    if (!container || !measure || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const available = container.getBoundingClientRect().width;
      const natural = measure.getBoundingClientRect().width;
      if (available <= 0 || natural <= 0) return;
      setCompact(natural > available);
    };
    const observer = new ResizeObserver(update);
    observer.observe(container);
    observer.observe(measure);
    update();
    return () => observer.disconnect();
  }, []);

  // 会话激活/恢复时读取一次权威状态，让协议入口无需先点开菜单就有值。
  // 已有缓存、读取失败或组件留在同一会话时都不重复发起。
  const reload = useCallback(() => {
    setControlError(null);
    // 自带角色名称随语言本地化；尚未加载时补读一次，避免身份入口显示
    // 稳定 id 或误回退到默认身份。
    const agentStore = useAgentStore.getState();
    if (!agentStore.loaded) void agentStore.refresh();
    void refreshSessionControl().then((result) => {
      if (!mountedRef.current) return;
      if (!result) {
        // 另一个读取正在进行时 store 会直接返回缓存；那不是失败。
        if (!useChatStore.getState().controlBusy) {
          setControlError(t("chat.sessionStateUnavailable"));
        }
        return;
      }
      if (result.is_error) {
        setControlError(t(sessionControlErrorKey(result.error_code)));
      }
    });
  }, [refreshSessionControl, t]);

  const controlStateRef = useRef(controlState);
  controlStateRef.current = controlState;
  const activationReadRef = useRef(false);
  useEffect(() => {
    if (activationReadRef.current || controlStateRef.current) return;
    activationReadRef.current = true;
    reload();
  }, [reload]);

  // The address the CLI reads for `HZKCODE_PROXY_ENABLED=1` (模型配置 → 功能
  // 开关 → 会话代理地址 already writes this key).
  const [address, setAddress] = useState<string | null>(null);
  const readAddress = useCallback(() => {
    void ipc
      .getAppSettings()
      .then((s) => setAddress(s.cliEnv?.HZKCODE_PROXY_URL?.trim() || null))
      .catch(() => {});
  }, []);
  useEffect(() => readAddress(), [readAddress]);
  useTauriEvent(() => listenSettingsChanged(readAddress));

  const reloadOnOpen = useCallback(
    (open: boolean) => {
      if (!open) return;
      setPendingPrompt(null);
      reload();
    },
    [reload],
  );

  // Draft for the context-window input: only the context panel owns it, and
  // closing that panel commits a valid, changed draft. The session key is
  // pinned at open time so a late close can never write another session.
  const [windowDraft, setWindowDraft] = useState("");
  const [windowError, setWindowError] = useState(false);
  const windowDraftRef = useRef(windowDraft);
  windowDraftRef.current = windowDraft;
  const contextOpenRef = useRef(false);
  const contextOpenKeyRef = useRef<string | null>(null);
  const contextOpenValueRef = useRef<number | null>(null);

  const handleContextOpenChange = useCallback(
    (open: boolean) => {
      contextOpenRef.current = open;
      if (open) {
        contextOpenKeyRef.current = sessionKeyValue;
        contextOpenValueRef.current = autoCompactWindow;
        setWindowDraft(
          autoCompactWindow == null ? "" : String(autoCompactWindow),
        );
        setWindowError(false);
        return;
      }
      const key = contextOpenKeyRef.current;
      contextOpenKeyRef.current = null;
      if (!key || key !== sessionKeyValue) return;
      const value = parseContextWindowDraft(windowDraftRef.current);
      if (value == null || value === contextOpenValueRef.current) return;
      setSessionAutoCompactWindow(key, value);
    },
    [autoCompactWindow, sessionKeyValue, setSessionAutoCompactWindow],
  );

  // 紧凑菜单是六类面板共用的外层：打开只读取一次会话状态，关闭时按
  // 同一个打开/关闭周期结算上下文草稿。
  const handleCompactOpenChange = useCallback(
    (open: boolean) => {
      handleContextOpenChange(open);
      reloadOnOpen(open);
    },
    [handleContextOpenChange, reloadOnOpen],
  );

  // 尺寸跨过阈值会替换整组入口，旧弹层随之卸载；上下文草稿仍在关闭时结算。
  const previousCompactRef = useRef(compact);
  useEffect(() => {
    if (previousCompactRef.current === compact) return;
    previousCompactRef.current = compact;
    handleContextOpenChange(false);
  }, [compact, handleContextOpenChange]);

  // A stored change made by this panel (or another window) re-syncs the draft
  // while the panel is open.
  useEffect(() => {
    if (!contextOpenRef.current) return;
    setWindowDraft(autoCompactWindow == null ? "" : String(autoCompactWindow));
    setWindowError(false);
  }, [autoCompactWindow]);

  const applyControl = async (
    command: Parameters<typeof applySessionControl>[0],
  ) => {
    if (disabled) return false;
    setControlError(null);
    const ok = await applySessionControl(command);
    // 会话切换会重建入口，旧会话的失败结果不能写进新会话。
    if (!mountedRef.current) return false;
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
    const base = controlState?.identity.base ?? null;
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
    // 状态尚未读取时也直接发起请求，由共用对话框自己刷新目录与状态。
    requestIdentity(sessionKeyValue, current);
  };

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
  const proxyOptions: BooleanOption[] = [
    { value: null, label: t("chat.sessionProxyFollow") },
    { value: true, label: t("chat.sessionProxyOn"), disabled: !proxyUsable },
    { value: false, label: t("chat.sessionProxyOff") },
  ];
  const brainOptions: BooleanOption[] = [
    { value: null, label: t("chat.sessionProxyFollow") },
    { value: true, label: t("chat.sessionProxyOn") },
    { value: false, label: t("chat.sessionProxyOff") },
  ];

  const promptModeLabel = controlState
    ? t(
        controlState.promptMode.effective === "compact"
          ? "chat.sessionPromptModeCompact"
          : "chat.sessionPromptModeFull",
      )
    : null;
  const interactionModeLabel = controlState
    ? (interactionModes.find(
        (mode) => mode.slug === controlState.interactionMode.effective,
      )?.name ?? controlState.interactionMode.effective)
    : null;
  const apiModeEffectiveLabel = controlState
    ? apiModeLabel(controlState.apiMode.effective, t)
    : null;
  const protocolState = controlState
    ? "value"
    : controlBusy
      ? "loading"
      : "unavailable";
  const protocolTriggerLabel =
    apiModeEffectiveLabel ??
    (controlBusy
      ? t("common.loading")
      : t("chat.sessionValueUnavailable"));
  const proxyValueLabel =
    proxyEnabled == null
      ? t("chat.sessionProxyFollow")
      : proxyEnabled
        ? t("chat.sessionProxyOn")
        : t("chat.sessionProxyOff");
  const brainValueLabel =
    secondBrainEnabled == null
      ? t("chat.sessionProxyFollow")
      : secondBrainEnabled
        ? t("chat.sessionProxyOn")
        : t("chat.sessionProxyOff");
  const contextValueLabel =
    autoCompactWindow == null
      ? t("chat.sessionContextWindowPlaceholder")
      : String(autoCompactWindow);

  const controls = (
    <>
      <SessionActionButton
        id="identity"
        label={t("chat.sessionIdentity")}
        ariaLabel={t("chat.sessionIdentityTitle")}
        active={
          controlState?.identity.base != null ||
          (controlState?.identity.extensions.length ?? 0) > 0
        }
        onPress={openIdentityDialog}
      />

      <SessionMenuButton
        id="interaction"
        label={t("chat.sessionEntryBehavior")}
        ariaLabel={t("chat.sessionInteractionMode")}
        panelLabel={t("chat.sessionInteractionMode")}
        active={
          controlState?.interactionMode.override != null &&
          controlState.interactionMode.override !== "default"
        }
        onOpenChange={reloadOnOpen}
      >
        {() => (
          <div className="flex w-[220px] flex-col gap-1">
            <PanelSectionHeader
              label={t("chat.sessionInteractionMode")}
              value={interactionModeLabel}
            />
            {controlState ? (
              <ControlRadioGroup
                testId="session-interaction-mode"
                current={
                  controlState.interactionMode.override === "default"
                    ? null
                    : controlState.interactionMode.override
                }
                onSelect={selectInteraction}
                disabled={disabled}
                options={[
                  {
                    value: "reset",
                    label: t("chat.sessionInteractionModeReset"),
                  },
                  ...interactionModes.map((mode) => ({
                    value: mode.slug,
                    label: mode.name,
                  })),
                ]}
              />
            ) : (
              <PanelUnavailable loading={controlBusy} />
            )}
            <PanelNote>{t("chat.sessionInteractionModeHint")}</PanelNote>
            <PanelStatus disabled={disabled} error={controlError} />
          </div>
        )}
      </SessionMenuButton>

      <SessionMenuButton
        id="prompt"
        label={t("chat.sessionEntryPrompt")}
        ariaLabel={t("chat.sessionPromptMode")}
        panelLabel={t("chat.sessionPromptMode")}
        active={controlState?.promptMode.override != null}
        onOpenChange={reloadOnOpen}
      >
        {() => (
          <div className="flex w-[280px] flex-col gap-1">
            <PanelSectionHeader
              label={t("chat.sessionPromptMode")}
              value={promptModeLabel}
            />
            {pendingPrompt === null ? (
              controlState ? (
                <ControlRadioGroup
                  testId="session-prompt-mode"
                  current={controlState.promptMode.override}
                  onSelect={(value) =>
                    selectPrompt(value as PromptModeChoice)
                  }
                  disabled={disabled}
                  options={[
                    {
                      value: "full",
                      label: t("chat.sessionPromptModeFull"),
                    },
                    {
                      value: "compact",
                      label: t("chat.sessionPromptModeCompact"),
                    },
                    {
                      value: "reset",
                      label: t("chat.sessionPromptModeReset"),
                    },
                  ]}
                />
              ) : (
                <PanelUnavailable loading={controlBusy} />
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
            <PanelNote>{t("chat.sessionPromptModeHint")}</PanelNote>
            <PanelStatus disabled={disabled} error={controlError} />
          </div>
        )}
      </SessionMenuButton>

      <SessionMenuButton
        id="protocol"
        label={protocolTriggerLabel}
        ariaLabel={`${t("chat.sessionApiMode")}: ${protocolTriggerLabel}`}
        panelLabel={t("chat.sessionApiMode")}
        active={controlState?.apiMode.override != null}
        onOpenChange={reloadOnOpen}
        dataProtocolState={protocolState}
        dataApiMode={controlState?.apiMode.effective}
      >
        {() => (
          <div className="flex w-[240px] flex-col gap-1">
            <PanelSectionHeader
              label={t("chat.sessionApiMode")}
              value={apiModeEffectiveLabel}
            />
            {controlState ? (
              <ControlRadioGroup
                testId="session-api-mode"
                current={controlState.apiMode.override}
                onSelect={selectApi}
                disabled={disabled}
                options={[
                  ...API_MODES.map((mode) => ({
                    value: mode,
                    label: apiModeLabel(mode, t),
                  })),
                  {
                    value: "reset",
                    label: t("chat.sessionApiModeReset"),
                  },
                ]}
              />
            ) : (
              <PanelUnavailable loading={controlBusy} />
            )}
            <PanelNote>{t("chat.sessionApiModeHint")}</PanelNote>
            <PanelStatus disabled={disabled} error={controlError} />
          </div>
        )}
      </SessionMenuButton>

      <SessionMenuButton
        id="proxy"
        label={t("chat.sessionEntryProxy")}
        ariaLabel={t("chat.sessionProxy")}
        panelLabel={t("chat.sessionProxy")}
        active={proxyEnabled === true}
        tone={proxyEnabled === false ? "muted" : "default"}
      >
        {(close) => (
          <div className="flex w-[300px] flex-col gap-1">
            <PanelSectionHeader
              label={t("chat.sessionProxy")}
              value={proxyValueLabel}
            />
            <BooleanRadioGroup
              testId="session-proxy"
              options={proxyOptions}
              current={proxyEnabled}
              onSelect={(value) => {
                setSessionProxy(sessionKeyValue, value);
                close();
              }}
            />
            <div className="flex items-center gap-2 border-t border-border-primary-default px-2 pt-1.5 pb-1">
              {address ? (
                <span
                  className="min-w-0 flex-1 truncate text-caption-1-regular text-text-tertiary"
                  title={address}
                >
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
          </div>
        )}
      </SessionMenuButton>

      <SessionMenuButton
        id="second-brain"
        label={t("chat.secondBrain")}
        ariaLabel={t("chat.secondBrain")}
        panelLabel={t("chat.secondBrain")}
        active={secondBrainEnabled === true}
        tone={secondBrainEnabled === false ? "muted" : "default"}
      >
        {(close) => (
          <div className="flex w-[220px] flex-col gap-1">
            <PanelSectionHeader
              label={t("chat.secondBrain")}
              value={brainValueLabel}
            />
            <BooleanRadioGroup
              testId="session-second-brain"
              options={brainOptions}
              current={secondBrainEnabled}
              onSelect={(value) => {
                setSessionSecondBrain(sessionKeyValue, value);
                close();
              }}
            />
          </div>
        )}
      </SessionMenuButton>

      <SessionMenuButton
        id="context"
        label={t("chat.sessionEntryContext")}
        ariaLabel={t("chat.sessionContextWindow")}
        panelLabel={t("chat.sessionContextWindow")}
        active={autoCompactWindow != null}
        onOpenChange={handleContextOpenChange}
      >
        {() => (
          <div className="flex w-[300px] flex-col gap-1">
            <PanelSectionHeader
              label={t("chat.sessionContextWindow")}
              value={contextValueLabel}
            />
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
                  windowError
                    ? "text-foreground-icon-error"
                    : "text-text-tertiary",
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
          </div>
        )}
      </SessionMenuButton>
    </>
  );

  const measureLabels = [
    t("chat.sessionIdentity"),
    t("chat.sessionEntryBehavior"),
    t("chat.sessionEntryPrompt"),
    protocolTriggerLabel,
    t("chat.sessionEntryProxy"),
    t("chat.secondBrain"),
    t("chat.sessionEntryContext"),
  ];

  return (
    <div
      ref={containerRef}
      data-session-controls=""
      className={cx(SESSION_CONTROLS_CLASSES, compact && "justify-end")}
    >
      <div
        aria-hidden
        data-session-controls-measure-viewport=""
        className={SESSION_CONTROLS_MEASURE_VIEWPORT_CLASSES}
      >
        <div
          ref={measureRef}
          data-session-controls-measure=""
          className={SESSION_CONTROLS_MEASURE_CLASSES}
        >
          {measureLabels.map((label, index) => (
            <span key={index} className={ENTRY_BUTTON_CLASSES}>
              <span className="whitespace-nowrap text-caption-1-medium">
                {label}
              </span>
            </span>
          ))}
        </div>
      </div>
      {compact ? (
        <SessionMenuButton
          id="session-actions"
          label={t("chat.sessionActions")}
          panelLabel={t("chat.sessionActions")}
          onOpenChange={handleCompactOpenChange}
        >
          {(close) => (
            <CompactMenuContext.Provider value={{ close }}>
              <div className="flex w-full min-w-0 flex-col gap-1">
                {controls}
              </div>
            </CompactMenuContext.Provider>
          )}
        </SessionMenuButton>
      ) : (
        controls
      )}
    </div>
  );
}

interface ControlOption {
  value: string;
  label: string;
  disabled?: boolean;
}

interface BooleanOption {
  value: boolean | null;
  label: string;
  disabled?: boolean;
}

type EntryTone = "default" | "muted";

function entryClassName({
  active = false,
  tone = "default",
  open = false,
}: {
  active?: boolean;
  tone?: EntryTone;
  open?: boolean;
}) {
  return ({
    isHovered,
    isPressed,
    isFocusVisible,
  }: {
    isHovered?: boolean;
    isPressed?: boolean;
    isFocusVisible?: boolean;
  }) =>
    cx(
      ENTRY_BUTTON_CLASSES,
      (isHovered || isPressed || open) && "bg-background-primary-hover",
      isFocusVisible && "ring-2 ring-border-focus-ring",
      active
        ? "text-notification-success-foreground"
        : tone === "muted"
          ? "text-foreground-icon-tertiary"
          : "text-text-secondary",
    );
}

/** 直接执行动作的入口（身份）：不展开弹层，一次按压即发起请求。 */
function SessionActionButton({
  id,
  label,
  ariaLabel,
  active = false,
  tone = "default",
  onPress,
}: {
  id: string;
  label: string;
  ariaLabel?: string;
  active?: boolean;
  tone?: EntryTone;
  onPress: () => void;
}) {
  const compactMenu = useContext(CompactMenuContext);
  if (compactMenu) {
    return (
      <AriaButton
        aria-label={ariaLabel ?? label}
        data-session-control={id}
        onPress={() => {
          compactMenu.close();
          onPress();
        }}
        className={cx(
          "flex w-full cursor-pointer items-center rounded-[14px] px-2 py-1.5 text-left outline-none transition-colors hover:bg-background-primary-hover focus-visible:bg-background-primary-hover",
          active
            ? "text-notification-success-foreground"
            : tone === "muted"
              ? "text-foreground-icon-tertiary"
              : "text-text-secondary",
        )}
      >
        <span className="truncate text-body-medium">{label}</span>
      </AriaButton>
    );
  }
  return (
    <AriaButton
      aria-label={ariaLabel ?? label}
      data-session-control={id}
      onPress={onPress}
      className={entryClassName({ active, tone })}
    >
      <span className="whitespace-nowrap text-caption-1-medium">{label}</span>
    </AriaButton>
  );
}

interface SessionMenuButtonProps {
  id: string;
  label: string;
  ariaLabel?: string;
  panelLabel: string;
  active?: boolean;
  tone?: EntryTone;
  onOpenChange?: (open: boolean) => void;
  dataProtocolState?: string;
  dataApiMode?: string;
  children: (close: () => void) => ReactNode;
}

/** 一个入口只承载一个功能面板；各入口的开关状态互不共享。 */
function SessionMenuButton(props: SessionMenuButtonProps) {
  const compactMenu = useContext(CompactMenuContext);
  if (compactMenu) {
    return (
      <section
        data-session-section={props.id}
        className="flex flex-col gap-1 border-t border-border-primary-default pt-1 [&>div]:w-full"
      >
        {props.children(compactMenu.close)}
      </section>
    );
  }
  return <SessionMenuButtonPopover {...props} />;
}

function SessionMenuButtonPopover({
  id,
  label,
  ariaLabel,
  panelLabel,
  active = false,
  tone = "default",
  onOpenChange,
  dataProtocolState,
  dataApiMode,
  children,
}: SessionMenuButtonProps) {
  const {
    isOpen,
    triggerRef,
    popoverRef,
    close,
    setOpen,
    shouldCloseOnInteractOutside,
  } = usePopoverState();
  const onOpenChangeRef = useRef(onOpenChange);
  onOpenChangeRef.current = onOpenChange;
  const wasOpenRef = useRef(false);
  // 触发按钮、外点关闭与 Esc 都会走这里；上下文草稿只在真正关闭时结算。
  useEffect(() => {
    if (wasOpenRef.current === isOpen) return;
    wasOpenRef.current = isOpen;
    onOpenChangeRef.current?.(isOpen);
  }, [isOpen]);

  return (
    <AriaDialogTrigger isOpen={isOpen} onOpenChange={setOpen}>
      <AriaButton
        ref={triggerRef}
        aria-label={ariaLabel ?? label}
        data-session-control={id}
        data-protocol-state={dataProtocolState}
        data-api-mode={dataApiMode}
        className={entryClassName({ active, tone, open: isOpen })}
      >
        <span className="whitespace-nowrap text-caption-1-medium">{label}</span>
      </AriaButton>
      <AriaPopover
        ref={popoverRef}
        isNonModal
        shouldCloseOnInteractOutside={shouldCloseOnInteractOutside}
        placement={id === "session-actions" ? "top end" : "top start"}
        offset={8}
        className={cx(SESSION_POPOVER_CLASSES, id === "session-actions" && "w-[334px]")}
      >
        <AriaDialog
          aria-label={panelLabel}
          className="flex max-h-[70vh] flex-col gap-1 overflow-y-auto outline-none"
        >
          {children(close)}
        </AriaDialog>
      </AriaPopover>
    </AriaDialogTrigger>
  );
}

function PanelSectionHeader({
  label,
  value,
}: {
  label: string;
  value?: string | null;
}) {
  return (
    <div className="flex items-center gap-2 px-2 pt-1 text-body-medium text-text-tertiary">
      <span className="min-w-0 flex-1 truncate">{label}</span>
      {value != null && (
        <span className="min-w-0 shrink-0 truncate text-caption-1-regular text-text-tertiary">
          {value}
        </span>
      )}
    </div>
  );
}

function PanelUnavailable({ loading }: { loading: boolean }) {
  const { t } = useTranslation();
  return (
    <div className="px-2 text-caption-1-regular text-text-tertiary">
      {loading
        ? t("chat.sessionStateLoading")
        : t("chat.sessionStateUnavailable")}
    </div>
  );
}

function PanelNote({ children }: { children: ReactNode }) {
  return (
    <div className="px-2 pb-0.5 text-caption-1-regular text-text-tertiary">
      {children}
    </div>
  );
}

function PanelStatus({
  disabled,
  error,
}: {
  disabled: boolean;
  error: string | null;
}) {
  const { t } = useTranslation();
  return (
    <>
      {disabled && (
        <div className="px-2 text-caption-1-regular text-text-tertiary">
          {t("chat.sessionControlRunning")}
        </div>
      )}
      {error && (
        <div
          role="alert"
          className="px-2 pb-0.5 text-caption-1-regular text-foreground-icon-error"
        >
          {error}
        </div>
      )}
    </>
  );
}

/** 单选行（会话控制入口）：aria-checked 由状态决定，禁用时同样保留展示。 */
function ControlRadioGroup({
  options,
  current,
  onSelect,
  disabled,
  testId,
}: {
  options: ControlOption[];
  /** null = 未设置会话覆盖，对应 reset 行。 */
  current: string | null;
  onSelect: (value: string) => void;
  disabled: boolean;
  testId: string;
}) {
  return (
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
}

/** 跟随默认 / 开启 / 关闭；选项自身的禁用只用于代理地址不可用。 */
function BooleanRadioGroup({
  options,
  current,
  onSelect,
  testId,
}: {
  options: BooleanOption[];
  current: boolean | null;
  onSelect: (value: boolean | null) => void;
  testId: string;
}) {
  return (
    <div role="radiogroup" className="flex flex-col gap-1" data-testid={testId}>
      {options.map((option) => {
        const checked = current === option.value;
        return (
          <button
            key={String(option.value)}
            type="button"
            role="radio"
            aria-checked={checked}
            aria-disabled={option.disabled || undefined}
            data-value={String(option.value)}
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
}
