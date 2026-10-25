import type {
  AgentConfig,
  BuiltInAgentView,
  SessionControlCatalog,
} from "@/lib/ipc";
import {
  isComposerPermission,
  type ComposerPermission,
} from "@/components/application/ai-chat/permission-modes";
import { parseUsage } from "./usage";

/**
 * 会话控制结果的只读视图层。state / catalog 的正式类型与结构校验在
 * `@/lib/ipc` 与后端完成，store 负责把最近一次 catalog 合并到状态里；
 * 这里只保留身份选项、显示名称与错误码映射。
 */

export type PromptMode = "full" | "compact";
export type PromptModeChoice = PromptMode | "reset";
export type ApiModeChoice = "anthropic" | "responses" | "chat_completions" | "reset";

export const EMPTY_SESSION_CONTROL_CATALOG: SessionControlCatalog = {
  identities: [],
  interactionModes: [],
};

export type IdentityGroup = "default" | "builtin" | "external" | "agency" | "custom";

export interface SessionIdentityOption {
  /** 传给会话控制的身份值；null 表示默认（无身份）。 */
  value: string | null;
  name: string;
  description?: string | null;
  icon?: string | null;
  group: IdentityGroup;
  /** 引擎来源标识（built-in / userSettings / projectSettings / plugin…）。 */
  source?: string | null;
  /** GUI 自定义身份定义；--agents 由 state 层据此准备。 */
  agent?: AgentConfig;
  /** app 自带 agency 角色；identity value 是稳定的目录 id。 */
  builtIn?: BuiltInAgentView;
}

export function identityOptionFromAgent(agent: AgentConfig): SessionIdentityOption {
  return {
    value: agent.name,
    name: agent.name,
    description: agent.prompt ?? null,
    icon: agent.icon ?? null,
    group: "custom",
    source: "custom",
    agent,
  };
}

/** app 自带角色用目录 id 作应用值（引擎允许冒号与斜杠），显示仍用本地化
 *  名称；它与引擎目录里的同名身份互不覆盖。 */
export function identityOptionFromBuiltInAgent(
  agent: BuiltInAgentView,
): SessionIdentityOption {
  return {
    value: agent.id,
    name: agent.name,
    description: agent.description,
    icon: agent.icon,
    group: "agency",
    source: "builtIn",
    builtIn: agent,
  };
}

/** 默认（无身份）条目；名称由调用方按当前语言提供。 */
export function defaultIdentityOption(name: string): SessionIdentityOption {
  return {
    value: null,
    name,
    description: null,
    group: "default",
    source: "default",
  };
}

/** 引擎目录 + app 自带角色 + GUI 自定义身份，按身份值去重；默认条目始终
 *  在最前。引擎目录只列可应用身份，不再有资格字段。 */
export function sessionIdentityOptions({
  catalog,
  agents,
  builtInAgents = [],
  defaultName,
}: {
  catalog?: SessionControlCatalog | null;
  agents: AgentConfig[];
  builtInAgents?: BuiltInAgentView[];
  defaultName: string;
}): SessionIdentityOption[] {
  const options: SessionIdentityOption[] = [defaultIdentityOption(defaultName)];
  const seen = new Set<string>();
  for (const entry of catalog?.identities ?? []) {
    if (seen.has(entry.id)) continue;
    seen.add(entry.id);
    options.push({
      value: entry.id,
      name: entry.name,
      description: entry.description,
      group: entry.source === "built-in" ? "builtin" : "external",
      source: entry.source,
    });
  }
  for (const agent of builtInAgents) {
    if (seen.has(agent.id)) continue;
    seen.add(agent.id);
    options.push(identityOptionFromBuiltInAgent(agent));
  }
  for (const agent of agents) {
    // 旧记录里的内置角色不带稳定 id，统一由 builtInAgents 提供，避免
    // 同一角色以名字和 id 各出现一次。
    if (agent.source === "builtIn") continue;
    if (seen.has(agent.name)) continue;
    seen.add(agent.name);
    options.push(identityOptionFromAgent(agent));
  }
  return options;
}

export function identityDisplayName(
  value: string | null,
  options: readonly SessionIdentityOption[],
): string | null {
  if (value === null) return null;
  const option =
    options.find((entry) => entry.value === value) ??
    // 旧会话可能按名称保存了内置角色。
    options.find((entry) => entry.builtIn?.name === value);
  return option?.name ?? value;
}

export function identityGroupLabelKey(group: IdentityGroup): string {
  switch (group) {
    case "default":
      return "chat.sessionIdentityGroupDefault";
    case "builtin":
      return "chat.sessionIdentityGroupBuiltin";
    case "agency":
      return "chat.sessionIdentityGroupAgency";
    case "custom":
      return "chat.sessionIdentityGroupCustom";
    default:
      return "chat.sessionIdentityGroupExternal";
  }
}

/** 引擎权限模式到 GUI 工作模式的显示映射；引擎的 bypassPermissions 对应
 *  GUI 的 bypass，其他未知值不猜，交给调用方回退。 */
const ENGINE_PERMISSION_ALIASES: Record<string, ComposerPermission> = {
  bypassPermissions: "bypass",
};

export function permissionModeForDisplay(
  value: string | null | undefined,
): ComposerPermission | null {
  if (!value) return null;
  const mapped = ENGINE_PERMISSION_ALIASES[value] ?? value;
  return isComposerPermission(mapped) ? mapped : null;
}

export interface PromptSizeView {
  /** 最近一次主请求的输入侧规模（输入 + 缓存读 + 缓存写）。 */
  promptTokens: number;
  cacheRead: number;
  cacheWrite: number;
}

export function promptSizeFromUsage(usage: unknown): PromptSizeView | null {
  const parsed = parseUsage(usage);
  if (!parsed) return null;
  return {
    promptTokens: parsed.input + parsed.cacheRead + parsed.cacheWrite,
    cacheRead: parsed.cacheRead,
    cacheWrite: parsed.cacheWrite,
  };
}

/** 达到该输入规模时，完整切换必须在确认里给出明显提示。 */
export const LARGE_PROMPT_TOKENS = 100_000;

const ERROR_KEYS: Record<string, string> = {
  invalid_request: "chat.sessionErrInvalidRequest",
  invalid_session: "chat.sessionErrInvalidSession",
  unknown_identity: "chat.sessionErrUnknownIdentity",
  unknown_mode: "chat.sessionErrUnknownMode",
  invalid_apply: "chat.sessionErrInvalidApply",
  session_live: "chat.sessionErrSessionLive",
  file_changed: "chat.sessionErrFileChanged",
  write_failed: "chat.sessionErrWriteFailed",
  rotation_pending: "chat.sessionErrRotationPending",
  unsupported_platform: "chat.sessionErrUnsupportedPlatform",
  unsupported_api_mode: "chat.sessionErrUnsupportedApiMode",
};

export function sessionControlErrorKey(code: string | null | undefined): string {
  return (code && ERROR_KEYS[code]) || "chat.sessionErrUnknown";
}
