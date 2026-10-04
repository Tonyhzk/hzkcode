/** URL validity for the two composer proxy controls, each mirroring its own
 *  backend contract — the app-level system proxy and the CLI session proxy
 *  accept different schemes, so they must not share one check. */

/**
 * Mirrors `validate_proxy_settings` in src-tauri/src/proxy.rs: enabling the
 * proxy requires a configured URL with an http(s)/socks5 scheme and a host.
 * Disabling never fails validation, so an enabled toggle stays operable even
 * if the stored URL is later broken.
 */
export function isUsableProxyUrl(value: string | null): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return false;
  }
  const scheme = parsed.protocol.replace(":", "");
  return (
    ["http", "https", "socks5", "socks5h"].includes(scheme) &&
    parsed.hostname.length > 0
  );
}

/**
 * Mirrors the CLI's `normalizeProxyUrl` (`utils/sessionProxy.ts`): the session
 * proxy address the CLI consumes (`HZKCODE_PROXY_URL`) takes http(s) only,
 * and a scheme-less "host:port" is read as http. Anything this rejects would
 * leave the CLI on a direct connection with only a debug log, so the session
 * switch must not offer "on" for it.
 */
export function isUsableSessionProxyUrl(value: string | null): boolean {
  const trimmed = value?.trim() ?? "";
  if (!trimmed) return false;
  const candidate = trimmed.includes("://") ? trimmed : `http://${trimmed}`;
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}
