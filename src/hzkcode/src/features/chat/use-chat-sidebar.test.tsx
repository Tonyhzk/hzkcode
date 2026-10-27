import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import "@/lib/i18n";
import type { AiChatRepo } from "@/components/application/ai-chat/ai-chat-sidebar";
import { ipc, type SessionMeta, type Workspace } from "@/lib/ipc";
import { DEFAULT_WORKSPACE_ID } from "@/lib/default-workspace";
import { pickDirectory } from "@/lib/platform";
import { useChatStore } from "./store";
import { useChatSidebar } from "./use-chat-sidebar";

vi.mock("@/lib/ipc", () => ({
  ipc: {
    getAppSettings: vi.fn(async () => ({})),
    updateAppSettings: vi.fn(async () => {}),
    removeWorkspace: vi.fn(async () => {}),
    setWorkspaceGroup: vi.fn(async () => {}),
    reorderWorkspaces: vi.fn(async () => {}),
  },
}));
vi.mock("@/lib/events", () => ({
  listenEngineEvents: vi.fn(async () => () => {}),
  listenSessionsChanged: vi.fn(async () => () => {}),
}));
vi.mock("@/lib/platform", () => ({
  pickDirectory: vi.fn(async () => null),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const WS: Workspace = {
  id: "w1",
  path: "/ws/a",
  name: "a",
  sortOrder: 0,
  groupId: null,
} as Workspace;

const SESSION: SessionMeta = {
  engine: "codex",
  sessionId: "s-1",
  workspacePath: "/ws/a",
  filePath: "/local/s-1.jsonl",
  fileSize: 1,
  fileMtimeMs: 1,
  title: "local",
  preview: "",
  createdAt: null,
  updatedAt: 1,
  messageCount: 1,
  pinned: false,
  customTitle: null,
};

let container: HTMLDivElement;
let root: Root;
let captured: AiChatRepo[];
let sidebar: ReturnType<typeof useChatSidebar>;

const DEFAULT_WS: Workspace = {
  ...WS,
  id: DEFAULT_WORKSPACE_ID,
  path: "/home/test/hzkcode-default-workspace",
  name: "hzkcode-default-workspace",
  sortOrder: -1,
};

function Harness() {
  const result = useChatSidebar({
    sessionById: new Map(),
    threadStreaming: [false],
    collapseSidebarOnMobile: () => {},
    composerInputRef: { current: null },
    setDialog: () => {},
  });
  captured = result.repos;
  sidebar = result;
  return null;
}

describe("useChatSidebar repo mapping", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    useChatStore.setState({
      active: null,
      activeEngine: "claude",
      bySession: {},
      workspaces: [WS],
      sessions: [SESSION],
      openTabs: [],
      threadLimit: 7,
      workspaceGroups: [],
      workspaceAliases: {},
      archivedWorkspaces: [],
      unseen: {},
    });
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
      root.render(<Harness />);
    });
  });

  afterEach(async () => {
    await act(async () => {
      window.__hzkcodeWorkspaceUI?.registerHooks(null);
      root.unmount();
    });
    container.remove();
  });

  it("没有项目时直接在默认工作区新建，不弹目录选择", async () => {
    await act(async () => {
      useChatStore.setState({ workspaces: [DEFAULT_WS], sessions: [] });
    });
    await act(async () => sidebar.handleNewSession());
    expect(useChatStore.getState().active).toMatchObject({
      engine: "claude", sessionId: null, workspacePath: DEFAULT_WS.path,
    });
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it("默认分组置顶且不受归档、别名或用户分组影响", async () => {
    await act(async () => useChatStore.setState({
      workspaces: [WS, { ...DEFAULT_WS, groupId: "g1" }],
      sessions: [],
      archivedWorkspaces: [DEFAULT_WORKSPACE_ID],
      workspaceAliases: { [DEFAULT_WORKSPACE_ID]: "ignored" },
      workspaceGroups: [{ id: "g1", name: "group" }],
    }));
    expect(captured.map((repo) => repo.id)).toEqual([DEFAULT_WORKSPACE_ID, WS.id]);
    expect(captured[0]).toMatchObject({ fixed: true, threads: [] });
    expect(sidebar.archivedRepos).toEqual([]);
    expect(sidebar.sections?.flatMap((section) => section.repos.map((repo) => repo.id)))
      .toEqual([WS.id]);
  });

  it("新建保留当前项目选择，所有项目归档后使用默认目录", async () => {
    await act(async () => useChatStore.setState({
      workspaces: [DEFAULT_WS, WS],
      active: { engine: "claude", sessionId: null, workspacePath: WS.path },
    }));
    await act(async () => sidebar.handleNewSession());
    expect(useChatStore.getState().active?.workspacePath).toBe(WS.path);
    await act(async () => useChatStore.setState({ archivedWorkspaces: [WS.id] }));
    await act(async () => sidebar.handleNewSession());
    expect(useChatStore.getState().active?.workspacePath).toBe(DEFAULT_WS.path);
    expect(pickDirectory).not.toHaveBeenCalled();
  });

  it("默认分组的新建入口不受当前项目影响", async () => {
    await act(async () => useChatStore.setState({
      workspaces: [DEFAULT_WS, WS],
      active: { engine: "claude", sessionId: null, workspacePath: WS.path },
    }));
    await act(async () => sidebar.handleNewSessionInWorkspace(DEFAULT_WORKSPACE_ID));
    expect(useChatStore.getState().active?.workspacePath).toBe(DEFAULT_WS.path);
  });

  it("状态层拒绝删除、归档、改名和移动默认工作区", async () => {
    await act(async () => useChatStore.setState({ workspaces: [DEFAULT_WS] }));
    const state = useChatStore.getState();
    await state.removeWorkspace(DEFAULT_WORKSPACE_ID);
    await state.setWorkspaceArchived(DEFAULT_WORKSPACE_ID, true);
    await state.setWorkspaceAlias(DEFAULT_WORKSPACE_ID, "ignored");
    await state.assignWorkspaceGroup(DEFAULT_WORKSPACE_ID, "g1");
    expect(ipc.removeWorkspace).not.toHaveBeenCalled();
    expect(ipc.setWorkspaceGroup).not.toHaveBeenCalled();
    expect(ipc.updateAppSettings).not.toHaveBeenCalled();
    expect(useChatStore.getState().workspaces).toEqual([DEFAULT_WS]);
    expect(useChatStore.getState().archivedWorkspaces).toEqual([]);
  });

  it("重新排序其他项目时默认工作区仍然在首位", async () => {
    await act(async () => useChatStore.setState({ workspaces: [DEFAULT_WS, WS] }));
    await act(async () => useChatStore.getState().reorderWorkspaces([WS.id, DEFAULT_WORKSPACE_ID]));
    expect(useChatStore.getState().workspaces.map((workspace) => workspace.id))
      .toEqual([DEFAULT_WORKSPACE_ID, WS.id]);
  });

  it("threadLimit 透传到 repo(分页折叠依赖它,删了设置就失效)", () => {
    expect(captured).toHaveLength(1);
    expect(captured[0]?.threadLimit).toBe(7);
    expect(captured[0]?.threads.map((t) => t.id)).toEqual(["codex/s-1"]);
  });

  it("pending 新对话出现在对应工作区线程列表顶部", async () => {
    await act(async () => {
      useChatStore.setState({
        openTabs: [{ engine: "codex", sessionId: null, workspacePath: "/ws/a" }],
        active: { engine: "codex", sessionId: null, workspacePath: "/ws/a" },
      });
    });
    expect(captured[0]?.threads.map((thread) => thread.id)).toEqual([
      "new:codex:/ws/a",
      "codex/s-1",
    ]);
    expect(captured[0]?.threads[0]).toMatchObject({
      label: "新对话",
      isDraft: true,
      engine: "codex",
    });
  });

  it("插件桥 hooks 注册后徽标响应式出现(activate/热重载不等无关重渲染)", async () => {
    expect(captured[0]?.labelSuffix).toBeUndefined();
    await act(async () => {
      window.__hzkcodeWorkspaceUI?.registerHooks({
        allowedEngines: () => null,
        labelSuffix: (p) => (p === "/ws/a" ? "WSL" : null),
      });
    });
    expect(captured[0]?.labelSuffix).toBe("WSL");
  });
});
