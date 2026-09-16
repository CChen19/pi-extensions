import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createContextManager } from "./context-management.js";
import {
  type ContextManagementSettingsRuntime,
  type ContextManagementSettingsState,
  createContextManagementSettingsRuntime,
} from "./settings.js";
import { terminalText } from "./terminal.js";

interface SessionRuntime {
  controller: AbortController;
  generation: number;
}

export function createContextManagementExtension(
  options: { settingsRuntime?: ContextManagementSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const settingsRuntime = options.settingsRuntime ?? createContextManagementSettingsRuntime();
    const manager = createContextManager(pi, settingsRuntime);
    const sessions = new Map<ExtensionContext["sessionManager"], SessionRuntime>();
    let nextGeneration = 0;

    pi.registerCommand("context-management", {
      description: "Configure experimental summary-free context management",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /context-management");
        const owner = sessions.get(ctx.sessionManager);
        const controller = owner?.controller ?? new AbortController();
        const { showContextManagementMenu } = await import("./settings-menu.js");
        if (owner && (sessions.get(ctx.sessionManager) !== owner || controller.signal.aborted)) return;
        await showContextManagementMenu(settingsRuntime, ctx, {
          signal: controller.signal,
          isCurrent: () =>
            owner
              ? sessions.get(ctx.sessionManager) === owner && !controller.signal.aborted
              : !controller.signal.aborted,
          isActive: () => manager.isEnabled(ctx),
          onSettingsChanged: () => manager.applySettings(ctx),
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      sessions.get(ctx.sessionManager)?.controller.abort();
      const owner: SessionRuntime = {
        controller: new AbortController(),
        generation: ++nextGeneration,
      };
      sessions.set(ctx.sessionManager, owner);
      const sessionId = ctx.sessionManager.getSessionId();
      let state: Readonly<ContextManagementSettingsState>;
      try {
        state = await settingsRuntime.reload(owner.controller.signal);
      } catch (error) {
        if (owner.controller.signal.aborted || sessions.get(ctx.sessionManager) !== owner) return;
        state = settingsRuntime.get();
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-context-management.json; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
        }
      }
      if (
        owner.controller.signal.aborted ||
        sessions.get(ctx.sessionManager) !== owner ||
        ctx.sessionManager.getSessionId() !== sessionId
      ) {
        return;
      }
      if (ctx.hasUI && state.kind === "invalid") {
        ctx.ui.notify(
          `Invalid pi-context-management.json; using defaults without overwriting it. ${terminalText(state.issue ?? "unknown validation error")}`,
          "warning",
        );
      }
      manager.startSession(ctx);
    });

    pi.on("session_before_compact", (event, ctx) => manager.beforeCompact(event, ctx));
    pi.on("context", (event, ctx) => {
      const messages = manager.projectContext(event.messages, ctx);
      return messages ? { messages } : undefined;
    });
    pi.on("session_tree", (_event, ctx) => manager.onSessionTree(ctx));
    pi.on("session_compact", (event, ctx) => manager.onCompact(event, ctx));
    pi.on("session_compact_failed", (event, ctx) => manager.onCompactFailed(event, ctx));
    pi.on("agent_start", (_event, ctx) => manager.onAgentStart(ctx));
    pi.on("agent_end", (event, ctx) => manager.onAgentEnd(event, ctx));
    pi.on("turn_start", (_event, ctx) => manager.onTurnStart(ctx));
    pi.on("agent_settled", (_event, ctx) => manager.onAgentSettled(ctx));

    pi.on("session_shutdown", async (_event, ctx) => {
      const owner = sessions.get(ctx.sessionManager);
      owner?.controller.abort();
      if (sessions.get(ctx.sessionManager) === owner) sessions.delete(ctx.sessionManager);
      manager.shutdown(ctx);
      await settingsRuntime.flush();
    });
  };
}

export default createContextManagementExtension();
