import { sessionKey, useChatStore } from "../store";
import { QuestionCard } from "./QuestionCard";
import { PermissionCard } from "./PermissionCard";

/**
 * The active session's pending AskUserQuestion, or null. The dock takes over
 * the composer while a question is pending, so both the footer (to hide the
 * composer) and the dock itself resolve it through this hook.
 */
export function usePendingQuestion() {
  const active = useChatStore((s) => s.active);
  return useChatStore((s) => {
    if (!active) return null;
    const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
    const messages = s.bySession[key]?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "question" && m.question?.status === "pending") return m;
    }
    return null;
  });
}

/**
 * The active session's pending tool-permission ask, or null. Same dock
 * treatment as a question: the CLI is parked until it is answered.
 */
export function usePendingPermission() {
  const active = useChatStore((s) => s.active);
  return useChatStore((s) => {
    if (!active) return null;
    const key = sessionKey(active.engine, active.sessionId, active.workspacePath);
    const messages = s.bySession[key]?.messages ?? [];
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "permission" && m.permission?.status === "pending") return m;
    }
    return null;
  });
}

/**
 * Interaction panel that replaces the composer area while the CLI waits on
 * the control protocol (an AskUserQuestion or a tool-permission ask): it
 * covers the input box instead of pushing chat content around, and the only
 * exits are answering, the free-form input, or ignore.
 */
export function QuestionDock() {
  const question = usePendingQuestion();
  const permission = usePendingPermission();
  if (!question && !permission) return null;
  return (
    <div className="mx-auto w-full max-w-3xl">
      <div className="rounded-xl border border-border-secondary bg-background-secondary-default px-3.5 py-3 shadow-lg">
        {question ? (
          <QuestionCard message={question} />
        ) : permission ? (
          <PermissionCard message={permission} />
        ) : null}
      </div>
    </div>
  );
}
