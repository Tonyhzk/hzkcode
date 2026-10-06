import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { listenSettingsChanged } from "@/lib/events";
import {
  CLI_CONFIG_CHANGED_EVENT,
  notifyCliConfigChanged,
} from "@/features/settings/providers";
import { useDefaultAutoCompactWindow } from "./use-default-auto-compact-window";

vi.mock("@/lib/ipc", () => ({
  ipc: { defaultAutoCompactWindow: vi.fn() },
}));
vi.mock("@/lib/events", () => ({
  listenSettingsChanged: vi.fn(),
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function Harness({
  engine,
  providerId,
}: {
  engine: string;
  providerId: string | null;
}) {
  const value = useDefaultAutoCompactWindow(engine, providerId);
  return <output>{String(value)}</output>;
}

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};

describe("useDefaultAutoCompactWindow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let settingsCb: (() => void) | null;
  let values: Record<string, number | null>;
  let calls: Array<[string, string | null]>;

  beforeEach(() => {
    vi.clearAllMocks();
    settingsCb = null;
    values = {};
    calls = [];
    vi.mocked(ipc.defaultAutoCompactWindow).mockImplementation(
      async (engine, providerId) => {
        calls.push([engine, providerId ?? null]);
        return values[providerId ?? "null"] ?? null;
      },
    );
    vi.mocked(listenSettingsChanged).mockImplementation(
      async (cb: () => void) => {
        settingsCb = cb;
        return () => {};
      },
    );
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (engine: string, providerId: string | null) =>
    act(async () => {
      root.render(<Harness engine={engine} providerId={providerId} />);
    });

  it("reads the current channel's window on mount", async () => {
    values["chan-a"] = 200_000;
    await render("claude", "chan-a");
    expect(container.textContent).toBe("200000");
  });

  it("shows null when no channel default is configured", async () => {
    await render("claude", "chan-a");
    expect(calls).toEqual([["claude", "chan-a"]]);
    expect(container.textContent).toBe("null");
  });

  it("re-reads when the session's channel changes", async () => {
    values["chan-a"] = 200_000;
    values["chan-b"] = 900_000;
    await render("claude", "chan-a");
    expect(container.textContent).toBe("200000");

    await render("claude", "chan-b");
    expect(container.textContent).toBe("900000");
  });

  it("re-reads with the current channel when a channel edit fires", async () => {
    values["chan-a"] = 200_000;
    values["chan-b"] = 900_000;
    await render("claude", "chan-a");
    await render("claude", "chan-b");
    expect(container.textContent).toBe("900000");

    // The user edits channel B: the source now reports the new window and the
    // settings tree broadcasts the change.
    values["chan-b"] = 950_000;
    await act(async () => {
      notifyCliConfigChanged();
    });

    expect(container.textContent).toBe("950000");
    // The listener re-read the *current* channel, not the mount-time one.
    expect(calls.at(-1)).toEqual(["claude", "chan-b"]);
  });

  it("re-reads with the current channel on app-settings changes", async () => {
    values["chan-a"] = 200_000;
    values["chan-b"] = 900_000;
    await render("claude", "chan-a");
    await render("claude", "chan-b");
    expect(settingsCb).toBeTypeOf("function");

    values["chan-b"] = 880_000;
    await act(async () => {
      settingsCb!();
    });

    expect(container.textContent).toBe("880000");
    expect(calls.at(-1)).toEqual(["claude", "chan-b"]);
  });

  it("a slow older read cannot overwrite the newer channel's value", async () => {
    const older = deferred<number | null>();
    const newer = deferred<number | null>();
    vi.mocked(ipc.defaultAutoCompactWindow)
      .mockImplementationOnce(() => older.promise)
      .mockImplementationOnce(() => newer.promise);

    await render("claude", "chan-a");
    await render("claude", "chan-b");
    expect(ipc.defaultAutoCompactWindow).toHaveBeenCalledTimes(2);

    // The newer channel's request resolves first and lands.
    await act(async () => {
      newer.resolve(900_000);
    });
    expect(container.textContent).toBe("900000");

    // The stale response arrives late and must be dropped.
    await act(async () => {
      older.resolve(200_000);
    });
    expect(container.textContent).toBe("900000");
  });

  it("subscribes to both the tauri settings event and the channel-edit event", async () => {
    await render("claude", "chan-a");
    expect(listenSettingsChanged).toHaveBeenCalledTimes(1);
    expect(settingsCb).toBeTypeOf("function");
    // The window event name the settings tree dispatches is the one wired in.
    expect(CLI_CONFIG_CHANGED_EVENT).toBe("hzkcode:cli-config-changed");
  });
});
