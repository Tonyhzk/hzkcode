import { CliFeaturesCard } from "./CliFeaturesCard";

/**
 * 功能开关 page: the app-managed CLI feature variables (联网搜索、图片上传、
 * 飞书通知、用户记忆、第二大脑、自动模式、工作状态汇报、会话代理与多模态
 * 读取…). Split out of the 模型配置 page so channels stay channels.
 */
export function CliFeaturesSection() {
  return (
    <div className="flex w-full flex-col gap-6">
      <CliFeaturesCard />
    </div>
  );
}
