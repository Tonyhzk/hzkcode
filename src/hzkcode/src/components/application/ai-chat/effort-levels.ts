export type EffortLevel = "low" | "medium" | "high" | "xhigh" | "max";

/** The five effort stops, in slider order — the CLI's own ladder
 *  (off/none/low/medium/high/xhigh/max, minus the two the picker never
 *  offers). The last stop drives the slider's max-effort celebration. */
export const EFFORT_LEVELS: readonly EffortLevel[] = [
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
];

/** i18n label key per effort stop. */
export const EFFORT_LABEL_KEYS: Record<EffortLevel, string> = {
  low: "chat.effortLow",
  medium: "chat.effortMedium",
  high: "chat.effortHigh",
  xhigh: "chat.effortXhigh",
  max: "chat.effortMax",
};
