import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createContextManager } from "./context-management.js";
import {
  type ContextManagementSettingsRuntime,
  type ContextManagementSettingsState,
  createContextManagementSettingsRuntime,
} from "./settings.js";
import { terminalText } from "./terminal.js";

export function createContextManagementExtension(
  options: { settingsRuntime?: ContextManagementSettingsRuntime } = {},
): (pi: ExtensionAPI) => void {
  return (pi) => {
    const settingsRuntime = options.settingsRuntime ?? createContextManagementSettingsRuntime();
    const manager = createContextManager(pi, settingsRuntime);
    let sessionController = new AbortController();
    let generation = 0;

    pi.registerCommand("context-management", {
      description: "Configure experimental summary-free context management",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /context-management");
        const ownerGeneration = generation;
        const controller = sessionController;
        const { showContextManagementMenu } = await import("./settings-menu.js");
        if (ownerGeneration !== generation || controller.signal.aborted) return;
        await showContextManagementMenu(settingsRuntime, ctx, {
          signal: controller.signal,
          isCurrent: () => ownerGeneration === generation && !controller.signal.aborted,
          isActive: () => manager.isEnabled(),
          onSettingsChanged: () => manager.applySettings(ctx),
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      sessionController.abort();
      sessionController = new AbortController();
      generation += 1;
      const ownerGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      let state: Readonly<ContextManagementSettingsState>;
      try {
        state = await settingsRuntime.reload(sessionController.signal);
      } catch (error) {
        if (sessionController.signal.aborted || ownerGeneration !== generation) return;
        state = settingsRuntime.get();
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-context-management.json; using defaults. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
        }
      }
      if (
        sessionController.signal.aborted ||
        ownerGeneration !== generation ||
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

    pi.on("session_shutdown", async () => {
      generation += 1;
      sessionController.abort();
      manager.shutdown();
      await settingsRuntime.flush();
    });
  };
}

export default createContextManagementExtension();
