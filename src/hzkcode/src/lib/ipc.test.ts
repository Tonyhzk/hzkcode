import { beforeEach, describe, expect, it, vi } from "vitest";

/** The transport is the only backend edge this module has. */
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("./transport", () => ({
  invoke: (...args: unknown[]) => invoke(...args),
  listen: vi.fn(async () => () => {}),
  isWeb: false,
  webToken: null,
  serverVersion: async () => null,
}));

/** Only the fields under test; the rest of the shape is irrelevant here. */
const settings = (over: Record<string, unknown>) =>
  ({ theme: "system", ...over }) as never;

/** Fresh module per case: the cache is module state. */
let ipc: (typeof import("./ipc"))["ipc"];
beforeEach(async () => {
  invoke.mockReset();
  vi.resetModules();
  ({ ipc } = await import("./ipc"));
});

describe("配置备份接口", () => {
  it("导出和预览传递指定文件与密码", async () => {
    const preferences = { "hzkcode.zoom:v1": "120" };
    invoke.mockResolvedValueOnce({ path: "/tmp/config.hzkbackup" });
    await ipc.configBackupExport("/tmp/config.hzkbackup", "test-password", preferences);
    expect(invoke).toHaveBeenCalledWith("config_backup_export", {
      path: "/tmp/config.hzkbackup", password: "test-password", preferences,
    });
    await ipc.configBackupPreview("/tmp/config.hzkbackup", "test-password");
    expect(invoke).toHaveBeenLastCalledWith("config_backup_preview", {
      path: "/tmp/config.hzkbackup", password: "test-password",
    });
  });

  it("确认恢复使用预览令牌，并使旧设置缓存失效", async () => {
    invoke.mockResolvedValueOnce(settings({ theme: "dark" }));
    await ipc.getAppSettings();
    invoke.mockResolvedValueOnce({ backupPath: "/tmp/b.hzkbackup", preferences: {}, warnings: [] });
    await ipc.configBackupImport("preview-token", {});
    expect(invoke).toHaveBeenLastCalledWith("config_backup_import", {
      token: "preview-token", currentPreferences: {},
    });
    invoke.mockResolvedValueOnce(settings({ theme: "light" }));
    await expect(ipc.getAppSettings()).resolves.toMatchObject({ theme: "light" });
  });

  it("导入失败不丢弃原设置缓存", async () => {
    invoke.mockResolvedValueOnce(settings({ theme: "dark" }));
    await ipc.getAppSettings();
    invoke.mockRejectedValueOnce("backup_stale");
    await expect(ipc.configBackupImport("old-token", {})).rejects.toBe("backup_stale");
    await expect(ipc.getAppSettings()).resolves.toMatchObject({ theme: "dark" });
    expect(invoke).toHaveBeenCalledTimes(2);
  });
});

describe("app settings cache", () => {
  it("serves repeat reads from a single backend call", async () => {
    invoke.mockResolvedValue(settings({ theme: "dark" }));
    await ipc.getAppSettings();
    await ipc.getAppSettings();
    expect(invoke).toHaveBeenCalledTimes(1);
  });

  it("re-reads settings the backend rotated on its own", async () => {
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "AAAA2222" }));
    await ipc.getAppSettings();
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "BBBB3333" }));
    await expect(ipc.refreshAppSettings()).resolves.toMatchObject({
      webAuthKey: "BBBB3333",
    });
    // The fresh copy is what later reads — and later writes — see.
    await expect(ipc.getAppSettings()).resolves.toMatchObject({
      webAuthKey: "BBBB3333",
    });
    expect(invoke).toHaveBeenCalledTimes(2);
  });

  it("re-reads after a write instead of trusting what was sent", async () => {
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "OLDKEY22" }));
    const before = await ipc.getAppSettings();
    // A write answers with nothing (the command's contract); the next read
    // must hit the backend, never carry the written object.
    invoke.mockResolvedValueOnce(undefined);
    await ipc.updateAppSettings({ ...before, webAuthKey: null } as never);
    invoke.mockResolvedValueOnce(settings({ webAuthKey: "NEWKEY33" }));
    await expect(ipc.getAppSettings()).resolves.toMatchObject({
      webAuthKey: "NEWKEY33",
    });
    expect(invoke.mock.calls.map((call) => call[0])).toEqual([
      "get_app_settings",
      "update_app_settings",
      "get_app_settings",
    ]);
  });
});
