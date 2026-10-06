import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import i18n from "@/lib/i18n";
import { ChangesPanelHeader } from "./ChangesPanelHeader";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const findButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);

const setInputValue = (input: HTMLInputElement, value: string) => {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype,
    "value",
  )!.set!;
  setter.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
};

const submitForm = (container: HTMLElement) => {
  container
    .querySelector("form")!
    .dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
};

describe("ChangesPanelHeader remote row", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = async ({
    remote,
    onSaveRemote,
  }: {
    remote: { name: string; url: string; pushUrl?: string } | null | undefined;
    onSaveRemote?: (url: string, pushUrl: string | null) => Promise<boolean>;
  }) => {
    await act(async () => {
      root.render(
        <ChangesPanelHeader
          workspacePath="/ws"
          notRepo={false}
          branch="main"
          ahead={undefined}
          behind={undefined}
          branches={[{ name: "main", isCurrent: true }]}
          remote={remote}
          onSaveRemote={onSaveRemote ?? (async () => true)}
          pending={{}}
          error={null}
          run={() => {}}
          onDismissError={() => {}}
        />,
      );
    });
  };

  const openForm = async (label: string) => {
    await act(async () => {
      findButton(container, label)!.click();
    });
  };

  const textInputs = () =>
    [...container.querySelectorAll<HTMLInputElement>("input")].filter(
      (input) => input.type !== "checkbox",
    );

  it("binds a URL through the inline form when no remote is set", async () => {
    const onSaveRemote = vi.fn(async () => true);
    await render({ remote: null, onSaveRemote });

    await openForm(i18n.t("git.bindRemote"));
    await act(async () => {
      setInputValue(textInputs()[0], "https://example.com/x.git");
    });
    await act(async () => {
      submitForm(container);
    });

    // The checkbox defaults to checked: the explicit push choice is "" (the
    // push URL follows the fetch URL, clearing any leftover pushurl).
    expect(onSaveRemote).toHaveBeenCalledWith("https://example.com/x.git", "");
    // Success closes the form.
    expect(container.querySelector("input")).toBeNull();
  });

  it("keeps the form open when the save fails", async () => {
    const onSaveRemote = vi.fn(async () => false);
    await render({ remote: null, onSaveRemote });

    await openForm(i18n.t("git.bindRemote"));
    await act(async () => {
      setInputValue(textInputs()[0], "https://example.com/x.git");
    });
    await act(async () => {
      submitForm(container);
    });

    expect(onSaveRemote).toHaveBeenCalledTimes(1);
    expect(container.querySelector("input")).not.toBeNull();
  });

  it("shows the bound remote with an edit entry", async () => {
    await render({
      remote: { name: "origin", url: "https://***@git.example.com/x.git" },
    });
    expect(container.textContent).toContain("https://***@git.example.com/x.git");
    expect(findButton(container, i18n.t("git.editRemote"))).toBeTruthy();
    // No separate push URL configured: nothing extra to surface.
    expect(textInputs().length).toBe(0);
  });

  it("surfaces a separate push URL when one is configured", async () => {
    await render({
      remote: {
        name: "origin",
        url: "https://github.com/x/y.git",
        pushUrl: "https://***@mirror.example.com/y.git",
      },
    });
    expect(container.textContent).toContain("https://***@mirror.example.com/y.git");
  });

  it("offers an explicit separate push URL, starting unchecked when one exists", async () => {
    const onSaveRemote = vi.fn(async () => true);
    await render({
      remote: {
        name: "origin",
        url: "https://github.com/x/y.git",
        pushUrl: "https://***@mirror.example.com/y.git",
      },
      onSaveRemote,
    });

    await openForm(i18n.t("git.editRemote"));
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    // A separate push URL exists: the same-URL box starts unchecked.
    expect(checkbox.checked).toBe(false);
    // url field + separate push field.
    expect(textInputs().length).toBe(2);

    await act(async () => {
      setInputValue(textInputs()[0], "https://github.com/x/z.git");
    });
    await act(async () => {
      setInputValue(textInputs()[1], "ssh://git@push.example.com/z.git");
    });
    await act(async () => {
      submitForm(container);
    });

    expect(onSaveRemote).toHaveBeenCalledWith(
      "https://github.com/x/z.git",
      "ssh://git@push.example.com/z.git",
    );
  });

  it("keeps the current push configuration when the field is left blank", async () => {
    const onSaveRemote = vi.fn(async () => true);
    await render({
      remote: {
        name: "origin",
        url: "https://github.com/x/y.git",
        pushUrl: "https://***@mirror.example.com/y.git",
      },
      onSaveRemote,
    });

    await openForm(i18n.t("git.editRemote"));
    await act(async () => {
      setInputValue(textInputs()[0], "https://github.com/x/w.git");
    });
    await act(async () => {
      submitForm(container);
    });

    expect(onSaveRemote).toHaveBeenCalledWith("https://github.com/x/w.git", null);
  });

  it("clears a separate push URL when the same-URL box is checked", async () => {
    const onSaveRemote = vi.fn(async () => true);
    await render({
      remote: {
        name: "origin",
        url: "https://github.com/x/y.git",
        pushUrl: "https://***@mirror.example.com/y.git",
      },
      onSaveRemote,
    });

    await openForm(i18n.t("git.editRemote"));
    const checkbox = container.querySelector<HTMLInputElement>(
      'input[type="checkbox"]',
    )!;
    await act(async () => {
      checkbox.click();
    });
    expect(checkbox.checked).toBe(true);
    // The separate push field is gone.
    expect(textInputs().length).toBe(1);

    await act(async () => {
      setInputValue(textInputs()[0], "https://github.com/x/y2.git");
    });
    await act(async () => {
      submitForm(container);
    });

    expect(onSaveRemote).toHaveBeenCalledWith("https://github.com/x/y2.git", "");
  });

  it("stays quiet while the remote is still loading", async () => {
    await render({ remote: undefined });
    expect(findButton(container, i18n.t("git.bindRemote"))).toBeUndefined();
    expect(findButton(container, i18n.t("git.editRemote"))).toBeUndefined();
  });
});
