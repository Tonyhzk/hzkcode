import { CliEnvCards } from "./CliEnvGroupCard";

/**
 * 后台助手 page: the side-query features that call a model of their own in the
 * background — 用户记忆, 第二大脑 and the auto-permission classifier.
 */
export function AssistantsSection() {
  return (
    <div className="flex w-full flex-col gap-6">
      <CliEnvCards ids={["memory", "secondBrain", "autoMode"]} />
    </div>
  );
}
