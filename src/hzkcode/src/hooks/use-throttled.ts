import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { ThrottledText } from "./throttled-text";

/** Short replies can be parsed more often; large documents need breathing
 * room for input, layout and reveal frames between full Markdown parses. */
export function streamParseInterval(length: number): number {
  return length <= 4000 ? 32 : length <= 16000 ? 64 : 128;
}

/** Coalesce streaming appends before expensive Markdown parsing. Completion,
 * replacements and truncation pass through in the current render. Publish
 * idle arrivals before paint, without queuing captured text in React state. */
export function useThrottled(value: string, ms: number): string {
  const [controller] = useState(() => new ThrottledText(value));
  const visible = useSyncExternalStore(controller.subscribe, controller.read, () => value);
  useLayoutEffect(() => { controller.update(value, ms); }, [controller, value, ms]);
  useLayoutEffect(() => () => controller.cancel(), [controller]);
  return controller.bypass(value, ms) ? value : visible;
}
