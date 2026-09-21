import { describe, expect, it } from "vitest";
import { parseWindowContext } from "./window-context";

describe("parseWindowContext", () => {
  it("parses a chat window context with decoded paths", () => {
    expect(
      parseWindowContext(
        "?ctx=chat&engine=claude&sessionId=s1&workspacePath=%2Ftmp%2Fmy%20ws",
      ),
    ).toEqual({
      kind: "chat",
      engine: "claude",
      sessionId: "s1",
      workspacePath: "/tmp/my ws",
    });
  });

  it("parses an editor window context", () => {
    expect(parseWindowContext("?ctx=editor&filePath=%2Ftmp%2Fa.ts")).toEqual({
      kind: "editor",
      filePath: "/tmp/a.ts",
    });
  });

  it("falls back to the main window for missing or unknown params", () => {
    expect(parseWindowContext("")).toEqual({ kind: "main" });
    expect(parseWindowContext("?ctx=chat&engine=claude&sessionId=s1")).toEqual({
      kind: "main",
    });
    expect(parseWindowContext("?ctx=editor")).toEqual({ kind: "main" });
    expect(parseWindowContext("?ctx=other&filePath=%2Ftmp%2Fa.ts")).toEqual({
      kind: "main",
    });
  });
});
