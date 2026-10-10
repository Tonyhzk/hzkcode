import { CliEnvCards } from "../CliEnvGroupCard";

/**
 * 行为 tab of the 智能体与提示词 page: how the engine reports its progress and
 * which configuration sources a session pulls in besides the workspace.
 */
export function BehaviorPane() {
  return (
    <div className="flex w-full flex-col gap-6">
      <CliEnvCards ids={["workStatus", "contextLoad"]} />
    </div>
  );
}
