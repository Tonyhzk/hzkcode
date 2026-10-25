export type EffortLevel =
  | "off"
  | "none"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

/** 七档思考等级，按滑杆顺序排列，与 CLI 自身一致。"off" 不向 API 发送
 *  等级，但仍以 "off" 随启动参数下发；"none" 是引擎独立的无思考偏好。
 *  最后一档触发滑杆的 max 庆祝效果。 */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "off",
  "none",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** i18n label key per effort stop. */
export const EFFORT_LABEL_KEYS: Record<EffortLevel, string> = {
  off: "chat.effortOff",
  none: "chat.effortNone",
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  xhigh: "chat.effortXhigh",
  max: "chat.effortMax",
};
