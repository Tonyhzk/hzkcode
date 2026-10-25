import type { EngineInfo } from "@/lib/ipc";
import { writeStored } from "@/lib/storage";
import {
  DEFAULT_PERMISSION,
  isComposerPermission,
  type ComposerPermission,
} from "@/components/application/ai-chat/permission-modes";
import { LEGACY_PERMISSION_PREF_KEY, PERMISSION_PREF_KEY } from "./persistence";

/** The pre-alignment four-mode ids: only "manual" needs renaming — "auto"
 *  keeps its id (and is now the real Auto Ask), "plan" / "bypass" carry
 *  over as-is. */
const LEGACY_MODE_MAP: Record<string, ComposerPermission> = {
  manual: "default",
};

/** 持久化的权限偏好，首次读取时迁移四模式旧键。合法旧值原样保留；
 *  只有未知值才回退到 CLI 当前默认值（Auto Continue）。 */
export function readPermissionPref(): ComposerPermission {
  const current = localStorage.getItem(PERMISSION_PREF_KEY);
  if (isComposerPermission(current)) return current;
  const legacy = localStorage.getItem(LEGACY_PERMISSION_PREF_KEY);
  const migrated = legacy
    ? (LEGACY_MODE_MAP[legacy] ??
      (isComposerPermission(legacy) ? legacy : undefined))
    : undefined;
  const value = migrated ?? DEFAULT_PERMISSION;
  writeStored(PERMISSION_PREF_KEY, value);
  if (legacy) localStorage.removeItem(LEGACY_PERMISSION_PREF_KEY);
  return value;
}

/** The mode actually sent for an engine: the user's pick when the engine
 * honors it, else the engine's first supported mode (same fallback the
 * Rust side applies). */
export function effectivePermission(
  engines: EngineInfo[],
  engine: string,
  selected: ComposerPermission,
): ComposerPermission {
  const supported = engines.find((e) => e.id === engine)?.permissions;
  if (!supported || supported.length === 0) return selected;
  return supported.includes(selected)
    ? selected
    : (supported[0] as ComposerPermission);
}
