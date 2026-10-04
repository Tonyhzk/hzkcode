import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { formatDuration } from "./format-duration";
import { MessageRow } from "./MessageTimeline";
import { branchTargets, buildRows, rowKey } from "./timeline-rows";
import type { Message } from "@/lib/ipc";

// React's act() environment flag — same setup as Markdown.test.tsx.
const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

// jsdom has no ResizeObserver (CollapsibleMessage measures with it); stub
// it the same way CollapsibleMessage.test.tsx does.
class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal("ResizeObserver", ResizeObserverStub);

describe("formatDuration", () => {
  it("returns null for null, undefined, 0, or negative values", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(0)).toBeNull();
    expect(formatDuration(-100)).toBeNull();
  });

  it("formats seconds under 60 with 1 decimal place", () => {
    expect(formatDuration(500)).toBe("0.5s");
    expect(formatDuration(12340)).toBe("12.3s");
    expect(formatDuration(59900)).toBe("59.9s");
  });

  it("formats minutes and seconds for values >= 60s and < 1h", () => {
    expect(formatDuration(60000)).toBe("1m");
    expect(formatDuration(84000)).toBe("1m24s");
    expect(formatDuration(125000)).toBe("2m5s");
  });

  it("formats hours and minutes for values >= 1h", () => {
    expect(formatDuration(3600000)).toBe("1h");
    expect(formatDuration(3720000)).toBe("1h2m");
    expect(formatDuration(7380000)).toBe("2h3m");
  });
});

describe("user bubble copy affordance", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function userMessage(text: string): Message {
    return { seq: 1, role: "user", text, ts: null };
  }

  it("renders the copy button as a footer after the bubble, not at its left edge", async () => {
    await act(async () => {
      root.render(
        <MessageRow message={userMessage("hello")} workspacePath="/ws" turnFinal />,
      );
    });
    // The user row's only button is the copy affordance (short text does not
    // trigger CollapsibleMessage's expand toggle). aria-label is localized,
    // so don't match on its value.
    const button = container.querySelector<HTMLButtonElement>("button");
    expect(button).not.toBeNull();
    expect(button!.getAttribute("aria-label")).toBeTruthy();
    const bubble = container.querySelector<HTMLDivElement>(".bg-bubble-user");
    expect(bubble).not.toBeNull();
    // Footer placement: the button follows the bubble in document order and
    // is not nested inside it (the old layout sat it in a left side-slot).
    expect(bubble!.compareDocumentPosition(button!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(bubble!.contains(button)).toBe(false);
  });

  it("keeps the button hover-revealed and keyboard-reachable", async () => {
    await act(async () => {
      root.render(
        <MessageRow message={userMessage("hello")} workspacePath="/ws" turnFinal />,
      );
    });
    const button = container.querySelector<HTMLButtonElement>("button")!;
    expect(button.className).toContain("group-hover:opacity-100");
    expect(button.className).toContain("focus-visible:opacity-100");
  });

  it("omits the button for a whitespace-only message", async () => {
    await act(async () => {
      root.render(
        <MessageRow message={userMessage("   ")} workspacePath="/ws" turnFinal />,
      );
    });
    expect(container.querySelector("button")).toBeNull();
  });

  /// The readout is the first thing that shows a huge prompt side (cache-heavy
  /// turns run into the millions), and it used to stop at "k": 1.5M tokens
  /// rendered as "1503.9k". It shares `formatTokens` now, so the unit rolls.
  it("rolls the per-message token readout past k into M", async () => {
    const heavy: Message = {
      seq: 2,
      role: "assistant",
      text: "done",
      ts: null,
      usage: { input: 1_503_900, output: 2_200 },
    };
    await act(async () => {
      root.render(<MessageRow message={heavy} workspacePath="/ws" turnFinal />);
    });
    const shown = container.textContent ?? "";
    expect(shown).toContain("↑1.5M");
    expect(shown).toContain("↓2.2k");
  });
});

describe("retry affordance on the bottom message", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("sits next to copy on the last user message and fires the handler", async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(
        <MessageRow
          message={{ seq: 1, role: "user", text: "hello", ts: null }}
          workspacePath="/ws"
          turnFinal
          onRetry={onRetry}
        />,
      );
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1].click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("sits next to copy on a final assistant segment and fires the handler", async () => {
    const onRetry = vi.fn();
    await act(async () => {
      root.render(
        <MessageRow
          message={{ seq: 2, role: "assistant", text: "done", ts: null }}
          workspacePath="/ws"
          turnFinal
          onRetry={onRetry}
        />,
      );
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[buttons.length - 1].click());
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it("stays off when the timeline does not mark the row as the last message", async () => {
    await act(async () => {
      root.render(
        <MessageRow
          message={{ seq: 1, role: "user", text: "older", ts: null }}
          workspacePath="/ws"
          turnFinal
        />,
      );
    });
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});

describe("branch targets and affordance", () => {
  it("maps replies to themselves and prompts to the reply before them", () => {
    const messages: Message[] = [
      { seq: 1, role: "user", text: "hi", ts: null, uuid: "u1" },
      { seq: 2, role: "assistant", text: "hello", ts: null, uuid: "a1" },
      { seq: 3, role: "user", text: "again", ts: null, uuid: "u2" },
      { seq: 4, role: "assistant", text: "done", ts: null, uuid: "a2" },
    ];
    const rows = buildRows(messages);
    const targets = branchTargets(rows);
    const bySeq = (seq: number) => {
      const row = rows.find(
        (r) => r.kind === "msg" && r.message.seq === seq,
      )!;
      return targets.get(rowKey(row));
    };
    expect(bySeq(1)).toBeUndefined();
    expect(bySeq(2)).toBe("a1");
    expect(bySeq(3)).toBe("a1");
    expect(bySeq(4)).toBe("a2");
  });

  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  it("renders a branch button next to copy and hands over the target uuid", async () => {
    const onBranch = vi.fn();
    await act(async () => {
      root.render(
        <MessageRow
          message={{ seq: 2, role: "assistant", text: "done", ts: null, uuid: "a1" }}
          workspacePath="/ws"
          turnFinal
          branchTarget="a1"
          onBranch={onBranch}
        />,
      );
    });
    const buttons = container.querySelectorAll<HTMLButtonElement>("button");
    expect(buttons).toHaveLength(2);
    await act(async () => buttons[1].click());
    expect(onBranch).toHaveBeenCalledWith("a1");
  });

  it("hides the branch button without a resolvable target", async () => {
    await act(async () => {
      root.render(
        <MessageRow
          message={{ seq: 1, role: "user", text: "hi", ts: null }}
          workspacePath="/ws"
          turnFinal
        />,
      );
    });
    expect(container.querySelectorAll("button")).toHaveLength(1);
  });
});

describe("CLI notice rows", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  function noticeMessage(level: string, text: string): Message {
    return { seq: 5, role: "notice", text, level, ts: null };
  }

  it("renders the CLI's line as a severity-tinted row, not a markdown bubble", async () => {
    await act(async () => {
      root.render(
        <MessageRow
          message={noticeMessage("warning", "[第二大脑] 指导意见：先核对测试覆盖")}
          workspacePath="/ws"
          turnFinal={false}
        />,
      );
    });
    const body = container.querySelector("span");
    expect(body).not.toBeNull();
    expect(container.textContent).toContain("[第二大脑] 指导意见：先核对测试覆盖");
    expect(body!.className).toContain("text-text-warning-primary");
  });

  it("tints errors red and takes no reply footer even when marked turn-final", async () => {
    await act(async () => {
      root.render(
        <MessageRow
          message={noticeMessage("error", "第二大脑调用失败：502")}
          workspacePath="/ws"
          turnFinal
        />,
      );
    });
    const body = container.querySelector("span");
    expect(body!.className).toContain("text-text-error-primary");
    // The reply footer (copy button / meta line) belongs to assistant
    // segments; a notice row must not grow one.
    expect(container.querySelector("button")).toBeNull();
  });

  it("keeps the reply footer on the assistant segment when a notice trails it", () => {
    const assistant: Message = { seq: 1, role: "assistant", text: "reply", ts: null };
    const rows = buildRows([assistant, noticeMessage("warning", "[第二大脑] 指导意见")]);
    const [first, second] = rows;
    expect(first?.kind).toBe("msg");
    expect(second?.kind).toBe("msg");
    if (first?.kind === "msg" && second?.kind === "msg") {
      expect(first.message).toBe(assistant);
      expect(first.turnFinal).toBe(true);
      expect(second.message.role).toBe("notice");
      expect(second.turnFinal).toBe(false);
    }
  });
});

