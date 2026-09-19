import { create } from "zustand";
import { check } from "@tauri-apps/plugin-updater";
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { isWeb } from "@/lib/transport";
import { getAppVersion } from "@/lib/platform";

export type UpdateStage =
  | "idle"
  | "checking"
  | "available"
  | "downloading"
  | "installing"
  | "restarting"
  | "latest"
  | "error";

interface UpdateStore {
  stage: UpdateStage;
  /** Version of the pending update, when one was found. */
  version?: string;
  downloadedBytes: number;
  totalBytes?: number;
  error?: string;
  /**
   * `interactive` surfaces failures and the "up to date" result to the user;
   * the background auto-check stays silent for both.
   */
  checkForUpdates: (options?: { interactive?: boolean }) => Promise<void>;
  startUpdate: () => Promise<void>;
  dismiss: () => void;
}

// plugin-updater's check() uses reqwest with no default timeout: when the
// update server is unreachable the promise never settles and the UI would
// sit on "checking" forever. Treat a timeout as a failed check.
const CHECK_TIMEOUT_MS = 15_000;
const LATEST_RESET_MS = 2_000;

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  const { promise: result, resolve, reject } = Promise.withResolvers<T>();
  const timer = setTimeout(() => reject(new Error(message)), ms);
  promise.then(
    (value) => {
      clearTimeout(timer);
      resolve(value);
    },
    (error) => {
      clearTimeout(timer);
      reject(error);
    },
  );
  return result;
}

/** The plugin's Update handle lives outside React state; stale handles are
 *  closed so a superseded check never leaks a downloaded bundle. */
let pendingUpdate: Update | null = null;
let checkRequestId = 0;
let latestResetTimer: ReturnType<typeof setTimeout> | null = null;

async function closeUpdateHandle(update: Update | null) {
  try {
    await update?.close();
  } catch (error) {
    console.warn("[updater] failed to close update handle", error);
  }
}

export const useUpdateStore = create<UpdateStore>((set, get) => ({
  stage: "idle",
  downloadedBytes: 0,

  checkForUpdates: async (options) => {
    // The LAN web-access frontend has no native shell to update; the desktop
    // host serves it, so update checks are meaningless there.
    if (isWeb) return;

    const requestId = ++checkRequestId;
    const isStale = () => checkRequestId !== requestId;

    if (latestResetTimer !== null) {
      clearTimeout(latestResetTimer);
      latestResetTimer = null;
    }

    const applyNoUpdate = async () => {
      const current = pendingUpdate;
      pendingUpdate = null;
      await closeUpdateHandle(current);

      if (options?.interactive) {
        set({ stage: "latest", error: undefined });
        latestResetTimer = setTimeout(() => {
          latestResetTimer = null;
          if (!isStale()) set({ stage: "idle" });
        }, LATEST_RESET_MS);
        return;
      }
      set({ stage: "idle" });
    };

    let update: Update | null = null;
    try {
      set({ stage: "checking", error: undefined });
      update = await withTimeout(check(), CHECK_TIMEOUT_MS, "update check timed out");
      if (isStale()) return;

      if (!update) {
        await applyNoUpdate();
        return;
      }

      // The endpoint can momentarily point at the running release right after
      // publishing; don't nag the user to "update" to their own version.
      // Both sides normalized: the endpoint tags versions "v1.0.0".
      const currentVersion = (await getAppVersion())?.trim().replace(/^v/i, "") ?? null;
      if (currentVersion && update.version.trim().replace(/^v/i, "") === currentVersion) {
        await applyNoUpdate();
        return;
      }

      const previous = pendingUpdate;
      pendingUpdate = update;
      if (previous && previous !== update) void closeUpdateHandle(previous);

      set({ stage: "available", version: update.version });
    } catch (error) {
      if (isStale()) return;
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[updater] check failed", message);
      set(
        options?.interactive
          ? { stage: "error", error: message }
          : { stage: "idle" },
      );
    } finally {
      if (update && (isStale() || pendingUpdate !== update)) {
        await closeUpdateHandle(update);
      }
    }
  },

  startUpdate: async () => {
    const update = pendingUpdate;
    if (!update) {
      await get().checkForUpdates({ interactive: true });
      return;
    }

    set({ stage: "downloading", downloadedBytes: 0, totalBytes: undefined, error: undefined });
    try {
      await update.downloadAndInstall((event: DownloadEvent) => {
        if (event.event === "Started") {
          set({ totalBytes: event.data.contentLength, downloadedBytes: 0 });
        } else if (event.event === "Progress") {
          set((state) => ({
            downloadedBytes: state.downloadedBytes + event.data.chunkLength,
          }));
        } else if (event.event === "Finished") {
          set({ stage: "installing" });
        }
      });

      set({ stage: "restarting" });
      await relaunch();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn("[updater] install failed", message);
      set({ stage: "error", error: message });
    }
  },

  dismiss: () => {
    checkRequestId += 1;
    if (latestResetTimer !== null) {
      clearTimeout(latestResetTimer);
      latestResetTimer = null;
    }
    const current = pendingUpdate;
    pendingUpdate = null;
    void closeUpdateHandle(current);
    set({ stage: "idle", version: undefined, error: undefined });
  },
}));
