import type {
  AgentConfig,
  SessionControlApply,
  SessionControlOperation,
  SessionControlRequest,
  SessionControlResult,
} from "@/lib/ipc";
import { normalizeTierAlias } from "@/features/settings/providers";
import i18n from "@/lib/i18n";

export type SessionControlCommand = {
  operation: Exclude<SessionControlOperation, "catalog" | "status">;
  value?: string;
  apply?: SessionControlApply;
  expectedRevision?: string;
  agent?: AgentConfig;
};

function agentDescription(name: string, prompt: string): string {
  const line = prompt.split("\n").map((item) => item.trim()).find(Boolean) ?? name;
  return line.length > 120 ? `${line.slice(0, 117)}…` : line;
}

/** 注册定义不选择身份；应用自带角色只附带当前会话实际引用的条目。 */
export function buildAgentsJson(
  agents: AgentConfig[],
  builtIns: { name: string; prompt: string }[] = [],
): string | null {
  const definitions: Record<string, Record<string, unknown>> = Object.create(null);
  for (const agent of agents) {
    if (agent.source === "builtIn") continue;
    const name = agent.name.trim();
    if (!name) continue;
    const prompt = agent.prompt?.trim() || i18n.t("chat.agentDefaultPrompt", { name });
    const model = agent.model ? normalizeTierAlias(agent.model) : null;
    definitions[name] = {
      description: agentDescription(name, prompt),
      prompt,
      context: agent.context ?? ["prompts", "claudemd", "memory"],
      ...(agent.tools !== undefined ? { tools: agent.tools } : {}),
      ...(model ? { model } : {}),
      ...(agent.effort ? { effort: agent.effort } : {}),
    };
  }
  for (const role of builtIns) {
    if (!role.prompt.trim()) throw new Error(i18n.t("chat.agentUnavailable"));
    definitions[role.name] = {
      description: agentDescription(role.name, role.prompt),
      prompt: role.prompt,
      context: ["prompts", "claudemd", "memory"],
    };
  }
  return Object.keys(definitions).length ? JSON.stringify(definitions) : null;
}

export function hasSavedControlValue(
  value: { override: unknown; source: "session" | "startup" } | null | undefined,
): boolean {
  return !!value && (value.override != null || value.source === "session");
}

export function sessionControlErrorText(result: SessionControlResult): string {
  const detail = result.errors?.map((line) => line.trim()).filter(Boolean);
  return detail?.length ? detail.join("；") : i18n.t("chat.sessionErrUnknown");
}

export function controlRequestWithRevision(
  command: SessionControlCommand,
  current: SessionControlResult | null | undefined,
): SessionControlRequest {
  const revision = command.expectedRevision ?? current?.revision ?? null;
  return {
    operation: command.operation,
    ...(command.value !== undefined ? { value: command.value } : {}),
    ...(command.apply !== undefined ? { apply: command.apply } : {}),
    ...(revision ? { expectedRevision: revision } : {}),
  };
}
