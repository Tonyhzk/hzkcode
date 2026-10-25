import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionControlDialog } from "./SessionControlDialog";
import type { SessionControlState } from "@/lib/ipc";
import type { SessionIdentityOption } from "../session-control-view";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string) => (key === "chat.sessionIdentityJoin" ? "、" : key),
  }),
}));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const IDENTITIES: SessionIdentityOption[] = [
  {
    value: null,
    name: "默认",
    group: "default",
    source: "default",
  },
  {
    value: "simple-internal",
    name: "精简",
    group: "builtin",
    source: "built-in",
  },
  {
    value: "reviewer",
    name: "审查",
    group: "external",
    source: "userSettings",
  },
];

function state(overrides: Partial<SessionControlState> = {}): SessionControlState {
  return {
    hasConversation: true,
    availableApplyMethods: {
      identity: ["current", "clone", "append"],
      promptMode: ["current", "clone"],
    },
    identity: { base: "simple-internal", extensions: [] },
    promptMode: { effective: "full", override: null, source: "startup" },
    interactionMode: { effective: "default", override: null, source: "startup" },
    apiMode: { effective: "anthropic", override: null, source: "startup" },
    model: { effective: "high", override: null, source: "startup" },
    effort: { effective: null, override: null, source: "startup" },
    permission: { effective: "default", override: null, source: "startup" },
    ...overrides,
  };
}

function identityOption(value: string | null): SessionIdentityOption {
  return IDENTITIES.find((option) => option.value === value)!;
}

async function renderDialog(props: Partial<React.ComponentProps<typeof SessionControlDialog>> = {}) {
  const onApply = vi.fn();
  const onClose = vi.fn();
  const onRefresh = vi.fn();
  await act(async () => {
    root.render(
      <SessionControlDialog
        identities={IDENTITIES}
        initialIdentity={identityOption("simple-internal")}
        state={state()}
        busy={false}
        onApply={onApply}
        onClose={onClose}
        onRefresh={onRefresh}
        {...props}
      />,
    );
  });
  return { onApply, onClose, onRefresh };
}

async function click(element: Element) {
  await act(async () => {
    element.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  });
}

function buttonByText(text: string) {
  return [...container.querySelectorAll("button")].find(
    (button) => button.textContent === text,
  )!;
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe("SessionControlDialog", () => {
  it("applies the chosen identity with the chosen method", async () => {
    const { onApply } = await renderDialog();
    const reviewer = container.querySelector('[data-identity="reviewer"]')!;
    await click(reviewer);
    const clone = container.querySelector('[data-apply="clone"]')!;
    await click(clone);
    await click(buttonByText("chat.sessionApply"));

    expect(onApply).toHaveBeenCalledTimes(1);
    const [selected, method] = onApply.mock.calls[0]!;
    expect(selected.value).toBe("reviewer");
    expect(method).toBe("clone");
  });

  it("keeps the default identity from being appended", async () => {
    const { onApply } = await renderDialog();
    await click(container.querySelector('[data-identity="__default__"]')!);
    const append = container.querySelector('[data-apply="append"]')!;
    expect(append.getAttribute("aria-disabled")).toBe("true");
    await click(append);
    await click(buttonByText("chat.sessionApply"));

    const [selected, method] = onApply.mock.calls[0]!;
    expect(selected.value).toBeNull();
    expect(method).toBe("current");
  });

  it("hides apply methods and applies in place without conversation", async () => {
    const { onApply } = await renderDialog({
      state: state({ hasConversation: false, identity: { base: null, extensions: [] } }),
      initialIdentity: identityOption(null),
    });
    expect(container.querySelector("[data-apply]")).toBeNull();
    await click(buttonByText("chat.sessionApply"));
    const [selected, method] = onApply.mock.calls[0]!;
    expect(selected.value).toBeNull();
    expect(method).toBe("current");
  });

  it("marks large reported input as a confirmation warning", async () => {
    await renderDialog({
      usage: {
        input_tokens: 1200,
        output_tokens: 30,
        cache_read_input_tokens: 99000,
        cache_creation_input_tokens: 500,
      },
    });
    const hint = container.querySelector('[data-testid="session-cache-hint"]')!;
    expect(hint.getAttribute("data-large")).toBe("true");
  });

  it("keeps the selection and dialog on a failed apply", async () => {
    const { onApply, onClose } = await renderDialog();
    await click(container.querySelector('[data-identity="reviewer"]')!);
    await click(buttonByText("chat.sessionApply"));
    expect(onApply).toHaveBeenCalled();

    // 父层失败后重新传入新对象与新初始身份，弹层和用户刚选的项都不能重置。
    await act(async () => {
      root.render(
        <SessionControlDialog
          identities={IDENTITIES}
          initialIdentity={identityOption("simple-internal")}
          state={state()}
          busy={false}
          error="chat.sessionErrFileChanged"
          onApply={onApply}
          onClose={onClose}
        />,
      );
    });
    expect(container.querySelector('[data-identity="reviewer"]')!.getAttribute("aria-checked")).toBe("true");
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("disables every action while busy", async () => {
    const { onApply, onClose } = await renderDialog({ busy: true });
    expect(buttonByText("chat.sessionApplying").hasAttribute("disabled")).toBe(true);
    expect(buttonByText("common.cancel").hasAttribute("disabled")).toBe(true);
    await click(buttonByText("chat.sessionApplying"));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });

  it("shows unavailable state and offers a retry", async () => {
    const { onApply, onRefresh } = await renderDialog({ state: null });
    expect(buttonByText("chat.sessionApply").hasAttribute("disabled")).toBe(true);
    await click(buttonByText("common.refresh"));
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });

  it("does not apply on cancel", async () => {
    const { onApply, onClose } = await renderDialog();
    await click(buttonByText("common.cancel"));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
