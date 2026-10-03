import type { EngineInfo } from "@/lib/ipc";
import { writeStored } from "@/lib/storage";
import type { ComposerPermission } from "@/components/application/ai-chat/permission-menu";
import { LEGACY_PERMISSION_PREF_KEY, PERMISSION_PREF_KEY } from "./persistence";

/** The CLI's machine values; "bypass" is this client's shorthand for the
 *  skip-permissions launch flag. */
const PERMISSION_MODES: readonly ComposerPermission[] = [
  "autoContinue",
  "default",
  "acceptEdits",
  "plan",
  "readonly",
  "readonlyAsk",
  "auto",
  "bypass",
];

/** Auto Ask — the built-in CLI's default mode. */
const DEFAULT_PERMISSION: ComposerPermission = "auto";

/** The pre-alignment four-mode ids: only "manual" needs renaming — "auto"
 *  keeps its id (and is now the real Auto Ask), "plan" / "bypass" carry
 *  over as-is. */
const LEGACY_MODE_MAP: Record<string, ComposerPermission> = {
  manual: "default",
};

/** Persisted composer permission, migrating the four-mode key on first read. */
export function readPermissionPref(): ComposerPermission {
  const current = localStorage.getItem(PERMISSION_PREF_KEY);
  if (current && PERMISSION_MODES.includes(current as ComposerPermission)) {
    return current as ComposerPermission;
  }
  const legacy = localStorage.getItem(LEGACY_PERMISSION_PREF_KEY);
  const migrated = legacy
    ? (LEGACY_MODE_MAP[legacy] ??
      (PERMISSION_MODES.includes(legacy as ComposerPermission)
        ? (legacy as ComposerPermission)
        : undefined))
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
