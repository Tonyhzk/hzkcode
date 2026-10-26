export const BACKUP_PREFERENCE_KEYS = [
  "hzkcode.permissionPref:v2",
  "hzkcode.promptHistoryEnabled",
  "hzkcode.usageTracking:v1",
  "hzkcode.zoom:v1",
  "hzkcode.terminalHeight",
  "hzkcode.panelCollapsed",
  "hzkcode.panelWidthMigrated",
  "hzkcode.sidebarCollapsed",
  "hzkcode.editorCollapsed",
  "hzkcode.panelWidth",
  "hzkcode.sidebarWidth",
  "hzkcode.editorWidth",
  "hzkcode.chat.runStatusChromeOpen",
  "hzkcode.headerPinnedActions",
  "hzkcode.openWorkspaceApp",
  "hzkcode.openWorkspaceCustomApps",
] as const;

const MAX_VALUE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 4 * MAX_VALUE_BYTES;

export function collectBackupPreferences(storage: Storage = localStorage): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of BACKUP_PREFERENCE_KEYS) {
    const value = storage.getItem(key);
    if (value !== null) values[key] = value;
  }
  validateBackupPreferences(values);
  return values;
}

function validateBackupPreferences(values: Record<string, string>) {
  let total = 0;
  for (const [key, value] of Object.entries(values)) {
    if (!(BACKUP_PREFERENCE_KEYS as readonly string[]).includes(key) || typeof value !== "string") {
      throw new Error("backup_invalid");
    }
    const size = new TextEncoder().encode(value).byteLength;
    total += size;
    if (size > MAX_VALUE_BYTES || total > MAX_TOTAL_BYTES) throw new Error("backup_too_large");
  }
}

export function checkBackupStorage(storage: Storage = localStorage) {
  const key = "hzkcode.backupStorageProbe";
  const previous = storage.getItem(key);
  storage.setItem(key, "1");
  if (previous === null) storage.removeItem(key);
  else storage.setItem(key, previous);
}

export function restoreBackupPreferences(values: Record<string, string>, storage: Storage = localStorage) {
  validateBackupPreferences(values);
  const previous = collectBackupPreferences(storage);
  // 失败时恢复原偏好；会话与项目缓存不属于导入范围。
  const replace = (next: Record<string, string>) => {
    for (const key of BACKUP_PREFERENCE_KEYS) storage.removeItem(key);
    for (const [key, value] of Object.entries(next)) storage.setItem(key, value);
  };
  try {
    replace(values);
    storage.removeItem("hzkcode.permissionPref");
  } catch (error) {
    replace(previous);
    throw error;
  }
}
