import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { MenuDefinition } from "@narumitw/pi-tui-kit";
import type { ContextManagementSettingsRuntime, ContextManagementSettingsState } from "./settings.js";
import { terminalText as safeText } from "./terminal.js";

type Screen = "main" | "settings" | "status" | "help" | "invalid";
type Action = "set-enabled";

export interface ContextManagementMenuOwner {
  signal: AbortSignal;
  isCurrent(): boolean;
  isActive(): boolean;
  onSettingsChanged(): void | Promise<void>;
}

const settingsChangeQueues = new WeakMap<ContextManagementSettingsRuntime, Promise<void>>();

function enqueueSettingsChange<T>(runtime: ContextManagementSettingsRuntime, operation: () => Promise<T>): Promise<T> {
  const queued = settingsChangeQueues.get(runtime) ?? Promise.resolve();
  const result = queued.then(operation, operation);
  settingsChangeQueues.set(
    runtime,
    result.then(
      () => undefined,
      () => undefined,
    ),
  );
  return result;
}

async function updateEnabled(
  runtime: ContextManagementSettingsRuntime,
  ctx: ExtensionCommandContext,
  enabled: boolean,
  signal: AbortSignal,
  onSettingsChanged: () => void | Promise<void>,
) {
  return enqueueSettingsChange(runtime, async () => {
    const previous = runtime.get().settings.enabled;
    try {
      await runtime.update({ enabled }, signal);
    } catch (error) {
      if (signal.aborted) return { kind: "rejected" as const };
      ctx.ui.notify(
        `Could not save pi-context-management.json: ${safeText(error instanceof Error ? error.message : String(error))}`,
        "error",
      );
      return { kind: "rejected" as const };
    }
    try {
      // A completed save remains committed even if menu cancellation races with reconciliation.
      await onSettingsChanged();
    } catch (error) {
      let rollbackError: unknown;
      try {
        await runtime.update({ enabled: previous });
        await onSettingsChanged();
      } catch (recoveryError) {
        rollbackError = recoveryError;
      }
      if (signal.aborted) return { kind: "rejected" as const };
      const failure = safeText(error instanceof Error ? error.message : String(error));
      const recovery = rollbackError
        ? ` The previous setting could not be fully restored: ${safeText(rollbackError instanceof Error ? rollbackError.message : String(rollbackError))}`
        : " The previous setting was restored.";
      ctx.ui.notify(`Could not apply experimental context management: ${failure}.${recovery}`, "error");
      return { kind: "rejected" as const };
    }
    if (signal.aborted) return { kind: "rejected" as const };
    ctx.ui.notify("Context management settings saved.", "info");
    return { kind: "stay" as const };
  });
}

export function createContextManagementMenu(
  runtime: ContextManagementSettingsRuntime,
  options: {
    isActive?: () => boolean;
    onSettingsChanged?: () => void | Promise<void>;
  } = {},
): MenuDefinition<ContextManagementSettingsState, Screen, Action, ExtensionCommandContext> {
  return {
    start: "main",
    screens: {
      main: ({ state }) => ({
        kind: "actions",
        title: "Experimental Context Management",
        lines: [
          `Configured: ${state.settings.enabled ? "On" : "Off"}`,
          `Runtime: ${options.isActive?.() ? "Active" : state.settings.enabled ? "Unavailable" : "Inactive"}`,
        ],
        items: [
          state.kind === "invalid"
            ? {
                id: "settings",
                label: "Settings",
                description: "Read-only until the invalid settings file is repaired.",
                to: "invalid" as const,
              }
            : { id: "settings", label: "Settings", to: "settings" as const },
          { id: "status", label: "Status", to: "status" as const },
          { id: "help", label: "Help", to: "help" as const },
          { id: "close", label: "Close", close: true },
        ],
        hint: "close",
      }),
      settings: ({ state }) => ({
        kind: "settings",
        title: "Context Management Settings",
        lines: [`User settings · ${safeText(state.path)}`],
        items: [
          {
            id: "enabled",
            label: "Experimental context management",
            description: "Use summary-free local rollover and four branch-local context tools.",
            currentValue: state.settings.enabled ? "On" : "Off",
            values: ["On", "Off"],
            action: "set-enabled",
          },
        ],
      }),
      status: ({ state }) => ({
        kind: "detail",
        title: "Context Management Status",
        lines: [
          `Configured: ${state.settings.enabled ? "On" : "Off"}`,
          `Runtime: ${options.isActive?.() ? "Active" : state.settings.enabled ? "Unavailable" : "Inactive"}`,
          `Settings: ${safeText(state.path)}`,
        ],
        hint: "back",
      }),
      help: () => ({
        kind: "detail",
        title: "Context Management Help",
        lines: [
          "This experimental extension starts summary-free context windows and exposes bounded history and note tools.",
          "Save important information in notes before starting a new context.",
          "Disabling the extension restores Pi-native compaction after the active run settles.",
        ],
        hint: "back",
      }),
      invalid: ({ state }) => ({
        kind: "detail",
        title: "Context Management Settings · Read only",
        lines: [
          `Invalid settings file: ${safeText(state.path)}`,
          `Issue: ${safeText(state.issue ?? "unknown validation error")}`,
          "Built-in defaults are active. Repair the file and run /reload; it will not be overwritten.",
        ],
        hint: "back",
      }),
    },
    actions: {
      "set-enabled": ({ ctx, value, signal }) =>
        updateEnabled(runtime, ctx, value === "On", signal, options.onSettingsChanged ?? (() => undefined)),
    },
  };
}

export async function showContextManagementMenu(
  runtime: ContextManagementSettingsRuntime,
  ctx: ExtensionCommandContext,
  owner: ContextManagementMenuOwner,
): Promise<void> {
  if (ctx.mode === "rpc" && ctx.hasUI) {
    ctx.ui.notify(`Edit experimental context management settings at ${safeText(runtime.get().path)}.`, "info");
    return;
  }
  if (ctx.mode !== "tui") {
    throw new Error("/context-management requires TUI or RPC UI support");
  }
  const { runMenu } = await import("@narumitw/pi-tui-kit");
  if (owner.signal.aborted || !owner.isCurrent()) return;
  await runMenu(
    ctx,
    createContextManagementMenu(runtime, {
      isActive: owner.isActive,
      onSettingsChanged: owner.onSettingsChanged,
    }),
    {
      getState: () => runtime.get(),
      signal: owner.signal,
      isCurrent: owner.isCurrent,
    },
  );
}
