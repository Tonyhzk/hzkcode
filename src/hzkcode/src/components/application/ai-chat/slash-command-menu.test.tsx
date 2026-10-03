import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlashCommandMenu, type SlashCommandMenuHandle } from "./slash-command-menu";
import { builtinSlashCommands, mergeSlashCommands, useSlashCommandStore } from "./slash-commands";
import { type SlashCommandEntry } from "@/lib/ipc";
import { useChatStore } from "@/features/chat/store";
import { EMPTY_SESSION } from "@/features/chat/store/stream";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
  // The chat store imports the app i18n instance, which calls
  // i18n.use(initReactI18next); keep that registration a no-op here.
  initReactI18next: { type: "3rdParty", init: () => {} },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));
// jsdom omits scrollIntoView; the menu calls it to keep the active row visible.
Element.prototype.scrollIntoView ??= () => {};

const ENTRIES: SlashCommandEntry[] = [
  { name: "commit", description: "提交变更", source: "workspace", kind: "command" },
  { name: "ccg:review", description: "多模型代码审查", source: "global", kind: "command" },
  { name: "code-review", description: "审查代码", source: "workspace", kind: "skill" },
];

/** The CLI's announced built-ins for the test session (rendered sorted). */
const SESSION_COMMANDS = ["files", "cost", "compact"];
const SESSION_KEY = "claude/s-1";
const BUILTIN_COUNT = SESSION_COMMANDS.length;

const optionTexts = (node: HTMLElement) =>
  [...node.querySelectorAll('[role="option"]')].map((el) => el.textContent);

describe("SlashCommandMenu", () => {
  let node: HTMLDivElement, root: Root;
  beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    node = document.createElement("div");
    document.body.append(node);
    root = createRoot(node);
    useSlashCommandStore.setState({
      byRoot: { "/ws": { entries: ENTRIES, status: "ready", fetchedAt: Date.now() } },
    });
    useChatStore.setState({
      active: { engine: "claude", sessionId: "s-1", workspacePath: "/ws" },
      bySession: {
        [SESSION_KEY]: { ...EMPTY_SESSION, availableCommands: [...SESSION_COMMANDS] },
      },
    });
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    node.remove();
  });

  it("groups built-ins, commands and skills under kind headers with per-row badges", async () => {
    await act(async () =>
      root.render(
        <SlashCommandMenu root="/ws" query="" left={0} onSelect={vi.fn()} onClose={vi.fn()} />,
      ),
    );
    const headers = [...node.querySelectorAll('[role="listbox"] > div > div > div:first-child')]
      .map((el) => el.textContent)
      .filter(
        (text) =>
          text === "chat.slashBuiltinGroup" ||
          text === "chat.slashGroupCommands" ||
          text === "chat.slashGroupSkills",
      );
    expect(headers).toEqual([
      "chat.slashBuiltinGroup",
      "chat.slashGroupCommands",
      "chat.slashGroupSkills",
    ]);
    // Built-ins first (sorted), then the catalog's commands and skills; each
    // row ends with its kind badge.
    const rows = optionTexts(node);
    expect(rows).toHaveLength(BUILTIN_COUNT + ENTRIES.length);
    expect(rows[0]).toContain("/compact");
    expect(rows[0]).toContain("chat.slashKindBuiltin");
    expect(rows[BUILTIN_COUNT]).toContain("/commit");
    expect(rows[BUILTIN_COUNT]).toContain("chat.slashKindCommand");
    expect(rows[rows.length - 1]).toContain("/code-review");
    expect(rows[rows.length - 1]).toContain("chat.slashKindSkill");
  });

  it("keyboard navigation crosses kind boundaries and Enter selects", async () => {
    const onSelect = vi.fn();
    const menuRef: { current: SlashCommandMenuHandle | null } = { current: null };
    await act(async () =>
      root.render(
        <SlashCommandMenu
          root="/ws"
          query=""
          left={0}
          onSelect={onSelect}
          onClose={vi.fn()}
          menuRef={menuRef}
        />,
      ),
    );
    // The ref is re-registered as activeIndex changes; read it fresh per
    // keypress (a cached handle closes over a stale `active`).
    act(() => {
      expect(menuRef.current!.handleKey("ArrowDown")).toBe(true);
    });
    expect(node.querySelector('[data-active="true"]')?.textContent).toContain("/cost");
    // Continue across the built-in/catalog boundary onto the first command.
    for (let i = 0; i < BUILTIN_COUNT - 1; i++) {
      act(() => {
        menuRef.current!.handleKey("ArrowDown");
      });
    }
    expect(node.querySelector('[data-active="true"]')?.textContent).toContain("/commit");
    act(() => {
      expect(menuRef.current!.handleKey("Enter")).toBe(true);
    });
    expect(onSelect).toHaveBeenCalledWith(ENTRIES[0]);
  });

  it("query filters across all kinds and keeps kind grouping intact", async () => {
    await act(async () =>
      root.render(
        <SlashCommandMenu root="/ws" query="review" left={0} onSelect={vi.fn()} onClose={vi.fn()} />,
      ),
    );
    const rows = optionTexts(node);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain("/ccg:review");
    expect(rows[1]).toContain("/code-review");
  });
});

describe("mergeSlashCommands", () => {
  it("drops a builtin whose name a catalog entry takes over", () => {
    const merged = mergeSlashCommands(
      builtinSlashCommands((key) => key, ["compact", "cost"]),
      [{ name: "Compact", description: "工作区自定义", source: "workspace", kind: "command" }],
    );
    const compacts = merged.filter((entry) => entry.name.toLowerCase() === "compact");
    expect(compacts).toHaveLength(1);
    expect(compacts[0].source).toBe("workspace");
  });

  it("dedupes and sorts announced names, keeping built-ins ahead of the catalog", () => {
    const builtins = builtinSlashCommands((key) => key, ["cost", "compact", "cost", ""]);
    expect(builtins.map((entry) => entry.name)).toEqual(["compact", "cost"]);
    const merged = mergeSlashCommands(builtins, ENTRIES);
    expect(merged.slice(0, 2)).toEqual(builtins);
    expect(merged.slice(2)).toEqual(ENTRIES);
  });
});
