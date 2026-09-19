/**
 * Host global hardening (plan §5.4). Same-origin ESM plugins share the window
 * with the host, so true isolation is impossible; this module is the
 * "raise the bar + observable behavior" layer the plan explicitly scopes to:
 *
 * - `window.__TAURI_INTERNALS__.invoke` is wrapped so a direct Tauri IPC call
 *   made while plugin code is on the stack (activate, event callbacks,
 *   disposers — everything the runtime invokes via `runAsPlugin`) throws.
 * - Network needs no wrapper: CSP `connect-src 'self' ipc: …` already denies
 *   every non-self connection from the webview, host and plugin alike.
 *
 * Documented residual bypass surface (unchanged from the plan): React event
 * handlers and async continuations escape the depth counter; same-origin
 * iframes expose fresh globals; localStorage is directly reachable. Hard
 * boundaries come from marketplace review, the permission diff, the confirm
 * flow, one-click uninstall, and quarantine.
 */

let pluginDepth = 0;

/** Run `fn` marked as plugin code: direct Tauri IPC inside throws. */
export function runAsPlugin<T>(fn: () => T): T {
  pluginDepth += 1;
  try {
    return fn();
  } finally {
    pluginDepth -= 1;
  }
}

interface TauriInternals {
  invoke?: (cmd: string, args?: unknown) => Promise<unknown>;
}
declare global {
  interface Window {
    __TAURI_INTERNALS__?: TauriInternals;
  }
}

let installed = false;

/** Wrap the Tauri IPC entry point with the plugin-execution guard. Idempotent;
 *  no-op outside the desktop webview (web bridge has no __TAURI_INTERNALS__). */
export function installHardening(): void {
  if (installed) return;
  installed = true;
  const internals = window.__TAURI_INTERNALS__;
  const original = internals?.invoke;
  if (!internals || !original) return;
  internals.invoke = (cmd, args) => {
    if (pluginDepth > 0) {
      return Promise.reject(
        new Error(
          `[plugins] direct Tauri invoke("${cmd}") is blocked inside plugin code; use the PluginContext APIs`,
        ),
      );
    }
    return original(cmd, args);
  };
}
