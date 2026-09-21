import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
// Side-effect import: initializes the i18next instance useTranslation reads.
import "@/lib/i18n";

// Mutable knobs so one file covers both platforms and both window kinds.
const env = vi.hoisted(() => ({
  mac: true,
  kind: "editor" as "main" | "editor",
}));

vi.mock("@/lib/platform", () => ({
  get IS_MAC() {
    return env.mac;
  },
  isWeb: false,
  startWindowDrag: () => {},
}));

vi.mock("@/lib/window-context", () => ({
  get windowContext() {
    return env.kind === "editor"
      ? { kind: "editor", filePath: "/tmp/a.ts" }
      : { kind: "main" };
  },
}));

import { FileEditorHeader } from "./FileEditorHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("FileEditorHeader traffic-light inset", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render() {
    act(() => {
      root.render(
        <FileEditorHeader
          path="/tmp/a.ts"
          name="a.ts"
          dirty={false}
          readOnly={false}
          isMarkdown={false}
          mdMode="edit"
          onMdModeChange={() => {}}
          saving={false}
          onSave={() => {}}
        />,
      );
    });
    return container.firstElementChild as HTMLElement;
  }

  beforeEach(() => {
    env.mac = true;
    env.kind = "editor";
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("reserves the macOS traffic-light corner in a standalone editor window", () => {
    const el = render();
    expect(el.className).toContain("pl-[80px]");
    expect(el.className).not.toContain("px-3");
  });

  it("keeps the dock's header (main window) at the normal inset", () => {
    env.kind = "main";
    const el = render();
    expect(el.className).toContain("px-3");
    expect(el.className).not.toContain("pl-[80px]");
  });

  it("does not inset on non-mac platforms", () => {
    env.mac = false;
    const el = render();
    expect(el.className).toContain("px-3");
    expect(el.className).not.toContain("pl-[80px]");
  });
});
