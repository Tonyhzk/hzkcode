import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  export: vi.fn(), preview: vi.fn(), import: vi.fn(), restart: vi.fn(),
  pickFile: vi.fn(), pickSavePath: vi.fn(),
  platform: { isWeb: false }, context: { kind: "main" },
  dirtyPaths: {} as Record<string, true>,
  streamingByKey: {} as Record<string, true>,
  controlBusyByKey: {} as Record<string, true>,
  bySession: {} as Record<string, { queue: unknown[] }>,
}));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock("@/lib/ipc", () => ({ ipc: {
  configBackupExport: mocks.export, configBackupPreview: mocks.preview,
  configBackupImport: mocks.import, restartApp: mocks.restart,
} }));
vi.mock("@/lib/platform", () => ({
  get isWeb() { return mocks.platform.isWeb; },
  pickFile: mocks.pickFile, pickSavePath: mocks.pickSavePath,
}));
vi.mock("@/lib/window-context", () => ({ windowContext: mocks.context }));
vi.mock("@/features/files/store", () => ({ useFilesStore: { getState: () => ({ dirtyPaths: mocks.dirtyPaths }) } }));
vi.mock("@/features/chat/store", () => ({ useChatStore: { getState: () => ({
  streamingByKey: mocks.streamingByKey, controlBusyByKey: mocks.controlBusyByKey, bySession: mocks.bySession,
}) } }));

import { useConfigBackup } from "./useConfigBackup";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
const preview = { token: "one-use-token", warnings: [], providerCount: 1, agentCount: 1,
  promptCount: 1, preferenceCount: 1, appVersion: "3.5.1-1", platform: "macos", exportedAt: "2026-10-27" };
let flow: ReturnType<typeof useConfigBackup>;
function Probe() { flow = useConfigBackup(); return null; }
let root: Root;
let container: HTMLDivElement;

beforeEach(async () => {
  vi.clearAllMocks();
  localStorage.clear();
  mocks.platform.isWeb = false;
  mocks.context.kind = "main";
  mocks.dirtyPaths = {};
  mocks.streamingByKey = {};
  mocks.controlBusyByKey = {};
  mocks.bySession = {};
  mocks.pickFile.mockResolvedValue("/tmp/source.hzkbackup");
  mocks.pickSavePath.mockResolvedValue("/tmp/export.hzkbackup");
  mocks.preview.mockResolvedValue(preview);
  mocks.export.mockResolvedValue({ path: "/tmp/export.hzkbackup" });
  mocks.import.mockResolvedValue({ backupPath: "/tmp/original.hzkbackup", preferences: { "hzkcode.zoom:v1": "120" }, warnings: [] });
  mocks.restart.mockResolvedValue(undefined);
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  await act(async () => root.render(<Probe />));
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function prepare(mode: "export" | "import") {
  act(() => flow.open(mode));
  act(() => { flow.setPassword("fixture-password"); flow.setConfirmation("fixture-password"); });
  if (mode === "import") await act(async () => { await flow.chooseFile(); });
}

describe("配置备份流程", () => {
  it("导出只传可迁移偏好，完成后清空密码", async () => {
    localStorage.setItem("hzkcode.zoom:v1", "110");
    localStorage.setItem("hzkcode.promptHistory", "private");
    await prepare("export");
    await act(async () => { await flow.submit(); });
    expect(mocks.export).toHaveBeenCalledWith("/tmp/export.hzkbackup", "fixture-password", { "hzkcode.zoom:v1": "110" });
    expect(flow.mode).toBeNull();
    expect(flow.password).toBe("");
    expect(flow.exportedPath).toBe("/tmp/export.hzkbackup");
  });

  it("两次密码不一致不打开保存窗口", async () => {
    await prepare("export");
    act(() => flow.setConfirmation("different"));
    await act(async () => { await flow.submit(); });
    expect(mocks.pickSavePath).not.toHaveBeenCalled();
    expect(mocks.export).not.toHaveBeenCalled();
  });

  it("取消保存对话框不写入，也不误报成功", async () => {
    mocks.pickSavePath.mockResolvedValueOnce(null);
    await prepare("export");
    await act(async () => { await flow.submit(); });
    expect(mocks.export).not.toHaveBeenCalled();
    expect(flow.mode).toBe("export");
    expect(flow.exportedPath).toBeNull();
  });

  it("保存窗口打开期间页面卸载，不继续导出", async () => {
    let resolve!: (value: string) => void;
    mocks.pickSavePath.mockReturnValueOnce(new Promise<string>((done) => { resolve = done; }));
    await prepare("export");
    let pending!: Promise<void>;
    act(() => { pending = flow.submit(); });
    act(() => root.render(null));
    await act(async () => { resolve("/tmp/late.hzkbackup"); await pending; });
    expect(mocks.export).not.toHaveBeenCalled();
  });

  it("解密预览不导入，取消清空密码与预览", async () => {
    await prepare("import");
    await act(async () => { await flow.submit(); });
    expect(mocks.preview).toHaveBeenCalledWith("/tmp/source.hzkbackup", "fixture-password");
    expect(flow.preview?.token).toBe(preview.token);
    expect(flow.password).toBe("");
    expect(mocks.import).not.toHaveBeenCalled();
    act(() => flow.close());
    expect(flow.preview).toBeNull();
    expect(flow.mode).toBeNull();
  });

  it("错误密码保留导入表单，不写入与重启", async () => {
    mocks.preview.mockRejectedValueOnce("backup_decrypt_failed");
    await prepare("import");
    await act(async () => { await flow.submit(); });
    expect(flow.preview).toBeNull();
    expect(flow.error).not.toBeNull();
    expect(mocks.import).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it.each(["dirty", "streaming", "control", "queue"])("%s 状态拒绝导入", async (state) => {
    await prepare("import");
    await act(async () => { await flow.submit(); });
    if (state === "dirty") mocks.dirtyPaths = { "/file": true };
    if (state === "streaming") mocks.streamingByKey = { session: true };
    if (state === "control") mocks.controlBusyByKey = { session: true };
    if (state === "queue") mocks.bySession = { session: { queue: [{}] } };
    await act(async () => { await flow.confirmImport(); });
    expect(mocks.import).not.toHaveBeenCalled();
    expect(mocks.restart).not.toHaveBeenCalled();
    expect(flow.preview?.token).toBe(preview.token);
  });

  it("导入失败保留本机偏好和预览以供重新操作", async () => {
    localStorage.setItem("hzkcode.zoom:v1", "90");
    mocks.import.mockRejectedValueOnce("backup_stale");
    await prepare("import");
    await act(async () => { await flow.submit(); });
    await act(async () => { await flow.confirmImport(); });
    expect(localStorage.getItem("hzkcode.zoom:v1")).toBe("90");
    expect(flow.result).toBeNull();
    expect(mocks.restart).not.toHaveBeenCalled();
  });

  it("确认使用预览令牌，先恢复偏好再重启；连续确认只导入一次", async () => {
    localStorage.setItem("hzkcode.zoom:v1", "90");
    mocks.restart.mockImplementationOnce(async () => {
      expect(localStorage.getItem("hzkcode.zoom:v1")).toBe("120");
    });
    await prepare("import");
    await act(async () => { await flow.submit(); });
    await act(async () => { await Promise.all([flow.confirmImport(), flow.confirmImport()]); });
    expect(mocks.import).toHaveBeenCalledTimes(1);
    expect(mocks.import).toHaveBeenCalledWith(preview.token, { "hzkcode.zoom:v1": "90" });
    expect(mocks.restart).toHaveBeenCalledTimes(1);
    expect(flow.result?.backupPath).toBe("/tmp/original.hzkbackup");
    act(() => flow.close());
    expect(flow.mode).toBe("import");
  });

  it("重启失败只重试重启，不重复恢复文件", async () => {
    mocks.restart.mockRejectedValueOnce(new Error("restart failed"));
    await prepare("import");
    await act(async () => { await flow.submit(); });
    await act(async () => { await flow.confirmImport(); });
    expect(flow.result).not.toBeNull();
    expect(flow.error).not.toBeNull();
    await act(async () => { await flow.restart(); });
    expect(mocks.import).toHaveBeenCalledTimes(1);
    expect(mocks.restart).toHaveBeenCalledTimes(2);
  });

  it("网页模式与独立窗口不发起备份命令", async () => {
    mocks.platform.isWeb = true;
    await act(async () => root.render(<Probe />));
    act(() => flow.open("export"));
    expect(flow.mode).toBeNull();
    mocks.platform.isWeb = false;
    mocks.context.kind = "editor";
    await act(async () => root.render(<Probe />));
    act(() => flow.open("import"));
    expect(flow.mode).toBeNull();
    expect(mocks.export).not.toHaveBeenCalled();
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
