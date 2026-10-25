import { CliEnvCards } from "./CliEnvGroupCard";

/**
 * 工具 page: how the model reaches its tools (discovery) and the built-in
 * tools it may call — search, media reading and the task/plan pair — each
 * with its own switch and model overrides.
 */
export function ToolsSection() {
  return (
    <div className="flex w-full flex-col gap-6">
      <CliEnvCards ids={["search", "toolDiscovery", "mediaRead", "taskPlan"]} />
    </div>
  );
}
