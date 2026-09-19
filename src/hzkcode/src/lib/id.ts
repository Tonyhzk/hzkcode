/** crypto.randomUUID needs a secure context; the LAN web bridge serves plain
 *  HTTP, where it doesn't exist — fall back to a random id there. */
export function newId(): string {
  return (
    globalThis.crypto?.randomUUID?.() ??
    `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
  );
}
