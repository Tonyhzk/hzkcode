import { beforeEach, describe, expect, it } from "vitest";
import { usePendingIdentityStore } from "./pending-identity";

const IDENTITY = {
  value: "reviewer",
  name: "审查",
  group: "external" as const,
  source: "userSettings",
};

beforeEach(() => {
  usePendingIdentityStore.setState({ request: null });
});

describe("usePendingIdentityStore", () => {
  it("keeps one pending request per selected identity", () => {
    usePendingIdentityStore.getState().requestIdentity("claude/s-1", IDENTITY);
    expect(usePendingIdentityStore.getState().request).toEqual({
      key: "claude/s-1",
      identity: IDENTITY,
    });
  });

  it("only clears the matching session's request", () => {
    usePendingIdentityStore.getState().requestIdentity("claude/s-1", IDENTITY);
    usePendingIdentityStore.getState().clear("claude/s-2");
    expect(usePendingIdentityStore.getState().request).not.toBeNull();
    usePendingIdentityStore.getState().clear("claude/s-1");
    expect(usePendingIdentityStore.getState().request).toBeNull();
  });
});
