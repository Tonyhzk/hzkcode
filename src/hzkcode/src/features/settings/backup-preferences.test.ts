import { beforeEach, describe, expect, it, vi } from "vitest";
import { checkBackupStorage, collectBackupPreferences, restoreBackupPreferences } from "./backup-preferences";

beforeEach(() => localStorage.clear());

describe("配置备份偏好", () => {
  it("只导出可迁移偏好，不包含聊天、路径缓存和输入历史", () => {
    localStorage.setItem("hzkcode.zoom:v1", "120");
    localStorage.setItem("hzkcode.permissionPref:v2", "readonly");
    localStorage.setItem("hzkcode.promptHistory", '["private prompt"]');
    localStorage.setItem("hzkcode.activeSession:v1", "private-session");
    localStorage.setItem("hzkcode.filesRoot", "/private/project");
    localStorage.setItem("hzkcode.webWanRiskAccepted", "1");
    expect(collectBackupPreferences()).toEqual({
      "hzkcode.zoom:v1": "120",
      "hzkcode.permissionPref:v2": "readonly",
    });
  });

  it("恢复按白名单替换，缺省恢复默认，原会话与历史保持不动", () => {
    localStorage.setItem("hzkcode.zoom:v1", "150");
    localStorage.setItem("hzkcode.permissionPref", "bypass");
    localStorage.setItem("hzkcode.promptHistory", '["原历史"]');
    restoreBackupPreferences({ "hzkcode.promptHistoryEnabled": "0" });
    expect(localStorage.getItem("hzkcode.zoom:v1")).toBeNull();
    expect(localStorage.getItem("hzkcode.permissionPref")).toBeNull();
    expect(localStorage.getItem("hzkcode.promptHistoryEnabled")).toBe("0");
    expect(localStorage.getItem("hzkcode.promptHistory")).toBe('["原历史"]');
  });

  it("未知键和超限数据在修改本机偏好前拒绝", () => {
    localStorage.setItem("hzkcode.zoom:v1", "100");
    expect(() => restoreBackupPreferences({ "hzkcode.filesRoot": "/other" })).toThrow();
    expect(() => restoreBackupPreferences({ "hzkcode.openWorkspaceCustomApps": "中".repeat(400000) })).toThrow();
    expect(localStorage.getItem("hzkcode.zoom:v1")).toBe("100");
  });

  it("写入失败恢复原偏好", () => {
    localStorage.setItem("hzkcode.zoom:v1", "100");
    const original = Storage.prototype.setItem;
    const spy = vi.spyOn(Storage.prototype, "setItem").mockImplementationOnce(() => {
      throw new DOMException("quota", "QuotaExceededError");
    }).mockImplementation(original);
    try {
      expect(() => restoreBackupPreferences({ "hzkcode.zoom:v1": "130" })).toThrow();
      expect(localStorage.getItem("hzkcode.zoom:v1")).toBe("100");
    } finally {
      spy.mockRestore();
    }
  });

  it("存储探测不残留数据且保留同名原值", () => {
    checkBackupStorage();
    expect(localStorage.length).toBe(0);
    localStorage.setItem("hzkcode.backupStorageProbe", "existing");
    checkBackupStorage();
    expect(localStorage.getItem("hzkcode.backupStorageProbe")).toBe("existing");
  });
});
