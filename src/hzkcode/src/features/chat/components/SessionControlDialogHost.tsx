import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import type { SessionControlApply } from "@/lib/ipc";
import { sessionKey, useChatStore } from "@/features/chat/store";
import { useAgentStore } from "@/features/agents/agent-store";
import { usePendingIdentityStore } from "@/features/agents/pending-identity";
import {
  sessionControlErrorKey,
  sessionIdentityOptions,
  type SessionIdentityOption,
} from "@/features/chat/session-control-view";
import { SessionControlDialog } from "./SessionControlDialog";

function activeSessionKey(): string | null {
  const active = useChatStore.getState().active;
  return active
    ? sessionKey(active.engine, active.sessionId, active.workspacePath)
    : null;
}

/**
 * 共用身份应用对话框：接管 # 身份选择、身份 chip 的 × 与会话开关里的
 * 身份入口。所有实际写入都走 state 层的 `applySessionControl`；失败时
 * 保留弹层与选中项，不让界面把旧选择当成已生效。
 */
export function SessionControlDialogHost() {
  const { t } = useTranslation();
  const request = usePendingIdentityStore((s) => s.request);
  const clearRequest = usePendingIdentityStore((s) => s.clear);
  const key = request?.key ?? null;
  const activeKey = useChatStore((s) => {
    const active = s.active;
    return active
      ? sessionKey(active.engine, active.sessionId, active.workspacePath)
      : null;
  });
  const sessionControl = useChatStore((s) =>
    key ? (s.bySession[key]?.sessionControl ?? null) : null,
  );
  const usage = useChatStore((s) =>
    key ? (s.bySession[key]?.usage ?? null) : null,
  );
  const streaming = useChatStore((s) =>
    key ? (s.bySession[key]?.streaming ?? false) : false,
  );
  const controlBusy = useChatStore((s) => s.controlBusy);
  const refreshSessionControl = useChatStore((s) => s.refreshSessionControl);
  const applySessionControl = useChatStore((s) => s.applySessionControl);
  const agents = useAgentStore((s) => s.agents);
  const builtInAgents = useAgentStore((s) => s.builtInAgents);

  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const controlState = sessionControl?.state ?? null;
  const identities = useMemo(
    () =>
      sessionIdentityOptions({
        catalog: sessionControl?.catalog,
        agents,
        builtInAgents,
        defaultName: t("chat.sessionIdentityDefault"),
      }),
    [sessionControl?.catalog, agents, builtInAgents, t],
  );

  // 弹层打开时读一次权威目录与状态；# 选择在会话状态尚未读取时也能拿到
  // 引擎内置/外置身份。
  useEffect(() => {
    if (!key) return;
    if (activeKey !== key) return;
    // 自带角色名按语言本地化；尚未加载时补读一次，再按稳定 id 找显示名。
    const agentStore = useAgentStore.getState();
    if (!agentStore.loaded) void agentStore.refresh();
    void refreshSessionControl();
  }, [key, activeKey, refreshSessionControl]);

  useEffect(() => {
    setError(null);
  }, [key, request?.identity]);

  // 切换会话后弹层隐藏；请求仍绑定原会话，切回时才再次出现。
  if (!request || activeKey !== request.key) return null;
  const initial =
    identities.find((option) => option.value === request.identity.value) ??
    identities.find(
      (option) =>
        option.builtIn?.name === request.identity.value,
    ) ??
    request.identity;

  const close = () => {
    if (applying) return;
    setError(null);
    clearRequest(request.key);
  };

  const apply = async (
    identity: SessionIdentityOption,
    method: SessionControlApply,
  ) => {
    // 捕获本次请求与会话：异步期间用户可能切换会话或另选身份，旧回调
    // 不得更新新会话的错误/选择，也不得清掉更新的待应用请求。
    const requested = request;
    if (applying || controlBusy || streaming) return;
    if (activeSessionKey() !== requested.key) {
      setError(t("chat.sessionStateUnavailable"));
      return;
    }
    setApplying(true);
    setError(null);
    const ok = await applySessionControl({
      operation: "identity",
      // 引擎约定的无身份值是 "default"；UI 用 null 表示默认。
      value: identity.value ?? "default",
      apply: method,
      // GUI 自定义身份把定义一起带上，state 层无需依赖内存列表也能注册；
      // app 自带角色用稳定 id 作 value，由 state 层按目录解析提示词。
      ...(identity.agent ? { agent: identity.agent } : {}),
    });
    const stillRequested =
      usePendingIdentityStore.getState().request === requested;
    const stillActive = activeSessionKey() === requested.key;
    if (ok) {
      if (stillRequested) clearRequest(requested.key);
      setApplying(false);
      return;
    }
    if (!stillRequested || !stillActive) {
      setApplying(false);
      return;
    }
    const latest = useChatStore.getState();
    const failure = latest.actionError;
    const latestControl = latest.bySession[requested.key]?.sessionControl;
    setError(
      failure ??
        (latestControl?.is_error
          ? t(sessionControlErrorKey(latestControl.error_code))
          : t("chat.sessionErrUnknown")),
    );
    // 文件变化等失败需要把状态刷新到最新；选择与弹层保留供重试。
    void refreshSessionControl();
    setApplying(false);
  };

  return (
    <SessionControlDialog
      key={`${request.key}:${initial.value ?? "__default__"}`}
      identities={identities}
      initialIdentity={initial}
      state={controlState}
      usage={usage}
      busy={applying || controlBusy}
      disabled={streaming}
      error={error}
      onApply={(identity, method) => void apply(identity, method)}
      onClose={close}
      onRefresh={() => void refreshSessionControl()}
    />
  );
}
