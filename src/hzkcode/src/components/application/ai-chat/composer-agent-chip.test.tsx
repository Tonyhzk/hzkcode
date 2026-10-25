import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionIdentityChip } from "./composer-agent-chip";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "chat.sessionIdentityJoin" ? "、" : key),
  }),
}));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("SessionIdentityChip", () => {
  it("shows the base identity and appended count", async () => {
    await act(async () => {
      root.render(
        <SessionIdentityChip
          name="领队"
          appended={["审查", "规划"]}
          onClear={() => {}}
        />,
      );
    });
    const chip = container.querySelector('[data-testid="session-identity-chip"]')!;
    expect(chip.textContent).toContain("领队");
    expect(chip.textContent).toContain("+2");
  });

  it("clears through the session-control request, not a local pin", async () => {
    const onClear = vi.fn();
    await act(async () => {
      root.render(
        <SessionIdentityChip name={null} appended={[]} onClear={onClear} />,
      );
    });
    const button = container.querySelector(
      'button[aria-label="chat.sessionIdentityRemove"]',
    )!;
    await act(async () => {
      button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(onClear).toHaveBeenCalledTimes(1);
  });
});
