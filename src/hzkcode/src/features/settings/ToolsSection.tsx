import { CliEnvCards } from "./CliEnvGroupCard";

/**
 * 工具 page: the built-in tools the model may call — search, media reading and
 * the task/plan pair — each with its own switch and model overrides.
 */
export function ToolsSection() {
  return (
    <div className="flex w-full flex-col gap-6">
      <CliEnvCards ids={["search", "mediaRead", "taskPlan"]} />
    </div>
  );
}
