import { describe, expect, it } from "vitest";
import { isUsableProxyUrl, isUsableSessionProxyUrl } from "./proxy-url";

describe("isUsableProxyUrl (app system proxy — mirrors proxy.rs)", () => {
  it("accepts http(s) and socks5 addresses with a host", () => {
    expect(isUsableProxyUrl("http://127.0.0.1:7890")).toBe(true);
    expect(isUsableProxyUrl("https://proxy.example:8443")).toBe(true);
    expect(isUsableProxyUrl("socks5://127.0.0.1:1080")).toBe(true);
    expect(isUsableProxyUrl("socks5h://127.0.0.1:1080")).toBe(true);
  });

  it("rejects missing, blank and scheme-less values", () => {
    expect(isUsableProxyUrl(null)).toBe(false);
    expect(isUsableProxyUrl("")).toBe(false);
    expect(isUsableProxyUrl("   ")).toBe(false);
    expect(isUsableProxyUrl("127.0.0.1:7890")).toBe(false);
  });

  it("rejects unsupported schemes and hosts", () => {
    expect(isUsableProxyUrl("ftp://proxy.example:21")).toBe(false);
    expect(isUsableProxyUrl("http://")).toBe(false);
  });
});

describe("isUsableSessionProxyUrl (CLI session proxy — mirrors normalizeProxyUrl)", () => {
  it("accepts http(s) addresses with a host", () => {
    expect(isUsableSessionProxyUrl("http://127.0.0.1:7897")).toBe(true);
    expect(isUsableSessionProxyUrl("https://proxy.example:8443")).toBe(true);
    expect(isUsableSessionProxyUrl("http://user:pass@127.0.0.1:7897")).toBe(true);
  });

  it("accepts scheme-less host:port as http, matching the CLI", () => {
    expect(isUsableSessionProxyUrl("127.0.0.1:7897")).toBe(true);
    expect(isUsableSessionProxyUrl(" localhost:7897 ")).toBe(true);
  });

  it("rejects socks5 — the CLI session proxy only takes http(s)", () => {
    expect(isUsableSessionProxyUrl("socks5://127.0.0.1:10808")).toBe(false);
    expect(isUsableSessionProxyUrl("socks5h://127.0.0.1:10808")).toBe(false);
  });

  it("rejects missing, blank, host-less and unsupported values", () => {
    expect(isUsableSessionProxyUrl(null)).toBe(false);
    expect(isUsableSessionProxyUrl("")).toBe(false);
    expect(isUsableSessionProxyUrl("   ")).toBe(false);
    expect(isUsableSessionProxyUrl("ftp://proxy.example:21")).toBe(false);
    expect(isUsableSessionProxyUrl("http://")).toBe(false);
  });
});
