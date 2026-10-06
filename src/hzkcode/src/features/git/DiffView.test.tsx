import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc } from "@/lib/ipc";
import { DiffView } from "./DiffView";

vi.mock("@/lib/ipc", () => ({
  ipc: { gitDiff: vi.fn(), gitCommitFileDiff: vi.fn() },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("DiffView diff sources", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (target: { file: string; staged: boolean; commit?: string }) =>
    act(async () => {
      root.render(
        <DiffView
          workspacePath="/ws"
          target={target}
          status={undefined}
          onBack={() => {}}
        />,
      );
    });

  it("reads a commit diff when the target carries a commit", async () => {
    vi.mocked(ipc.gitCommitFileDiff).mockResolvedValue("@@ -1 +1 @@\n-old\n+new\n");
    await render({ file: "a.txt", staged: false, commit: "abc1234" });

    expect(ipc.gitCommitFileDiff).toHaveBeenCalledWith("/ws", "abc1234", "a.txt");
    expect(ipc.gitDiff).not.toHaveBeenCalled();
  });

  it("reads a working-tree diff without a commit", async () => {
    vi.mocked(ipc.gitDiff).mockResolvedValue("@@ -1 +1 @@\n-old\n+new\n");
    await render({ file: "a.txt", staged: true });

    expect(ipc.gitDiff).toHaveBeenCalledWith("/ws", "a.txt", true);
    expect(ipc.gitCommitFileDiff).not.toHaveBeenCalled();
  });
});
