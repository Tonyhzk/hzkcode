import { CliEnvCards } from "./CliEnvGroupCard";

/**
 * 外部服务 page: credentials for the third-party services the tools talk to —
 * object storage for uploads and 飞书 for notifications.
 */
export function ServicesSection() {
  return (
    <div className="flex w-full flex-col gap-6">
      <CliEnvCards ids={["oss", "feishu"]} />
    </div>
  );
}
