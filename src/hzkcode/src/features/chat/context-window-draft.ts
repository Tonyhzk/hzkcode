/** Parse a context-window input draft the way the CLI's /maxtokens does:
 *  a positive integer, or null when empty or invalid (zero is not a window
 *  and 跟随默认 is the 恢复默认 button's job, not an empty draft's). */
export function parseContextWindowDraft(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^[1-9]\d*$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return Number.isSafeInteger(value) ? value : null;
}
