import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ipc, type CommitInfo } from "@/lib/ipc";
import i18n from "@/lib/i18n";
import { useGitStore } from "./store";
import { HistoryPanel } from "./HistoryPanel";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    gitLog: vi.fn(),
    gitCommitFiles: vi.fn(),
  },
}));

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const commit = (n: number): CommitInfo => ({
  hash: `hash-${String(n).padStart(3, "0")}`.padEnd(40, "0"),
  shortHash: `hash-${String(n).padStart(3, "0")}`,
  summary: `commit ${n}`,
  author: "tester",
  time: 1_700_000_000 + n,
});

const findButton = (container: HTMLElement, text: string) =>
  [...container.querySelectorAll("button")].find((b) => b.textContent === text);

describe("HistoryPanel", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.clearAllMocks();
    useGitStore.setState({ diffView: null, historyRevisionByWorkspace: {} });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  const render = (workspacePath: string) =>
    act(async () => {
      root.render(<HistoryPanel workspacePath={workspacePath} />);
    });

  it("loads the first page for the workspace", async () => {
    vi.mocked(ipc.gitLog).mockResolvedValue([commit(2), commit(1)]);
    await render("/ws");

    expect(ipc.gitLog).toHaveBeenCalledWith("/ws", 50, 0);
    expect(container.querySelectorAll("li").length).toBe(2);
  });

  it("pages with the loaded count as the offset", async () => {
    const page = Array.from({ length: 50 }, (_, i) => commit(50 - i));
    vi.mocked(ipc.gitLog)
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce([commit(0)]);
    await render("/ws");

    const more = findButton(container, i18n.t("git.loadMore"));
    expect(more).toBeTruthy();
    await act(async () => {
      more!.click();
    });

    expect(ipc.gitLog).toHaveBeenLastCalledWith("/ws", 50, 50);
    expect(container.querySelectorAll("li").length).toBe(51);
  });

  it("fetches a commit's files on expand and opens a commit diff on file click", async () => {
    vi.mocked(ipc.gitLog).mockResolvedValue([commit(1)]);
    vi.mocked(ipc.gitCommitFiles).mockResolvedValue([
      { path: "a.txt", status: "modified", additions: 1, deletions: 1 },
    ]);
    await render("/ws");

    const row = container.querySelector<HTMLButtonElement>("li > button")!;
    await act(async () => {
      row.click();
    });
    expect(ipc.gitCommitFiles).toHaveBeenCalledWith("/ws", commit(1).hash);

    const fileButton = [...container.querySelectorAll("button")].find((b) =>
      b.textContent?.includes("a.txt"),
    );
    expect(fileButton).toBeTruthy();
    await act(async () => {
      fileButton!.click();
    });
    expect(useGitStore.getState().diffView).toEqual({
      workspacePath: "/ws",
      target: { file: "a.txt", staged: false, commit: commit(1).hash },
    });
  });

  it("re-reads the first page when the store's history revision moves", async () => {
    vi.mocked(ipc.gitLog).mockResolvedValue([commit(1)]);
    await render("/ws");
    expect(ipc.gitLog).toHaveBeenCalledTimes(1);

    await act(async () => {
      useGitStore.setState({ historyRevisionByWorkspace: { "/ws": 1 } });
    });
    expect(ipc.gitLog).toHaveBeenCalledTimes(2);
    expect(ipc.gitLog).toHaveBeenLastCalledWith("/ws", 50, 0);
  });

  it("renders no commit rows when the workspace is not a repository", async () => {
    vi.mocked(ipc.gitLog).mockRejectedValue("NOT_A_REPO");
    await render("/ws");
    expect(container.querySelectorAll("li").length).toBe(0);
  });
});
