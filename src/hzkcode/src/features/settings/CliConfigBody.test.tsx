import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    // The bin-path / custom-models rows read AppSettings on mount.
    getAppSettings: () => Promise.resolve({ customModels: {} }),
  },
}));
import i18n from "@/lib/i18n";
import { CliConfigBody } from "./CliConfigBody";
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
    officialActive: true,
    officialEditing: false,
    setOfficialEditing: () => {},
    saveOfficialConfig: () => Promise.resolve(null),
    mutate: vi.fn(),
    activate: () => {},
    saveProvider: () => {},
    confirmDelete: () => {},
    ...over,
  } as CliConfigState;
}

describe("CliEngineSettingsCard official edit entry", () => {
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

  function editButton(): HTMLButtonElement {
    const label = i18n.t("settings.cliEdit");
    const button = Array.from(container.querySelectorAll("button")).find(
      (b) => b.textContent?.trim() === label,
    );
    expect(button).toBeDefined();
    return button as HTMLButtonElement;
  }

  it("file-managed engine: 编辑 stays available while a custom channel is current", async () => {
    await render(makeCli({ engine: "claude", officialActive: false, currentId: "chan-a" }));
    expect(editButton().disabled).toBe(false);
  });

  it("file-managed engine: 编辑 opens the generic editor when 官方配置 is active", async () => {
    const setOfficialEditing = vi.fn();
    await render(makeCli({ engine: "claude", officialActive: true, setOfficialEditing }));
    expect(editButton().disabled).toBe(false);
    await act(async () => editButton().click());
    expect(setOfficialEditing).toHaveBeenCalledWith(true);
  });
});
