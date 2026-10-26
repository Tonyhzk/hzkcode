import { useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import i18n from "i18next";
import { ComposerToolbar } from "../../src/components/application/ai-chat/composer-toolbar";
import { StatusBar } from "../../src/components/application/ai-chat/ai-chat-composer";
import { PermissionMenu, type ComposerPermission } from "../../src/components/application/ai-chat/permission-menu";
import { CliMenu } from "../../src/components/application/ai-chat/cli-menu";
import { useChatStore } from "../../src/features/chat/store";
import { EMPTY_SESSION } from "../../src/features/chat/store/stream";
import { useAgentStore } from "../../src/features/agents/agent-store";
import type { SessionControlResult } from "../../src/lib/ipc";
import "../../src/index.css";
import "../../src/lib/i18n";

const active = { engine: "claude", sessionId: "responsive-fixture", workspacePath: "/fixture" };
const control: SessionControlResult = {
  type: "result", operation: "status", schemaVersion: 1,
  sourceSessionId: active.sessionId, targetSessionId: active.sessionId, session_id: active.sessionId,
  cloned: false, is_error: false, subtype: "success", error_code: null, revision: "fixture",
  state: {
    hasConversation: false,
    availableApplyMethods: { identity: ["current"], promptMode: ["current"] },
    identity: { base: null, extensions: [] },
    promptMode: { effective: "full", override: null, source: "startup" },
    interactionMode: { effective: "default", override: null, source: "startup" },
    apiMode: { effective: "chat_completions", override: null, source: "startup" },
    model: { effective: "high", override: null, source: "startup" },
    effort: { effective: null, override: null, source: "startup" },
    permission: { effective: "autoContinue", override: null, source: "startup" },
  },
  catalog: { identities: [], interactionModes: [] },
};
useAgentStore.setState({ loaded: true, agents: [], builtInAgents: [] });
useChatStore.setState({
  active, openTabs: [active],
  bySession: { [`claude/${active.sessionId}`]: { ...EMPTY_SESSION, sessionControl: control } },
  refreshSessionControl: async () => control,
});

const model = "deepseek-v4.1-flash-with-a-long-channel-model-name";
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
const settle = async () => { await frame(); await frame(); await frame(); };

function measure() {
  const toolbar = document.querySelector<HTMLElement>('[data-testid="composer-toolbar"]')!;
  const workMode = document.querySelector<HTMLElement>('[data-testid="composer-work-mode"]')!;
  const send = toolbar.lastElementChild as HTMLElement;
  const status = document.querySelector<HTMLElement>('[data-testid="composer-status-bar"]')!;
  const controls = status.querySelector<HTMLElement>('[data-testid="session-control-strip"]')!;
  const bounds = toolbar.getBoundingClientRect();
  const modeBounds = workMode.getBoundingClientRect();
  const sendBounds = send.getBoundingClientRect();
  const entries = [...controls.querySelectorAll<HTMLElement>("[data-session-control]")];
  const controlsBounds = controls.getBoundingClientRect();
  const visibleButtons = [...toolbar.querySelectorAll<HTMLElement>("button")].filter((button) => button.getBoundingClientRect().width > 0);
  const checks = {
    sendInside: sendBounds.right <= bounds.right + 1 && sendBounds.left >= bounds.left,
    sendFixedSize: Math.abs(sendBounds.width - 36) < 1,
    modeAdjacent: Math.abs(sendBounds.left - modeBounds.right - 8) < 1,
    toolbarContained: toolbar.scrollWidth <= toolbar.clientWidth + 1,
    statusContained: status.scrollWidth <= status.clientWidth + 1,
    noButtonOverlap: visibleButtons.every((button, index) => index === 0 || visibleButtons[index - 1].getBoundingClientRect().right <= button.getBoundingClientRect().left + 1),
    entriesContained: entries.every((entry) => entry.getBoundingClientRect().left >= controlsBounds.left - 1 && entry.getBoundingClientRect().right <= controlsBounds.right + 1),
    compactRightAligned: entries.length !== 1 || Math.abs(entries[0].getBoundingClientRect().right - controlsBounds.right) < 1,
    branchButtonsContained: [...status.firstElementChild!.querySelectorAll<HTMLElement>("button")].every((button) => button.getBoundingClientRect().right <= controlsBounds.left && button.getBoundingClientRect().width >= 32),
    oneOrSeven: entries.length === 7 || (entries.length === 1 && entries[0].dataset.sessionControl === "session-actions" && controls.querySelectorAll("button").length === 1),
  };
  return { checks, entries: entries.length, toolbarWidth: bounds.width, modeGap: sendBounds.left - modeBounds.right };
}

function Fixture() {
  const [width, setWidth] = useState(768);
  const [mode, setMode] = useState<ComposerPermission>("autoContinue");
  const [streaming, setStreaming] = useState(false);
  const [chrome, setChrome] = useState(true);
  useEffect(() => {
    let cancelled = false;
    async function run() {
      await document.fonts.ready;
      const results = [];
      for (const language of ["zh", "en"]) {
        await i18n.changeLanguage(language);
        for (const nextWidth of [320, 400, 480, 599, 620, 640, 768]) {
          for (const nextMode of ["default", "autoContinue", "readonlyAutoContinue"] as const) {
            for (const nextStreaming of [false, true]) {
              if (cancelled) return;
              flushSync(() => { setWidth(nextWidth); setMode(nextMode); setStreaming(nextStreaming); });
              await settle();
              results.push({ language, width: nextWidth, mode: nextMode, streaming: nextStreaming, ...measure() });
            }
          }
        }
      }
      await i18n.changeLanguage("zh");
      flushSync(() => { setWidth(768); setMode("autoContinue"); setStreaming(false); setChrome(false); });
      await settle();
      const wide = measure();
      const pass = results.every((result) => Object.values(result.checks).every(Boolean)) && wide.entries === 7;
      document.querySelector("#result")!.textContent = JSON.stringify({ status: pass ? "PASS" : "FAIL", scenarios: results.length, wide, results }, null, 2);
      Object.assign(window, { __responsiveDone: true, __responsiveResults: { pass, results, wide } });
    }
    void run();
    return () => { cancelled = true; };
  }, []);
  return (
    <>
      <pre id="result" style={{ whiteSpace: "pre-wrap" }}>正在检查布局…</pre>
      <div data-fixture-frame style={{ position: "fixed", bottom: 12, left: 0, width, maxWidth: "100vw" }} className="flex flex-col gap-2.5 bg-background-primary-default px-4">
        <div className="rounded-2xl border border-separator-border p-2">
          <div className="h-16" />
          <ComposerToolbar
            addMenu={<button type="button" className="size-8 shrink-0">+</button>}
            cliMenu={<CliMenu options={[{ id: "claude", label: "HZK CODE", available: true }]} value="claude" modelsByEngine={{ claude: [{ id: model, label: model }] }} models={{ claude: model }} onModelChange={() => {}} efforts={{ claude: "max" }} onEffortChange={() => {}} />}
            permissionMenu={<PermissionMenu value={mode} onChange={setMode} />}
            streaming={streaming} onSend={() => {}} onStop={() => {}}
          />
        </div>
        <StatusBar folders={chrome ? ["very-long-workspace-name"] : []} selectedFolder="very-long-workspace-name" branch={chrome ? "feature/a-very-long-branch-name" : undefined} branches={[]} onBranchSelect={() => {}} usagePct={100} />
      </div>
    </>
  );
}

createRoot(document.getElementById("root")!).render(<MemoryRouter><Fixture /></MemoryRouter>);
