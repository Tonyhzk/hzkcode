"use client";

import { memo, useEffect, useMemo, type MutableRefObject } from "react";
import { useTranslation } from "react-i18next";
import Bot from "lucide-react/dist/esm/icons/bot";
import Plus from "lucide-react/dist/esm/icons/plus";
import UserRound from "lucide-react/dist/esm/icons/user-round";
import {
  ComposerPickerMenu,
  PickerOption,
  type ComposerPickerMenuHandle,
} from "@/components/application/ai-chat/composer-picker-menu";
import { useAgentStore } from "@/features/agents/agent-store";
import { sessionKey, useChatStore } from "@/features/chat/store";
import {
  EMPTY_SESSION_CONTROL_CATALOG,
  identityGroupLabelKey,
  sessionIdentityOptions,
  type IdentityGroup,
  type SessionIdentityOption,
} from "@/features/chat/session-control-view";

/**
 * `#` identity picker, rendered above the composer while a `#` trigger is
 * active. Rows are the default (no identity), the engine catalog's switchable
 * built-in / external identities, the app's bundled roles (stable catalog
 * ids), and the GUI's own agent personas. Selecting
 * a row opens the shared session-control dialog (apply in place, clone, or
 * append) instead of pinning a prompt for the next send. A fixed "new agent"
 * footer row jumps to the settings page. Thin shell over ComposerPickerMenu —
 * the contentEditable keeps focus and owns the keyboard; keys arrive through
 * menuRef.
 */

/** Imperative key handling for the composer's keydown handler. */
export type AgentMenuHandle = ComposerPickerMenuHandle;

/** Sentinel key of the fixed footer row that opens the settings page. */
export const CREATE_NEW_AGENT_ID = "__create_new__";

/** What a picked row means: apply an identity, or open the agent editor. */
export type AgentMenuSelection =
  | { kind: "identity"; identity: SessionIdentityOption }
  | { kind: "create" };

interface AgentMenuEntry {
  key: string;
  kind: AgentMenuSelection["kind"];
  identity?: SessionIdentityOption;
  group?: IdentityGroup;
  name: string;
}

/** Section header between groups; keyboard navigation skips it (headers
 *  are not options — row indices stay contiguous). Same chrome as the `/`
 *  picker's kind headers. */
const GROUP_HEADER =
  "px-2 pb-1 pt-1.5 text-caption-1-medium text-text-tertiary select-none";

function matches(option: SessionIdentityOption, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    option.name.toLowerCase().includes(q) ||
    (option.description ?? "").toLowerCase().includes(q) ||
    (option.agent?.prompt ?? "").toLowerCase().includes(q)
  );
}

const Row = memo(function Row({
  entry,
  index,
  active,
  onSelect,
  onHover,
}: {
  entry: AgentMenuEntry;
  index: number;
  active: boolean;
  onSelect: (entry: AgentMenuEntry) => void;
  onHover: (index: number) => void;
}) {
  if (entry.kind === "create") {
    return (
      <PickerOption active={active} onSelect={() => onSelect(entry)} onHover={() => onHover(index)}>
        <Plus aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
        <span className="shrink-0 text-body-regular text-text-primary">{entry.name}</span>
      </PickerOption>
    );
  }
  const option = entry.identity!;
  const summary = (option.description ?? option.agent?.prompt)
    ?.replace(/\s+/g, " ")
    .trim();
  return (
    <PickerOption active={active} onSelect={() => onSelect(entry)} onHover={() => onHover(index)}>
      {option.group === "default" ? (
        <UserRound aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
      ) : option.icon ? (
        <span aria-hidden className="w-4 shrink-0 text-center text-body-regular">
          {option.icon}
        </span>
      ) : (
        <Bot aria-hidden className="size-4 shrink-0 text-foreground-icon-secondary" />
      )}
      <span className="shrink-0 text-body-regular text-text-primary">{option.name}</span>
      {summary && (
        <span className="truncate text-body-regular text-text-tertiary" title={summary}>
          {summary}
        </span>
      )}
    </PickerOption>
  );
});

export function AgentMenu({
  query,
  /** Horizontal offset (px) of the `#` caret inside the composer wrapper. */
  left,
  onSelect,
  onClose,
  menuRef,
}: {
  query: string;
  left: number;
  onSelect: (selection: AgentMenuSelection) => void;
  onClose: () => void;
  menuRef?: MutableRefObject<AgentMenuHandle | null>;
}) {
  const { t } = useTranslation();
  const agents = useAgentStore((s) => s.agents);
  const builtInAgents = useAgentStore((s) => s.builtInAgents);
  const loaded = useAgentStore((s) => s.loaded);
  const sessionControl = useChatStore((s) => {
    const active = s.active;
    if (!active) return null;
    const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
    return s.bySession[key]?.sessionControl ?? null;
  });
  useEffect(() => {
    void useAgentStore.getState().refresh();
    // 身份目录来自引擎；打开 # 菜单时补读一次，保证内置/外置身份可选。
    void useChatStore.getState().refreshSessionControl();
  }, []);

  const { items, groups, hasMatches } = useMemo(() => {
    const catalog = sessionControl?.catalog ?? EMPTY_SESSION_CONTROL_CATALOG;
    const options = sessionIdentityOptions({
      catalog,
      agents,
      builtInAgents,
      defaultName: t("chat.sessionIdentityDefault"),
    });
    const filtering = query.trim().length > 0;
    const matched = options.filter((option) => matches(option, query));
    const items: AgentMenuEntry[] = matched.map((identity) => ({
      key: identity.value ?? "__default_identity__",
      kind: "identity",
      identity,
      group: identity.group,
      name: identity.name,
    }));
    items.push({
      key: CREATE_NEW_AGENT_ID,
      kind: "create",
      name: t("chat.agentCreate"),
    });
    const groups = matched.map((identity) =>
      filtering ? null : t(identityGroupLabelKey(identity.group)),
    );
    groups.push(null);
    return { items, groups, hasMatches: matched.length > 0 };
  }, [sessionControl, agents, builtInAgents, query, t]);

  return (
    <ComposerPickerMenu
      left={left}
      width="w-[420px]"
      ariaLabel={t("chat.agents")}
      scope={query}
      loading={!loaded && agents.length === 0 && sessionControl === null}
      loadingText={t("chat.agentsLoading")}
      emptyText={t("chat.agentsEmpty")}
      items={items}
      rowKey={(entry) => entry.key}
      onSelect={(entry) =>
        onSelect(
          entry.kind === "create"
            ? { kind: "create" }
            : { kind: "identity", identity: entry.identity! },
        )
      }
      onClose={onClose}
      menuRef={menuRef}
      groupHeaderAt={(_entry, i) => {
        if (!hasMatches) {
          return i === 0 ? (
            <div className={GROUP_HEADER}>{t("chat.agentsEmpty")}</div>
          ) : null;
        }
        const group = groups[i];
        return group && (i === 0 || groups[i - 1] !== group) ? (
          <div className={GROUP_HEADER}>{group}</div>
        ) : null;
      }}
      renderRow={(entry, i, active, { onHover }) => (
        <Row
          entry={entry}
          index={i}
          active={active}
          onSelect={(picked) =>
            onSelect(
              picked.kind === "create"
                ? { kind: "create" }
                : { kind: "identity", identity: picked.identity! },
            )
          }
          onHover={onHover}
        />
      )}
    />
  );
}
