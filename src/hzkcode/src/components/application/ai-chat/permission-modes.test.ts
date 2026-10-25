import { describe, expect, it } from "vitest";
import {
  ALL_PERMISSION_MODE_SWITCHES_OFF,
  DEFAULT_PERMISSION,
  PERMISSION_MODES,
  createInitialSwitchProfiles,
  getPermissionModeForBoundary,
  getPermissionModeSwitchAvailability,
  isComposerPermission,
  nextModeSwitchMemory,
  permissionModeFromState,
  permissionModeLabelKeys,
  permissionModeStateFromMode,
  resolvePermissionModeState,
  resolveSwitchProfiles,
  togglePermissionModeSwitch,
  type ComposerPermission,
} from "./permission-modes";

const WORK_MODES: ComposerPermission[] = [
  "default",
  "acceptEdits",
  "dontAsk",
  "auto",
  "autoContinue",
  "readonlyAsk",
  "readonly",
  "readonlyAuto",
  "readonlyAutoContinue",
  "planOnlyAsk",
  "planOnly",
  "planOnlyAuto",
  "planOnlyAutoContinue",
];

describe("permission mode mapping", () => {
  it("offers every work mode plus legacy plan and bypass", () => {
    expect([...PERMISSION_MODES].sort()).toEqual(
      [...WORK_MODES, "plan", "bypass"].sort(),
    );
    expect(DEFAULT_PERMISSION).toBe("autoContinue");
    expect(isComposerPermission("planOnlyAutoContinue")).toBe(true);
    expect(isComposerPermission("unknown")).toBe(false);
    expect(isComposerPermission(null)).toBe(false);
  });

  it("maps modes to the exact boundary and switches from the CLI", () => {
    expect(permissionModeStateFromMode("default")).toEqual({
      boundary: "default",
      switches: { ...ALL_PERMISSION_MODE_SWITCHES_OFF },
    });
    expect(permissionModeStateFromMode("acceptEdits")).toEqual({
      boundary: "default",
      switches: {
        autoReview: false,
        autoContinue: false,
        acceptEdits: true,
      },
    });
    expect(permissionModeStateFromMode("dontAsk")).toEqual({
      boundary: "default",
      switches: {
        autoReview: false,
        autoContinue: true,
        acceptEdits: false,
      },
    });
    expect(permissionModeStateFromMode("auto")).toEqual({
      boundary: "default",
      switches: {
        autoReview: true,
        autoContinue: false,
        acceptEdits: false,
      },
    });
    expect(permissionModeStateFromMode("autoContinue")).toEqual({
      boundary: "default",
      switches: {
        autoReview: true,
        autoContinue: true,
        acceptEdits: false,
      },
    });

    expect(permissionModeStateFromMode("readonlyAsk")).toEqual({
      boundary: "readonly",
      switches: { ...ALL_PERMISSION_MODE_SWITCHES_OFF },
    });
    expect(permissionModeStateFromMode("readonly")).toEqual({
      boundary: "readonly",
      switches: {
        autoReview: false,
        autoContinue: true,
        acceptEdits: false,
      },
    });
    expect(permissionModeStateFromMode("readonlyAuto")).toEqual({
      boundary: "readonly",
      switches: {
        autoReview: true,
        autoContinue: false,
        acceptEdits: false,
      },
    });
    expect(permissionModeStateFromMode("readonlyAutoContinue")).toEqual({
      boundary: "readonly",
      switches: {
        autoReview: true,
        autoContinue: true,
        acceptEdits: false,
      },
    });

    expect(permissionModeStateFromMode("planOnlyAsk")).toEqual({
      boundary: "plan",
      switches: { ...ALL_PERMISSION_MODE_SWITCHES_OFF },
    });
    expect(permissionModeStateFromMode("planOnly")).toEqual({
      boundary: "plan",
      switches: {
        autoReview: false,
        autoContinue: true,
        acceptEdits: false,
      },
    });
    expect(permissionModeStateFromMode("planOnlyAuto")).toEqual({
      boundary: "plan",
      switches: {
        autoReview: true,
        autoContinue: false,
        acceptEdits: false,
      },
    });
    expect(permissionModeStateFromMode("planOnlyAutoContinue")).toEqual({
      boundary: "plan",
      switches: {
        autoReview: true,
        autoContinue: true,
        acceptEdits: false,
      },
    });

    expect(permissionModeStateFromMode("bypass")?.boundary).toBe("bypass");
    expect(permissionModeStateFromMode("plan")).toBeNull();
  });

  it("round-trips every non-legacy work mode through its state", () => {
    for (const mode of WORK_MODES) {
      const state = permissionModeStateFromMode(mode)!;
      expect(permissionModeFromState(state)).toBe(mode);
    }
    expect(permissionModeFromState(permissionModeStateFromMode("bypass")!)).toBe(
      "bypass",
    );
  });
});

describe("permission switches", () => {
  it("makes accept edits unavailable outside the default boundary", () => {
    for (const mode of [
      "readonlyAsk",
      "readonly",
      "readonlyAuto",
      "readonlyAutoContinue",
      "planOnlyAsk",
      "planOnly",
      "planOnlyAuto",
      "planOnlyAutoContinue",
      "bypass",
    ] as const) {
      const state = resolvePermissionModeState(mode);
      expect(getPermissionModeSwitchAvailability(state, "acceptEdits")).toBe(
        "disabled",
      );
      expect(getPermissionModeSwitchAvailability(state, "autoReview")).toBe(
        mode === "bypass" ? "disabled" : "available",
      );
    }
  });

  it("includes accept edits once auto review is on", () => {
    const state = resolvePermissionModeState("auto");
    expect(getPermissionModeSwitchAvailability(state, "acceptEdits")).toBe(
      "included",
    );
    expect(togglePermissionModeSwitch(state, "acceptEdits")).toBe(state);
  });

  it("disables accept edits when only auto continue is on", () => {
    const state = resolvePermissionModeState("dontAsk");
    expect(getPermissionModeSwitchAvailability(state, "acceptEdits")).toBe(
      "disabled",
    );
    expect(togglePermissionModeSwitch(state, "acceptEdits")).toBe(state);
  });

  it("toggles an available switch into the matching mode", () => {
    const accept = resolvePermissionModeState("default");
    const reviewed = togglePermissionModeSwitch(accept, "autoReview");
    expect(reviewed.switches.autoReview).toBe(true);
    expect(permissionModeFromState(reviewed)).toBe("auto");

    const readonly = resolvePermissionModeState("readonlyAsk");
    const readonlyAutoContinue = togglePermissionModeSwitch(
      readonly,
      "autoContinue",
    );
    expect(permissionModeFromState(readonlyAutoContinue)).toBe("readonly");
  });
});

describe("boundary switch memory", () => {
  it("initializes other boundaries from the startup switches", () => {
    const profiles = createInitialSwitchProfiles("autoContinue");
    expect(profiles.default).toEqual({
      autoReview: true,
      autoContinue: true,
      acceptEdits: false,
    });
    expect(profiles.readonly).toEqual({
      autoReview: true,
      autoContinue: true,
      acceptEdits: false,
    });
    expect(profiles.plan).toEqual({
      autoReview: true,
      autoContinue: true,
      acceptEdits: false,
    });
  });

  it("records each boundary independently and loads it back on switch", () => {
    const initial = resolveSwitchProfiles("default", undefined);
    const withReadonly = nextModeSwitchMemory(
      "default",
      "readonlyAutoContinue",
      initial,
    );
    expect(withReadonly.default.acceptEdits).toBe(false);
    expect(withReadonly.readonly).toEqual({
      autoReview: true,
      autoContinue: true,
      acceptEdits: false,
    });
    expect(
      getPermissionModeForBoundary(
        "readonlyAutoContinue",
        withReadonly,
        "default",
      ),
    ).toBe("default");
    expect(
      getPermissionModeForBoundary(
        "readonlyAutoContinue",
        withReadonly,
        "readonly",
      ),
    ).toBe("readonlyAutoContinue");
    expect(
      getPermissionModeForBoundary("default", withReadonly, "plan"),
    ).toBe("planOnlyAsk");
  });

  it("keeps accept edits memory when auto review takes over", () => {
    const withAccept = nextModeSwitchMemory("default", "acceptEdits", undefined);
    const acceptState = resolvePermissionModeState("acceptEdits", withAccept);
    const autoState = togglePermissionModeSwitch(acceptState, "autoReview");
    const auto = permissionModeFromState(autoState);
    expect(auto).toBe("auto");
    const memory = nextModeSwitchMemory("acceptEdits", auto, withAccept);
    expect(permissionModeStateFromMode("auto", memory)?.switches.acceptEdits).toBe(
      true,
    );
  });

  it("falls back to the default boundary for the legacy plan mode", () => {
    expect(resolvePermissionModeState("plan").boundary).toBe("default");
    expect(
      getPermissionModeForBoundary("plan", undefined, "readonly"),
    ).toBe("readonlyAsk");
  });
});

describe("trigger label parts", () => {
  it("composes the boundary with the switches that decide the rest", () => {
    expect(permissionModeLabelKeys("default")).toEqual([
      "permissionBoundaryDefault",
    ]);
    expect(permissionModeLabelKeys("acceptEdits")).toEqual([
      "permissionBoundaryDefault",
      "permissionSwitchAcceptEdits",
    ]);
    expect(permissionModeLabelKeys("autoContinue")).toEqual([
      "permissionBoundaryDefault",
      "permissionSwitchAutoReview",
      "permissionSwitchAutoContinue",
    ]);
    expect(permissionModeLabelKeys("readonly")).toEqual([
      "permissionBoundaryReadonly",
      "permissionSwitchAutoContinue",
    ]);
    expect(permissionModeLabelKeys("planOnlyAsk")).toEqual([
      "permissionBoundaryPlan",
    ]);
    expect(permissionModeLabelKeys("bypass")).toEqual(["permissionBypass"]);
    expect(permissionModeLabelKeys("plan")).toEqual(["permissionLegacyPlan"]);
  });
});
