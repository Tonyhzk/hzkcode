import { afterEach, describe, expect, it, vi } from "vitest";

const env = vi.hoisted(() => ({ web: false }));

vi.mock("./transport", () => ({
  get isWeb() {
    return env.web;
  },
  webToken: "tok",
  serverVersion: async () => null,
}));

vi.mock("@tauri-apps/api/core", () => ({
  convertFileSrc: (path: string) => `asset://localhost/${encodeURIComponent(path)}`,
  invoke: async () => undefined,
}));

import { fileUrl } from "./platform";

describe("fileUrl", () => {
  afterEach(() => {
    delete (window as { __hzkcodeMediaBase?: string }).__hzkcodeMediaBase;
    env.web = false;
  });

  it("prefers the injected loopback media base", () => {
    window.__hzkcodeMediaBase = "http://127.0.0.1:41235/media?token=t0k";
    expect(fileUrl("/tmp/a b.mp4")).toBe(
      "http://127.0.0.1:41235/media?token=t0k&path=%2Ftmp%2Fa%20b.mp4",
    );
  });

  it("falls back to the asset protocol when the base is not injected", () => {
    expect(fileUrl("/tmp/a.png")).toBe(
      `asset://localhost/${encodeURIComponent("/tmp/a.png")}`,
    );
  });

  it("uses the bridge's /file route in web mode", () => {
    env.web = true;
    window.__hzkcodeMediaBase = "http://127.0.0.1:1/media?token=x";
    expect(fileUrl("/tmp/a.png")).toBe("/file?path=%2Ftmp%2Fa.png&token=tok");
  });
});
