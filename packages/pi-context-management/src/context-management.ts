import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  type AgentEndEvent,
  type ExtensionAPI,
  type ExtensionContext,
  type SessionBeforeCompactEvent,
  type SessionCompactEvent,
  type SessionEntry,
  sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import {
  CONTEXT_MANAGEMENT_TOOL_NAMES,
  type ContextToolRuntime,
  registerContextManagementTools,
} from "./context-tools.js";
import {
  activeContextManagementCompaction,
  CONTEXT_CONTRACT_MESSAGE_TYPE,
  CONTEXT_DEACTIVATION_MESSAGE_TYPE,
  CONTEXT_DETAILS_KIND,
  CONTEXT_STATE_ENTRY_TYPE,
  CONTEXT_VERSION,
  type ContextBranchScanBudget,
  type ContextLineage,
  compactionRetainedContext,
  contextContract,
  contextDeactivation,
  createContextBranchScanBudget,
  createContextContractMessage,
  createContextManagementDetails,
  createInitialContextState,
  hasContextContract,
  latestContextMode,
  loadContextLineage,
  parseContextManagementCompaction,
  projectContextManagementContext,
  reconcileContextContract,
  visitContextBranchEntry,
} from "./context-window.js";
import { createFingerprintBudget } from "./fingerprint.js";
import type { ContextManagementSettingsRuntime } from "./settings.js";
import { terminalText } from "./terminal.js";

const CONTINUATION_MESSAGE_TYPE = "pi-context-management-continuation";
const ROLLOVER_STATE_ENTRY_TYPE = "pi-context-management-rollover";
const START_NEW_CONTEXT_TOOL_NAME = "context_management_start_new_context";
const EXTENSION_ENTRY_PATH = realpathSync(join(fileURLToPath(new URL(".", import.meta.url)), "index.ts"));

type PendingRollover = {
  requestId: string;
  nextWindowId: string;
  sessionId: string;
  generation: number;
  status: "requested" | "compacting" | "completed" | "failed";
  turnStartedAfterRequest: boolean;
  successfulTurnAfterRequest: boolean;
  reason?: string;
  errorMessage?: string;
};

type SessionKey = ExtensionContext["sessionManager"];

interface SessionState {
  key: SessionKey;
  generation: number;
  sessionId: string;
  lineage?: ContextLineage;
  pending?: PendingRollover;
  warned: boolean;
  warnedUnavailableTools: boolean;
  warnedProjectionFailure: boolean;
  toolsAvailable: boolean;
  removeToolsAtSettlement: boolean;
  fallbackDeactivationPending: boolean;
  fallbackActivationPending: boolean;
  agentRunActive: boolean;
  controller: AbortController;
}

function sameNames(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((name, index) => name === right[index]);
}

function isOwnedToolSource(tool: { sourceInfo: { path: string } } | undefined): boolean {
  if (!tool || tool.sourceInfo.path.startsWith("<")) return false;
  try {
    return realpathSync(tool.sourceInfo.path) === EXTENSION_ENTRY_PATH;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

function contractMessage(lineage: ContextLineage) {
  return {
    customType: CONTEXT_CONTRACT_MESSAGE_TYPE,
    content: contextContract(lineage),
    display: false,
    details: {
      kind: CONTEXT_DETAILS_KIND,
      version: CONTEXT_VERSION,
      currentWindowId: lineage.currentWindowId,
    },
  };
}

function deactivationMessage() {
  return {
    customType: CONTEXT_DEACTIVATION_MESSAGE_TYPE,
    content: contextDeactivation(),
    display: false,
    details: { kind: CONTEXT_DETAILS_KIND, version: CONTEXT_VERSION },
  };
}

function deactivationAgentMessage(): AgentMessage {
  return {
    role: "custom",
    ...deactivationMessage(),
    timestamp: 0,
  };
}

interface CompactFailedEvent {
  errorMessage?: string;
  aborted: boolean;
}

function latestAssistantStopReason(messages: readonly AgentMessage[]): string | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "assistant") return message.stopReason;
  }
  return undefined;
}

function terminalRolloverRequestId(entry: SessionEntry): string | undefined {
  if (entry.type === "custom" && entry.customType === ROLLOVER_STATE_ENTRY_TYPE) {
    const data = entry.data;
    return isRecord(data) &&
      data.kind === CONTEXT_DETAILS_KIND &&
      data.version === CONTEXT_VERSION &&
      (data.status === "cancelled" || data.status === "suppressed") &&
      isIdentifier(data.requestId)
      ? data.requestId
      : undefined;
  }
  const message = entry.type === "message" && entry.message.role === "custom" ? entry.message : undefined;
  const customMessage = entry.type === "custom_message" ? entry : message;
  if (
    customMessage?.customType === CONTINUATION_MESSAGE_TYPE &&
    isRecord(customMessage.details) &&
    customMessage.details.kind === CONTEXT_DETAILS_KIND &&
    customMessage.details.version === CONTEXT_VERSION &&
    isIdentifier(customMessage.details.requestId)
  ) {
    return customMessage.details.requestId;
  }
  return undefined;
}

function restoredRollover(
  entries: readonly SessionEntry[],
  sessionId: string,
  generation: number,
  budget: ContextBranchScanBudget = createContextBranchScanBudget(),
): PendingRollover | undefined {
  const terminalRequests = new Set<string>();
  const completedRequests = new Map<string, string>();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    visitContextBranchEntry(budget);
    const entry = entries[index];
    const terminalRequestId = terminalRolloverRequestId(entry);
    if (terminalRequestId) terminalRequests.add(terminalRequestId);
    if (entry.type === "compaction") {
      const details = parseContextManagementCompaction(entry, budget);
      if (details?.requestId) completedRequests.set(details.requestId, details.currentWindowId);
      continue;
    }
    if (entry.type !== "message") continue;
    const message = entry.message;
    if (message.role !== "toolResult" || message.toolName !== START_NEW_CONTEXT_TOOL_NAME) continue;
    const details = message.details;
    if (
      !isRecord(details) ||
      details.kind !== CONTEXT_DETAILS_KIND ||
      details.version !== CONTEXT_VERSION ||
      details.status !== "scheduled" ||
      !isIdentifier(details.requestId) ||
      !isIdentifier(details.currentWindowId) ||
      !isIdentifier(details.nextWindowId) ||
      (details.reason !== undefined && (typeof details.reason !== "string" || details.reason.length > 512))
    ) {
      continue;
    }
    if (terminalRequests.has(details.requestId)) return undefined;
    const completedWindowId = completedRequests.get(details.requestId);
    return {
      requestId: details.requestId,
      nextWindowId: completedWindowId ?? details.nextWindowId,
      sessionId,
      generation,
      status: completedWindowId ? "completed" : "requested",
      turnStartedAfterRequest: false,
      successfulTurnAfterRequest: false,
      ...(typeof details.reason === "string" ? { reason: details.reason } : {}),
    };
  }
  return undefined;
}

function boundedContextMessages(entries: readonly SessionEntry[]): AgentMessage[] {
  const budget = createContextBranchScanBudget();
  const messages: AgentMessage[] = [];
  for (const entry of entries) {
    visitContextBranchEntry(budget);
    messages.push(...sessionEntryToContextMessages(entry));
  }
  return messages;
}

function branchContainsEntry(entries: readonly SessionEntry[], entryId: string): boolean {
  const budget = createContextBranchScanBudget();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    visitContextBranchEntry(budget);
    if (entries[index].id === entryId) return true;
  }
  return false;
}

type BeforeCompactResult =
  | { cancel: true }
  | {
      compaction: {
        summary: string;
        firstKeptEntryId: string;
        tokensBefore: number;
        details: unknown;
      };
    };

export interface ContextManager {
  isEnabled(ctx: ExtensionContext): boolean;
  startSession(ctx: ExtensionContext): void;
  onSessionTree(ctx: ExtensionContext): void;
  applySettings(ctx: ExtensionContext): void;
  onInput(ctx: ExtensionContext): void;
  beforeCompact(event: SessionBeforeCompactEvent, ctx: ExtensionContext): BeforeCompactResult | undefined;
  projectContext(messages: readonly AgentMessage[], ctx: ExtensionContext): AgentMessage[] | undefined;
  onCompact(event: SessionCompactEvent, ctx: ExtensionContext): void;
  onCompactFailed(event: CompactFailedEvent, ctx: ExtensionContext): void;
  onAgentStart(ctx: ExtensionContext): void;
  onAgentEnd(event: AgentEndEvent, ctx: ExtensionContext): void;
  onTurnStart(ctx: ExtensionContext): void;
  onAgentSettled(ctx: ExtensionContext): void;
  shutdown(ctx: ExtensionContext): void;
}

export function createContextManager(
  pi: ExtensionAPI,
  settingsRuntime: ContextManagementSettingsRuntime,
): ContextManager {
  const states = new Map<SessionKey, SessionState>();
  let nextGeneration = 0;
  const isConfigured = () => settingsRuntime.get().settings.enabled;

  const stateFor = (ctx: ExtensionContext): SessionState | undefined => {
    const state = states.get(ctx.sessionManager);
    return state && !state.controller.signal.aborted && state.sessionId === ctx.sessionManager.getSessionId()
      ? state
      : undefined;
  };

  const inspectToolUnit = () => {
    const available = new Map(pi.getAllTools().map((tool) => [tool.name, tool]));
    const ownedNames = new Set<string>(
      CONTEXT_MANAGEMENT_TOOL_NAMES.filter((name) => isOwnedToolSource(available.get(name))),
    );
    const activeNames = new Set(pi.getActiveTools());
    const unavailableNames = CONTEXT_MANAGEMENT_TOOL_NAMES.filter((name) => !ownedNames.has(name));
    const inactiveNames = CONTEXT_MANAGEMENT_TOOL_NAMES.filter(
      (name) => ownedNames.has(name) && !activeNames.has(name),
    );
    return {
      ownedNames,
      unavailableNames,
      inactiveNames,
      complete: unavailableNames.length === 0 && inactiveNames.length === 0,
    };
  };

  const enabledFor = (state: SessionState) =>
    (isConfigured() || state.removeToolsAtSettlement) && state.toolsAvailable && inspectToolUnit().complete;

  const isOwned = (state: SessionState, ctx: ExtensionContext, request?: PendingRollover) =>
    stateFor(ctx) === state &&
    (!request ||
      (request.sessionId === state.sessionId &&
        request.generation === state.generation &&
        state.pending?.requestId === request.requestId));

  const removeOwnedTools = (ownedNames: ReadonlySet<string>) => {
    const current = pi.getActiveTools();
    const next = current.filter((name) => !ownedNames.has(name));
    if (!sameNames(current, next)) pi.setActiveTools(next);
    for (const state of states.values()) state.toolsAvailable = false;
  };

  const warnToolUnitUnavailable = (
    state: SessionState,
    ctx: ExtensionContext,
    unavailableNames: readonly string[],
    inactiveNames: readonly string[],
  ) => {
    if (state.warnedUnavailableTools || !ctx.hasUI) return;
    state.warnedUnavailableTools = true;
    const names = [...unavailableNames, ...inactiveNames];
    ctx.ui.notify(
      `Experimental context management could not activate because these tool names are unavailable, inactive, or owned by another extension: ${names.join(", ")}. Pi-native compaction remains active.`,
      "warning",
    );
  };

  const hasDeferredToolRemoval = () => [...states.values()].some((state) => state.removeToolsAtSettlement);

  const reconcileTools = (state: SessionState, activate: boolean, ctx: ExtensionContext): boolean => {
    const inspection = inspectToolUnit();
    const available = activate && inspection.unavailableNames.length === 0;
    const current = pi.getActiveTools();
    const next = available
      ? [...current, ...inspection.inactiveNames]
      : current.filter((name) => !inspection.ownedNames.has(name));
    if (!sameNames(current, next)) pi.setActiveTools(next);
    for (const candidate of states.values()) candidate.toolsAvailable = available;
    if (activate && !available) {
      warnToolUnitUnavailable(state, ctx, inspection.unavailableNames, inspection.inactiveNames);
    }
    return available;
  };

  const deactivateIncompleteToolUnit = (state: SessionState, ctx: ExtensionContext): boolean => {
    const inspection = inspectToolUnit();
    if (inspection.complete) return false;
    let branchIsActive = false;
    for (const candidate of states.values()) {
      if (candidate.controller.signal.aborted || candidate.sessionId !== candidate.key.getSessionId()) continue;
      const candidateBranchIsActive = latestContextMode(candidate.key.getBranch()) === "active";
      if (candidate === state) branchIsActive = candidateBranchIsActive;
      candidate.fallbackDeactivationPending = candidateBranchIsActive;
      candidate.fallbackActivationPending = false;
      candidate.removeToolsAtSettlement = false;
      if (candidate.pending?.status === "requested" || candidate.pending?.status === "compacting") {
        candidate.pending.status = "failed";
        candidate.pending.errorMessage = "Experimental context management tool unit became incomplete during rollover.";
      }
    }
    if (branchIsActive) pi.sendMessage(deactivationMessage(), { triggerTurn: false });
    removeOwnedTools(inspection.ownedNames);
    warnToolUnitUnavailable(state, ctx, inspection.unavailableNames, inspection.inactiveNames);
    return branchIsActive;
  };

  const ensureLineage = (state: SessionState, ctx: ExtensionContext): ContextLineage => {
    const persisted = state.lineage ?? loadContextLineage(ctx.sessionManager.getBranch());
    if (persisted) {
      state.lineage = persisted;
      return persisted;
    }
    const initial = createInitialContextState();
    pi.appendEntry(CONTEXT_STATE_ENTRY_TYPE, initial);
    state.lineage = initial;
    return initial;
  };

  const warnEnabled = (state: SessionState, ctx: ExtensionContext) => {
    if (state.warned || !ctx.hasUI) return;
    state.warned = true;
    ctx.ui.notify(
      "Experimental context management is active. Context rollover does not create a summary; preserve important information with context_management_update_notes.",
      "warning",
    );
  };

  const applySettings = (ctx: ExtensionContext) => {
    const state = stateFor(ctx);
    if (!state) return;
    const branch = ctx.sessionManager.getBranch();
    const runIsActive = state.agentRunActive || ctx.signal !== undefined;
    state.agentRunActive = runIsActive;
    if (!isConfigured()) {
      const inspection = inspectToolUnit();
      for (const candidate of states.values()) {
        candidate.fallbackActivationPending = false;
        const candidateRunIsActive = candidate === state ? runIsActive : candidate.agentRunActive;
        if (candidateRunIsActive && candidate.toolsAvailable && inspection.complete) {
          candidate.removeToolsAtSettlement = true;
          candidate.fallbackDeactivationPending = false;
          continue;
        }
        candidate.removeToolsAtSettlement = false;
        const branchIsActive =
          !candidate.controller.signal.aborted &&
          candidate.sessionId === candidate.key.getSessionId() &&
          latestContextMode(candidate.key.getBranch()) === "active";
        candidate.fallbackDeactivationPending = branchIsActive && (candidate !== state || candidateRunIsActive);
        if (branchIsActive && candidate === state && !candidateRunIsActive) {
          pi.sendMessage(deactivationMessage(), { triggerTurn: false });
        }
      }
      reconcileTools(state, hasDeferredToolRemoval(), ctx);
      return;
    }
    const contractAlreadyActiveOrQueued = state.removeToolsAtSettlement && !state.fallbackDeactivationPending;
    const deactivationAlreadyPending = state.fallbackDeactivationPending;
    const toolsWereAvailable = state.toolsAvailable;
    for (const candidate of states.values()) {
      candidate.removeToolsAtSettlement = false;
      candidate.fallbackDeactivationPending = false;
      candidate.fallbackActivationPending = false;
    }
    if (!reconcileTools(state, true, ctx)) {
      deactivateIncompleteToolUnit(state, ctx);
      if (runIsActive && (toolsWereAvailable || contractAlreadyActiveOrQueued || deactivationAlreadyPending)) {
        state.fallbackDeactivationPending = true;
      }
      return;
    }
    let activeLineage: ContextLineage;
    try {
      activeLineage = ensureLineage(state, ctx);
    } catch (error) {
      reconcileTools(state, false, ctx);
      throw error;
    }
    for (const candidate of states.values()) {
      if (
        candidate !== state &&
        !candidate.controller.signal.aborted &&
        candidate.sessionId === candidate.key.getSessionId() &&
        latestContextMode(candidate.key.getBranch()) !== "active"
      ) {
        candidate.fallbackActivationPending = true;
      }
    }
    const messages = boundedContextMessages(branch);
    if (
      deactivationAlreadyPending ||
      (!contractAlreadyActiveOrQueued &&
        (latestContextMode(branch) !== "active" || !hasContextContract(messages, activeLineage)))
    ) {
      pi.sendMessage(contractMessage(activeLineage), { triggerTurn: false });
    }
    state.fallbackActivationPending = false;
    warnEnabled(state, ctx);
  };

  const requestNewContext: ContextToolRuntime["requestNewContext"] = (ctx, input) => {
    const state = stateFor(ctx);
    if (!state) throw new Error("The context session was replaced; retry in the active session");
    if (!isConfigured()) {
      throw new Error("Experimental context management is deactivating; retry after enabling it");
    }
    if (state.pending) throw new Error("A context rollover is already pending");
    const activeLineage = ensureLineage(state, ctx);
    state.pending = {
      requestId: randomUUID(),
      nextWindowId: randomUUID(),
      sessionId: state.sessionId,
      generation: state.generation,
      status: "requested",
      turnStartedAfterRequest: false,
      successfulTurnAfterRequest: false,
      ...(input.reason ? { reason: input.reason } : {}),
    };
    return {
      requestId: state.pending.requestId,
      currentWindowId: activeLineage.currentWindowId,
      nextWindowId: state.pending.nextWindowId,
      ...(state.pending.reason ? { reason: state.pending.reason } : {}),
    };
  };

  registerContextManagementTools(pi, {
    isEnabled(ctx) {
      const state = stateFor(ctx);
      return state ? enabledFor(state) : false;
    },
    requestNewContext,
  });

  const continueAfterRollover = (state: SessionState, ctx: ExtensionContext, request: PendingRollover) => {
    if (!isOwned(state, ctx, request) || request.status !== "completed") return;
    const current = state.lineage;
    const contextToolsAvailable = enabledFor(state);
    state.pending = undefined;
    if (!current) return;
    pi.sendMessage(
      {
        customType: CONTINUATION_MESSAGE_TYPE,
        content: [
          `Context window ${current.currentWindowId} is now active.`,
          request.reason ? `Rollover reason: ${request.reason}` : undefined,
          contextToolsAvailable
            ? "Continue the interrupted task. Use context_management_recall_context for older details and do not assume an automatic summary exists."
            : "Continue the interrupted task. The experimental context tools became unavailable; do not assume an automatic summary or local recall is available.",
        ]
          .filter((line): line is string => Boolean(line))
          .join("\n"),
        display: false,
        details: {
          kind: CONTEXT_DETAILS_KIND,
          version: CONTEXT_VERSION,
          requestId: request.requestId,
          currentWindowId: current.currentWindowId,
        },
      },
      { triggerTurn: true },
    );
  };

  const failRollover = (state: SessionState, ctx: ExtensionContext, request: PendingRollover, message: string) => {
    if (!isOwned(state, ctx, request)) return;
    state.pending = undefined;
    const safeMessage = terminalText(message).slice(0, 2_000);
    if (ctx.hasUI) ctx.ui.notify(safeMessage, "warning");
    pi.sendMessage(
      {
        customType: CONTINUATION_MESSAGE_TYPE,
        content: `The requested experimental context rollover failed. Continue with Pi's active fallback context. ${safeMessage}`,
        display: false,
        details: {
          kind: CONTEXT_DETAILS_KIND,
          version: CONTEXT_VERSION,
          requestId: request.requestId,
          failed: true,
        },
      },
      request.successfulTurnAfterRequest
        ? { triggerTurn: false }
        : ctx.isIdle()
          ? { triggerTurn: true }
          : { triggerTurn: true, deliverAs: "followUp" },
    );
  };

  const finishRolloverWithoutContinuation = (
    state: SessionState,
    ctx: ExtensionContext,
    request: PendingRollover,
    status: "cancelled" | "suppressed",
  ) => {
    if (!isOwned(state, ctx, request)) return;
    pi.appendEntry(ROLLOVER_STATE_ENTRY_TYPE, {
      kind: CONTEXT_DETAILS_KIND,
      version: CONTEXT_VERSION,
      requestId: request.requestId,
      status,
    });
    if (isOwned(state, ctx, request)) state.pending = undefined;
  };

  const settle = (state: SessionState, ctx: ExtensionContext) => {
    if (!isOwned(state, ctx)) return;
    state.agentRunActive = ctx.signal !== undefined;
    if (state.agentRunActive) return;
    if (state.removeToolsAtSettlement || state.fallbackDeactivationPending) {
      state.removeToolsAtSettlement = false;
      state.fallbackDeactivationPending = false;
      if (!isConfigured()) {
        if (latestContextMode(ctx.sessionManager.getBranch()) !== "inactive") {
          pi.sendMessage(deactivationMessage(), { triggerTurn: false });
        }
        reconcileTools(state, hasDeferredToolRemoval(), ctx);
      }
    }
    const request = state.pending;
    if (!request || !isOwned(state, ctx, request)) return;
    if (!isConfigured() && (request.status === "requested" || request.status === "compacting")) {
      request.status = "failed";
      request.errorMessage = "Experimental context management was disabled before rollover completed.";
    }
    if (request.status === "completed") {
      if (request.successfulTurnAfterRequest) {
        finishRolloverWithoutContinuation(state, ctx, request, "suppressed");
      } else {
        continueAfterRollover(state, ctx, request);
      }
      return;
    }
    if (request.status === "failed") {
      failRollover(state, ctx, request, request.errorMessage ?? "Compaction failed.");
      return;
    }
    if (request.status !== "requested") return;
    request.status = "compacting";
    ctx.compact({
      onComplete: (result) => {
        if (!isOwned(state, ctx, request)) return;
        if (request.status === "failed") {
          failRollover(
            state,
            ctx,
            request,
            request.errorMessage ?? "Compaction completed without the requested context marker.",
          );
          return;
        }
        const details = parseContextManagementCompaction(result);
        if (request.status !== "completed" || !details || details.requestId !== request.requestId) {
          failRollover(state, ctx, request, "Compaction completed without the requested context marker.");
          return;
        }
        state.lineage = details;
        if (request.successfulTurnAfterRequest) {
          finishRolloverWithoutContinuation(state, ctx, request, "suppressed");
        } else {
          continueAfterRollover(state, ctx, request);
        }
      },
      onError: (error) => failRollover(state, ctx, request, error.message),
    });
  };

  return {
    isEnabled(ctx) {
      const state = stateFor(ctx);
      return state ? enabledFor(state) : false;
    },
    startSession(ctx) {
      const previous = states.get(ctx.sessionManager);
      previous?.controller.abort();
      const generation = ++nextGeneration;
      const branch = ctx.sessionManager.getBranch();
      const sessionId = ctx.sessionManager.getSessionId();
      const recoveryBudget = createContextBranchScanBudget();
      const state: SessionState = {
        key: ctx.sessionManager,
        generation,
        sessionId,
        lineage: loadContextLineage(branch, recoveryBudget),
        pending: restoredRollover(branch, sessionId, generation, recoveryBudget),
        warned: false,
        warnedUnavailableTools: false,
        warnedProjectionFailure: false,
        toolsAvailable: false,
        removeToolsAtSettlement: false,
        fallbackDeactivationPending: false,
        fallbackActivationPending: false,
        agentRunActive: false,
        controller: new AbortController(),
      };
      states.set(ctx.sessionManager, state);
      applySettings(ctx);
      if (state.pending && ctx.isIdle()) settle(state, ctx);
    },
    onSessionTree(ctx) {
      const previous = stateFor(ctx);
      if (!previous) return;
      previous.controller.abort();
      const generation = ++nextGeneration;
      const branch = ctx.sessionManager.getBranch();
      const recoveryBudget = createContextBranchScanBudget();
      const state: SessionState = {
        ...previous,
        generation,
        lineage: loadContextLineage(branch, recoveryBudget),
        pending: restoredRollover(branch, previous.sessionId, generation, recoveryBudget),
        removeToolsAtSettlement: false,
        fallbackDeactivationPending: false,
        fallbackActivationPending: false,
        agentRunActive: false,
        controller: new AbortController(),
      };
      states.set(ctx.sessionManager, state);
      applySettings(ctx);
      if (state.pending && ctx.isIdle()) settle(state, ctx);
    },
    applySettings,
    onInput(ctx) {
      const state = stateFor(ctx);
      if (!state || !ctx.isIdle()) return;
      if (isConfigured() && state.fallbackActivationPending && enabledFor(state)) {
        const activeLineage = ensureLineage(state, ctx);
        if (latestContextMode(ctx.sessionManager.getBranch()) !== "active") {
          pi.sendMessage(contractMessage(activeLineage), { triggerTurn: false });
        }
        state.fallbackActivationPending = false;
        return;
      }
      if (isConfigured() || !state.fallbackDeactivationPending) return;
      if (latestContextMode(ctx.sessionManager.getBranch()) !== "inactive") {
        pi.sendMessage(deactivationMessage(), { triggerTurn: false });
      }
      state.fallbackDeactivationPending = false;
    },
    beforeCompact(event, ctx) {
      const state = stateFor(ctx);
      if (!state || event.signal.aborted) return undefined;
      if (state.toolsAvailable && !inspectToolUnit().complete) deactivateIncompleteToolUnit(state, ctx);
      if (!enabledFor(state)) return undefined;
      const request =
        state.pending?.status === "requested" || state.pending?.status === "compacting" ? state.pending : undefined;
      try {
        const activeLineage = ensureLineage(state, ctx);
        const fingerprintBudget = createFingerprintBudget();
        const details = createContextManagementDetails(
          {
            lineage: activeLineage,
            ...compactionRetainedContext(event, fingerprintBudget),
            reason: event.reason,
            ...(request ? { requestId: request.requestId, windowId: request.nextWindowId } : {}),
          },
          fingerprintBudget,
        );
        if (request) request.status = "compacting";
        return {
          compaction: {
            summary: contextContract(details),
            firstKeptEntryId: event.preparation.firstKeptEntryId,
            tokensBefore: event.preparation.tokensBefore,
            details,
          },
        };
      } catch (error) {
        const message = terminalText(error instanceof Error ? error.message : String(error)).slice(0, 2_000);
        if (request && isOwned(state, ctx, request)) {
          request.status = "failed";
          request.errorMessage = message;
        }
        if (ctx.hasUI) ctx.ui.notify(`Experimental context compaction was cancelled. ${message}`, "warning");
        return { cancel: true };
      }
    },
    projectContext(messages, ctx) {
      const state = stateFor(ctx);
      if (!state) return undefined;
      if (state.toolsAvailable && !inspectToolUnit().complete) deactivateIncompleteToolUnit(state, ctx);
      if (!enabledFor(state)) {
        if (state.fallbackDeactivationPending) {
          if (latestContextMode(ctx.sessionManager.getBranch()) !== "inactive") {
            pi.sendMessage(deactivationMessage(), { triggerTurn: false });
            state.fallbackDeactivationPending = false;
            return [...messages, deactivationAgentMessage()];
          }
          state.fallbackDeactivationPending = false;
        }
        return undefined;
      }
      const branch = ctx.sessionManager.getBranch();
      const activeLineage = state.lineage ?? loadContextLineage(branch);
      if (!activeLineage) return undefined;
      try {
        const activationPending = state.fallbackActivationPending && latestContextMode(branch) !== "active";
        const compaction = activeContextManagementCompaction(branch);
        if (compaction) {
          const projected = projectContextManagementContext(messages, compaction.entry, compaction.details);
          if (!projected) return undefined;
          state.fallbackActivationPending = false;
          if (activationPending) {
            pi.sendMessage(contractMessage(compaction.details), { triggerTurn: false });
            return [...projected, createContextContractMessage(compaction.details)];
          }
          return reconcileContextContract(projected, compaction.details);
        }
        state.fallbackActivationPending = false;
        if (activationPending) {
          pi.sendMessage(contractMessage(activeLineage), { triggerTurn: false });
          return [...messages, createContextContractMessage(activeLineage)];
        }
        return hasContextContract(messages, activeLineage)
          ? undefined
          : reconcileContextContract(messages, activeLineage);
      } catch (error) {
        if (!state.warnedProjectionFailure && ctx.hasUI) {
          state.warnedProjectionFailure = true;
          ctx.ui.notify(
            `Experimental context projection kept Pi's persisted context unchanged. ${terminalText(error instanceof Error ? error.message : String(error))}`,
            "warning",
          );
        }
        return undefined;
      }
    },
    onCompact(event, ctx) {
      const state = stateFor(ctx);
      if (!state || !branchContainsEntry(ctx.sessionManager.getBranch(), event.compactionEntry.id)) {
        return;
      }
      const details = parseContextManagementCompaction(event.compactionEntry);
      const request = state.pending;
      if (request?.status !== "compacting" || !isOwned(state, ctx, request)) {
        if (details) state.lineage = details;
        return;
      }
      if (!details || details.requestId !== request.requestId) {
        request.status = "failed";
        request.errorMessage = "Compaction completed without the requested context marker.";
        return;
      }
      state.lineage = details;
      request.status = "completed";
    },
    onCompactFailed(event, ctx) {
      const state = stateFor(ctx);
      const request = state?.pending;
      if (!state || request?.status !== "compacting" || !isOwned(state, ctx, request)) return;
      if (event.aborted) {
        finishRolloverWithoutContinuation(state, ctx, request, "cancelled");
        return;
      }
      request.status = "failed";
      request.errorMessage = event.errorMessage ?? "Compaction failed.";
    },
    onAgentStart(ctx) {
      const state = stateFor(ctx);
      if (state) state.agentRunActive = true;
    },
    onAgentEnd(event, ctx) {
      const state = stateFor(ctx);
      const request = state?.pending;
      if (!state || !request || !isOwned(state, ctx, request)) return;
      const stopReason = latestAssistantStopReason(event.messages);
      if (ctx.signal?.aborted || stopReason === "aborted") {
        finishRolloverWithoutContinuation(state, ctx, request, "cancelled");
        return;
      }
      if (request.turnStartedAfterRequest && (stopReason === "stop" || stopReason === "toolUse")) {
        request.successfulTurnAfterRequest = true;
      }
    },
    onTurnStart(ctx) {
      const state = stateFor(ctx);
      const request = state?.pending;
      if (state && request && isOwned(state, ctx, request)) request.turnStartedAfterRequest = true;
    },
    onAgentSettled(ctx) {
      const state = stateFor(ctx);
      if (state) settle(state, ctx);
    },
    shutdown(ctx) {
      const state = states.get(ctx.sessionManager);
      if (!state) return;
      state.controller.abort();
      states.delete(ctx.sessionManager);
      if (!isConfigured()) reconcileTools(state, hasDeferredToolRemoval(), ctx);
    },
  };
}
