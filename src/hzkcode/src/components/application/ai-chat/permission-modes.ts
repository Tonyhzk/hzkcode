/**
 * 权限模式的工作模式视图：边界加三个开关（自动审查、自动继续、自动接受修改）。
 * 映射与开关可用性逐条对齐 CLI 的 permissionModeSwitches，不得在此放宽边界或改算模式。
 */

export type ComposerPermission =
  | "default"
  | "acceptEdits"
  | "dontAsk"
  | "auto"
  | "autoContinue"
  | "readonlyAsk"
  | "readonly"
  | "readonlyAuto"
  | "readonlyAutoContinue"
  | "planOnlyAsk"
  | "planOnly"
  | "planOnlyAuto"
  | "planOnlyAutoContinue"
  | "plan"
  | "bypass";

/** 选择器可保存的全部模式；CLI 当前默认是 Auto Continue。 */
export const PERMISSION_MODES: readonly ComposerPermission[] = [
  "autoContinue",
  "default",
  "acceptEdits",
  "dontAsk",
  "auto",
  "readonlyAsk",
  "readonly",
  "readonlyAuto",
  "readonlyAutoContinue",
  "planOnlyAsk",
  "planOnly",
  "planOnlyAuto",
  "planOnlyAutoContinue",
  "plan",
  "bypass",
];

export const DEFAULT_PERMISSION: ComposerPermission = "autoContinue";

export function isComposerPermission(
  value: unknown,
): value is ComposerPermission {
  return (
    typeof value === "string" &&
    (PERMISSION_MODES as readonly string[]).includes(value)
  );
}

export type PermissionBoundary = "default" | "readonly" | "plan" | "bypass";
export type PermissionSwitchBoundary = Exclude<PermissionBoundary, "bypass">;
export type PermissionSwitchKey = "autoReview" | "autoContinue" | "acceptEdits";

export interface PermissionSwitches {
  autoReview: boolean;
  autoContinue: boolean;
  acceptEdits: boolean;
}

export interface PermissionSwitchProfiles {
  default: PermissionSwitches;
  readonly: PermissionSwitches;
  plan: PermissionSwitches;
}

export interface PermissionModeState {
  boundary: PermissionBoundary;
  switches: PermissionSwitches;
}

export type PermissionModeSwitchAvailability =
  | "available"
  | "included"
  | "disabled";

export const ALL_PERMISSION_MODE_SWITCHES_OFF: PermissionSwitches = {
  autoReview: false,
  autoContinue: false,
  acceptEdits: false,
};

/** 每个边界通过自身开关产生的模式。 */
export const BOUNDARY_MODES: Record<
  PermissionBoundary,
  readonly ComposerPermission[]
> = {
  default: ["default", "acceptEdits", "dontAsk", "auto", "autoContinue"],
  readonly: [
    "readonlyAsk",
    "readonly",
    "readonlyAuto",
    "readonlyAutoContinue",
  ],
  plan: ["planOnlyAsk", "planOnly", "planOnlyAuto", "planOnlyAutoContinue"],
  bypass: ["bypass"],
};

export const PERMISSION_BOUNDARY_LABEL_KEYS: Record<
  PermissionBoundary,
  string
> = {
  default: "permissionBoundaryDefault",
  readonly: "permissionBoundaryReadonly",
  plan: "permissionBoundaryPlan",
  bypass: "permissionBypass",
};

export const PERMISSION_SWITCH_LABEL_KEYS: Record<
  PermissionSwitchKey,
  string
> = {
  autoReview: "permissionSwitchAutoReview",
  autoContinue: "permissionSwitchAutoContinue",
  acceptEdits: "permissionSwitchAcceptEdits",
};

export function permissionModeFromState(
  state: PermissionModeState,
): ComposerPermission {
  const { boundary, switches } = state;
  if (boundary === "bypass") return "bypass";
  if (boundary === "readonly") {
    if (switches.autoReview) {
      return switches.autoContinue ? "readonlyAutoContinue" : "readonlyAuto";
    }
    return switches.autoContinue ? "readonly" : "readonlyAsk";
  }
  if (boundary === "plan") {
    if (switches.autoReview) {
      return switches.autoContinue ? "planOnlyAutoContinue" : "planOnlyAuto";
    }
    return switches.autoContinue ? "planOnly" : "planOnlyAsk";
  }
  if (switches.autoReview) {
    return switches.autoContinue ? "autoContinue" : "auto";
  }
  if (switches.autoContinue) return "dontAsk";
  return switches.acceptEdits ? "acceptEdits" : "default";
}

/** 某个边界保存的开关；bypass 没有开关，读取默认边界的一组。 */
export function getBoundarySwitches(
  profiles: PermissionSwitchProfiles | undefined,
  boundary: PermissionBoundary,
): PermissionSwitches {
  const key: PermissionSwitchBoundary =
    boundary === "bypass" ? "default" : boundary;
  return { ...(profiles?.[key] ?? ALL_PERMISSION_MODE_SWITCHES_OFF) };
}

/** 模式 → 边界与开关；旧 plan 模式不在这个视图内。 */
export function permissionModeStateFromMode(
  mode: ComposerPermission,
  profiles?: PermissionSwitchProfiles,
): PermissionModeState | null {
  switch (mode) {
    case "default":
      return {
        boundary: "default",
        switches: { ...ALL_PERMISSION_MODE_SWITCHES_OFF },
      };
    case "acceptEdits":
      return {
        boundary: "default",
        switches: {
          autoReview: false,
          autoContinue: false,
          acceptEdits: true,
        },
      };
    case "dontAsk":
      return {
        boundary: "default",
        switches: {
          autoReview: false,
          autoContinue: true,
          acceptEdits: getBoundarySwitches(profiles, "default").acceptEdits,
        },
      };
    case "auto":
    case "autoContinue":
      return {
        boundary: "default",
        switches: {
          autoReview: true,
          autoContinue: mode === "autoContinue",
          acceptEdits: getBoundarySwitches(profiles, "default").acceptEdits,
        },
      };
    case "readonlyAsk":
    case "readonly":
    case "readonlyAuto":
    case "readonlyAutoContinue":
      return {
        boundary: "readonly",
        switches: {
          ...getBoundarySwitches(profiles, "readonly"),
          autoReview:
            mode === "readonlyAuto" || mode === "readonlyAutoContinue",
          autoContinue:
            mode === "readonly" || mode === "readonlyAutoContinue",
        },
      };
    case "planOnlyAsk":
    case "planOnly":
    case "planOnlyAuto":
    case "planOnlyAutoContinue":
      return {
        boundary: "plan",
        switches: {
          ...getBoundarySwitches(profiles, "plan"),
          autoReview:
            mode === "planOnlyAuto" || mode === "planOnlyAutoContinue",
          autoContinue:
            mode === "planOnly" || mode === "planOnlyAutoContinue",
        },
      };
    case "bypass":
      return {
        boundary: "bypass",
        switches: getBoundarySwitches(profiles, "bypass"),
      };
    default:
      return null;
  }
}

/** 同上；旧 plan 模式回退到默认边界。 */
export function resolvePermissionModeState(
  mode: ComposerPermission,
  profiles?: PermissionSwitchProfiles,
): PermissionModeState {
  return (
    permissionModeStateFromMode(mode, profiles) ?? {
      boundary: "default",
      switches: getBoundarySwitches(profiles, "default"),
    }
  );
}

/** 新会话的三套开关：启动模式所在边界取自身开关，其余边界跟随它
 *  （自动接受修改只留在默认边界）。 */
export function createInitialSwitchProfiles(
  startupMode: ComposerPermission,
): PermissionSwitchProfiles {
  const state = permissionModeStateFromMode(startupMode);
  const base =
    state && state.boundary !== "bypass"
      ? state.switches
      : ALL_PERMISSION_MODE_SWITCHES_OFF;
  const pick = (boundary: PermissionSwitchBoundary): PermissionSwitches => {
    if (state?.boundary === boundary) return { ...state.switches };
    return boundary === "default"
      ? { ...base }
      : { ...base, acceptEdits: false };
  };
  return {
    default: pick("default"),
    readonly: pick("readonly"),
    plan: pick("plan"),
  };
}

function switchesEqual(
  a: PermissionSwitches,
  b: PermissionSwitches,
): boolean {
  return (
    a.autoReview === b.autoReview &&
    a.autoContinue === b.autoContinue &&
    a.acceptEdits === b.acceptEdits
  );
}

function recordModeInSwitchProfiles(
  mode: ComposerPermission,
  profiles: PermissionSwitchProfiles,
): PermissionSwitchProfiles {
  const state = permissionModeStateFromMode(mode, profiles);
  if (!state || state.boundary === "bypass") return profiles;
  if (switchesEqual(profiles[state.boundary], state.switches)) return profiles;
  return { ...profiles, [state.boundary]: state.switches };
}

/** 当前三套开关：先按 mode 初始化，再记录该模式表达的开关。 */
export function resolveSwitchProfiles(
  mode: ComposerPermission,
  profiles: PermissionSwitchProfiles | undefined,
): PermissionSwitchProfiles {
  return recordModeInSwitchProfiles(
    mode,
    profiles ?? createInitialSwitchProfiles(mode),
  );
}

/** 切换边界时载入目标边界自己保存的开关。 */
export function getPermissionModeForBoundary(
  currentMode: ComposerPermission,
  profiles: PermissionSwitchProfiles | undefined,
  boundary: PermissionBoundary,
): ComposerPermission {
  if (boundary === "bypass") return "bypass";
  const resolved = resolveSwitchProfiles(currentMode, profiles);
  return permissionModeFromState({
    boundary,
    switches: getBoundarySwitches(resolved, boundary),
  });
}

/** 暂选模式时把来源与目标边界分别记入开关配置。 */
export function nextModeSwitchMemory(
  fromMode: ComposerPermission,
  toMode: ComposerPermission,
  profiles: PermissionSwitchProfiles | undefined,
): PermissionSwitchProfiles {
  return recordModeInSwitchProfiles(
    toMode,
    resolveSwitchProfiles(fromMode, profiles),
  );
}

export function getPermissionModeSwitchAvailability(
  state: PermissionModeState,
  key: PermissionSwitchKey,
): PermissionModeSwitchAvailability {
  const { boundary, switches } = state;
  if (boundary === "bypass") return "disabled";
  switch (key) {
    case "autoReview":
      return "available";
    case "autoContinue":
      return "available";
    case "acceptEdits":
      if (boundary !== "default") return "disabled";
      if (switches.autoReview) return "included";
      return switches.autoContinue ? "disabled" : "available";
  }
}

export function togglePermissionModeSwitch(
  state: PermissionModeState,
  key: PermissionSwitchKey,
): PermissionModeState {
  if (getPermissionModeSwitchAvailability(state, key) !== "available") {
    return state;
  }
  return {
    ...state,
    switches: { ...state.switches, [key]: !state.switches[key] },
  };
}

/**
 * 选择器的三边界开关记忆。CLI 按会话为每个边界保存一套开关；选择器在模块作用域
 * 做同样的事，默认 → 只读 → 默认切换时能恢复各自那一套。
 */
let switchMemory: PermissionSwitchProfiles | undefined;

export function getPermissionSwitchMemory():
  | PermissionSwitchProfiles
  | undefined {
  return switchMemory;
}

export function rememberPermissionSwitchMemory(
  profiles: PermissionSwitchProfiles,
): void {
  switchMemory = profiles;
}

/** 触发按钮的文案片段：先边界，再放下方决定其余行为的开关。
 *  自动审查已包含自动接受修改时省略后者。 */
export function permissionModeLabelKeys(
  mode: ComposerPermission,
): string[] {
  if (mode === "plan") return ["permissionLegacyPlan"];
  const state = resolvePermissionModeState(mode);
  const keys = [PERMISSION_BOUNDARY_LABEL_KEYS[state.boundary]];
  if (state.boundary === "bypass") return keys;
  if (state.switches.autoReview) {
    keys.push(PERMISSION_SWITCH_LABEL_KEYS.autoReview);
  } else if (state.switches.acceptEdits && state.boundary === "default") {
    keys.push(PERMISSION_SWITCH_LABEL_KEYS.acceptEdits);
  }
  if (state.switches.autoContinue) {
    keys.push(PERMISSION_SWITCH_LABEL_KEYS.autoContinue);
  }
  return keys;
}
