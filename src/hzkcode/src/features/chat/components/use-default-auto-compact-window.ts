import { useCallback, useEffect, useRef, useState } from "react";
import { listenSettingsChanged } from "@/lib/events";
import { useTauriEvent } from "@/hooks/use-tauri-event";
import { ipc } from "@/lib/ipc";
import { CLI_CONFIG_CHANGED_EVENT } from "@/features/settings/providers";

/**
 * The channel/feature auto-compact window the next send would use — the
 * 跟随默认 denominator of the composer's context meter, matching what the
 * engine actually runs with (read-only command; no credentials cross the
 * boundary).
 *
 * Re-reads when a channel is edited (settings tree) or app settings change
 * (功能开关), and only the newest read is applied: a slow older response
 * cannot clobber a newer channel's value.
 */
export function useDefaultAutoCompactWindow(
  engine: string,
  providerId: string | null,
): number | null {
  const [defaultWindow, setDefaultWindow] = useState<number | null>(null);
  const seqRef = useRef(0);
  const read = useCallback(() => {
    const seq = ++seqRef.current;
    void ipc
      .defaultAutoCompactWindow(engine, providerId)
      .then((value) => {
        if (seqRef.current !== seq) return;
        setDefaultWindow(typeof value === "number" ? value : null);
      })
      .catch(() => {});
  }, [engine, providerId]);
  // Both subscriptions register once on mount; route through a ref so each
  // fire re-reads with the current engine/provider instead of the mount-time
  // closure.
  const readRef = useRef(read);
  readRef.current = read;
  useEffect(() => read(), [read]);
  useTauriEvent(() => listenSettingsChanged(() => readRef.current()));
  useEffect(() => {
    const onConfigChanged = () => readRef.current();
    window.addEventListener(CLI_CONFIG_CHANGED_EVENT, onConfigChanged);
    return () =>
      window.removeEventListener(CLI_CONFIG_CHANGED_EVENT, onConfigChanged);
  }, []);
  return defaultWindow;
}
