/**
 * Legacy display helper: older sessions carried the selected agent as a
 * `## Agent Role and Instructions` tail block on the user message (the
 * transcript kept it, the bubble strips it back out and shows a badge).
 * Agent selection now rides the launch flags (`--agents` / `--agent`), so
 * only the strip side remains, for reading old histories.
 */
const AGENT_BLOCK_TAIL_REGEX =
  /(?:\r?\n\r?\n|^)##\s*Agent Role and Instructions\s*(?:\r?\n)+([\s\S]*)$/;
const AGENT_NAME_LINE_REGEX = /^Agent Name:[ \t]*(.+)$/m;
const AGENT_ICON_LINE_REGEX = /^Agent Icon:[ \t]*(.*)$/m;

export interface StrippedAgentBlock {
  /** Message text with the agent block removed (trimmed of trailing space). */
  text: string;
  agentName?: string;
  agentIcon?: string;
}

export function stripAgentBlock(text: string): StrippedAgentBlock {
  const match = AGENT_BLOCK_TAIL_REGEX.exec(text);
  if (!match || match.index < 0) return { text };
  const block = match[1] ?? "";
  const name = AGENT_NAME_LINE_REGEX.exec(block)?.[1]?.trim();
  const icon = AGENT_ICON_LINE_REGEX.exec(block)?.[1]?.trim();
  return {
    // A message that opens with the block and has nothing before it
    // displays an empty body; the badge still carries the agent identity.
    text: text.slice(0, match.index).replace(/\s+$/, ""),
    agentName: name || undefined,
    agentIcon: icon || undefined,
  };
}
