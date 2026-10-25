import { CliEnvCards } from "../CliEnvGroupCard";

/**
 * 行为 tab of the 智能体与提示词 page: how the engine reports its progress,
 * which configuration sources a session pulls in besides the workspace, how
 * detailed its built-in guidance is, and where temporary/plan/delete files go.
 */
export function BehaviorPane() {
  return (
    <div className="flex w-full flex-col gap-6">
      <CliEnvCards ids={["workStatus", "contextLoad", "promptMode", "projectFiles"]} />
    </div>
  );
}
