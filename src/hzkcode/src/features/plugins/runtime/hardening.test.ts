import { describe, expect, it } from "vitest";
import { installHardening, runAsPlugin } from "./hardening";

describe("hardening", () => {
  it("blocks direct Tauri IPC while plugin code is on the stack, allows host calls", async () => {
    const calls: string[] = [];
    window.__TAURI_INTERNALS__ = {
      invoke: async (cmd: string) => {
        calls.push(cmd);
        return null;
      },
    };
    installHardening();

    // Host context: passes through.
    await window.__TAURI_INTERNALS__.invoke!("host_cmd");
    expect(calls).toEqual(["host_cmd"]);

    // Plugin context: rejected without reaching the real invoke.
    await expect(
      runAsPlugin(() => window.__TAURI_INTERNALS__!.invoke!("plugin_cmd")),
    ).rejects.toThrow(/blocked/);
    expect(calls).toEqual(["host_cmd"]);
  });

  it("runAsPlugin restores the host context even when plugin code throws", async () => {
    expect(() =>
      runAsPlugin(() => {
        throw new Error("plugin bug");
      }),
    ).toThrow("plugin bug");
    await window.__TAURI_INTERNALS__!.invoke!("after_crash");
  });
});
