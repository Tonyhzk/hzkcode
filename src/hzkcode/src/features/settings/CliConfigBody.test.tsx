import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    reorderProviders: () => Promise.resolve(),
  },
}));
import i18n from "@/lib/i18n";
import { CliConfigBody } from "./CliConfigBody";
import type { ProviderEntry } from "./providers";
import type { CliConfigState } from "./useCliConfig";

// React 18's act() requires this flag to be set by the test environment.
declare global {
  // eslint-disable-next-line no-var
  var IS_REACT_ACT_ENVIRONMENT: boolean;
}
globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function makeCli(over: Partial<CliConfigState> = {}): CliConfigState {
  return {
    t: i18n.t,
    config: null,
    engine: "claude",
    error: null,
    busy: false,
    dialog: null,
    setDialog: () => {},
    pendingDelete: null,
    setPendingDelete: () => {},
    currentId: "",
    entries: [],
    mutate: vi.fn(),
    activate: () => {},
    saveProvider: () => {},
    confirmDelete: () => {},
    ...over,
  } as CliConfigState;
}

const ENTRY: ProviderEntry = {
  id: "chan-a",
  name: "渠道 A",
  remark: "",
  baseUrl: "https://aiapi.example.com",
  apiKey: "",
  model: "deepseek-v4-pro[1m]",
  raw: {},
};

describe("CliConfigBody", () => {
  let container: HTMLDivElement;
  let root: Root | null;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = null;
  });

  afterEach(async () => {
    if (root) await act(async () => root?.unmount());
    container.remove();
  });

  async function render(cli: CliConfigState) {
    root = createRoot(container);
    await act(async () => root?.render(<CliConfigBody cli={cli} />));
  }

  function buttonByLabel(label: string): HTMLButtonElement {
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label || b.getAttribute("aria-label") === label,
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
  }

  it("empty list: shows the empty state and 添加渠道 opens the add dialog", async () => {
    const setDialog = vi.fn();
    await render(makeCli({ entries: [], setDialog }));
    expect(container.textContent).toContain(i18n.t("settings.cliEmptyTitle"));
    await act(async () => buttonByLabel(i18n.t("settings.cliDialogAdd")).click());
    expect(setDialog).toHaveBeenCalledWith({});
  });

  it("renders one row per channel and 编辑 opens the edit dialog", async () => {
    const setDialog = vi.fn();
    await render(makeCli({ entries: [ENTRY], currentId: "chan-a", setDialog }));
    expect(container.textContent).toContain("渠道 A");
    await act(async () => buttonByLabel(i18n.t("settings.cliEdit")).click());
    expect(setDialog).toHaveBeenCalledWith({ entry: ENTRY });
  });
});
