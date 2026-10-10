import { useCallback, useEffect, useRef, useState } from "react";
import { ipc } from "@/lib/ipc";
import { errorText } from "@/lib/errors";

/** Save coalescing: a text field fires per keystroke, and settings.json is a
 *  whole-file write. */
const SAVE_DEBOUNCE_MS = 500;

/** Every instance writes through this one chain: two read-modify-writes must
 *  not interleave, or the later one — built on a read taken before the
 *  earlier write landed — drops the earlier edits. */
let writeChain: Promise<void> = Promise.resolve();

export interface CliEnvStore {
  /** Stored values by env name; a missing key means "unset". */
  values: Record<string, string>;
  setEnv: (envKey: string, value: string) => void;
  error: string | null;
}

/**
 * Reads the app's CLI env map and writes edits back. Each write re-reads the
 * settings first and merges only the edited keys, so a page holding several
 * cards — or another window editing a different setting — never has its
 * changes clobbered by a stale whole-object write.
 *
 * One instance per settings page, shared by that page's cards.
 */
export function useCliEnv(): CliEnvStore {
  const [values, setValues] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  /** Keys edited since the last write; null = clear the entry. */
  const pending = useRef<Record<string, string | null>>({});
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const flush = useCallback(async (silent = false) => {
    if (timer.current) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    const patch = pending.current;
    pending.current = {};
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const write = writeChain.then(async () => {
      try {
        const latest = await ipc.getAppSettings();
        const cliEnv = { ...(latest.cliEnv ?? {}) };
        for (const key of keys) {
          const value = patch[key];
          if (value === null) delete cliEnv[key];
          else cliEnv[key] = value;
        }
        await ipc.updateAppSettings({ ...latest, cliEnv });
        if (!silent) setError(null);
      } catch (e) {
        // Keep the edits queued: the next edit (or the unmount flush) retries.
        pending.current = { ...patch, ...pending.current };
        if (!silent) setError(errorText(e));
      }
    });
    writeChain = write;
    await write;
  }, []);

  useEffect(() => {
    let cancelled = false;
    ipc
      .getAppSettings()
      .then((settings) => {
        if (!cancelled) setValues(settings.cliEnv ?? {});
      })
      .catch((e) => {
        if (!cancelled) setError(errorText(e));
      });
    return () => {
      cancelled = true;
      // Leave nothing typed behind: closing the settings modal right after an
      // edit must not drop the last keystrokes.
      void flush(true);
    };
  }, [flush]);

  const setEnv = useCallback(
    (envKey: string, value: string) => {
      const stored = value.trim() ? value : null;
      setValues((prev) => {
        const next = { ...prev };
        if (stored === null) delete next[envKey];
        else next[envKey] = value;
        return next;
      });
      pending.current[envKey] = stored;
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
    },
    [flush],
  );

  return { values, setEnv, error };
}
