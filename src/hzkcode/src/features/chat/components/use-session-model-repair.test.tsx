import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../store";
import type { ActiveSession } from "../store/persistence";
import { useSessionModelRepair } from "./use-session-model-repair";

vi.mock("@/lib/ipc", () => ({ ipc: {} }));

const actEnvironment = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
actEnvironment.IS_REACT_ACT_ENVIRONMENT = true;

const WS = "/ws";
const SID = "s-1";
const READY: Record<string, true> = { claude: true };
const SERVED: Record<string, Set<string>> = {
  claude: new Set(["sonnet", "opus", "haiku", "claude-opus-5-5"]),
};

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  localStorage.clear();
  useChatStore.setState({ openTabs: [], active: null, activeEngine: "claude" });
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

function Harness({
  active,
  sessionIds = SERVED,
  ready = READY,
  repair,
}: {
  active: ActiveSession | null;
  sessionIds?: Record<string, Set<string>>;
  ready?: Record<string, true>;
  repair: (
    engine: string,
    sessionId: string | null,
    workspacePath: string,
    staleStamp: string,
  ) => void;
}) {
  useSessionModelRepair({
    active,
    activeEngine: "claude",
    sessionIds,
    ready,
    repair,
  });
  return null;
}

const tab = (model?: string): ActiveSession => ({
  engine: "claude",
  sessionId: SID,
  workspacePath: WS,
  model,
});

describe("useSessionModelRepair", () => {
  it("清掉渠道不再提供的分区选择", async () => {
    const repair = vi.fn();
    await act(async () =>
      root.render(<Harness active={tab("hzk-model")} repair={repair} />),
    );
    expect(repair).toHaveBeenCalledWith("claude", SID, WS, "hzk-model");
  });

  it("保留渠道仍提供的明确选择", async () => {
    const repair = vi.fn();
    await act(async () =>
      root.render(<Harness active={tab("claude-opus-5-5")} repair={repair} />),
    );
    expect(repair).not.toHaveBeenCalled();
  });

  it("渠道未就绪（配置或目录未返回）时不做判定", async () => {
    const repair = vi.fn();
    await act(async () =>
      root.render(
        <Harness active={tab("hzk-model")} ready={{}} repair={repair} />,
      ),
    );
    expect(repair).not.toHaveBeenCalled();
  });

  it("没有分区选择时不动作", async () => {
    const repair = vi.fn();
    await act(async () => root.render(<Harness active={tab()} repair={repair} />));
    expect(repair).not.toHaveBeenCalled();
  });

  it("当前标签是别的引擎时不动作", async () => {
    const repair = vi.fn();
    const other = { engine: "omp", sessionId: SID, workspacePath: WS, model: "hzk-model" };
    await act(async () => root.render(<Harness active={other} repair={repair} />));
    expect(repair).not.toHaveBeenCalled();
  });
});

describe("repairSessionModel store action", () => {
  it("清掉标签上失效的模型覆盖（活动标签与已开标签同步）", () => {
    const stale = tab("hzk-model");
    useChatStore.setState({ openTabs: [stale], active: stale });
    act(() => {
      useChatStore.getState().repairSessionModel("claude", SID, WS, "hzk-model");
    });
    expect(useChatStore.getState().active?.model).toBeUndefined();
    expect(useChatStore.getState().openTabs[0]?.model).toBeUndefined();
  });

  it("与 staleStamp 不匹配的覆盖保持不变", () => {
    const other = tab("claude-opus-5-5");
    useChatStore.setState({ openTabs: [other], active: other });
    act(() => {
      useChatStore.getState().repairSessionModel("claude", SID, WS, "hzk-model");
    });
    expect(useChatStore.getState().active?.model).toBe("claude-opus-5-5");
    expect(useChatStore.getState().openTabs[0]?.model).toBe("claude-opus-5-5");
  });

  it("待发草稿的失效覆盖同样清理", () => {
    const draft: ActiveSession = {
      engine: "claude",
      sessionId: null,
      workspacePath: WS,
      model: "hzk-model",
    };
    useChatStore.setState({ openTabs: [draft], active: draft });
    act(() => {
      useChatStore
        .getState()
        .repairSessionModel("claude", null, WS, "hzk-model");
    });
    expect(useChatStore.getState().active?.model).toBeUndefined();
  });
});
