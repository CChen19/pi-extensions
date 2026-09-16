import { randomUUID } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { CompactionEntry, SessionBeforeCompactEvent, SessionEntry } from "@earendil-works/pi-coding-agent";
import { buildContextEntries, sessionEntryToContextMessages } from "@earendil-works/pi-coding-agent";
import { fingerprintMessage } from "./fingerprint.js";

export const CONTEXT_STATE_ENTRY_TYPE = "pi-context-management-state";
export const CONTEXT_CONTRACT_MESSAGE_TYPE = "pi-context-management-contract";
export const CONTEXT_DEACTIVATION_MESSAGE_TYPE = "pi-context-management-deactivation";
export const CONTEXT_DETAILS_KIND = "pi-context-management-window";
export const CONTEXT_VERSION = 1;
const MAX_DETAILS_BYTES = 8 * 1024 * 1024;
const MAX_FINGERPRINTS = 100_000;

export interface ContextLineage {
  firstWindowId: string;
  previousWindowId?: string;
  currentWindowId: string;
}

export interface ContextStateEntryData extends ContextLineage {
  kind: typeof CONTEXT_DETAILS_KIND;
  version: typeof CONTEXT_VERSION;
}

export interface ContextManagementDetails extends ContextLineage {
  kind: typeof CONTEXT_DETAILS_KIND;
  version: typeof CONTEXT_VERSION;
  reason: SessionBeforeCompactEvent["reason"];
  requestId?: string;
  keptMessageFingerprints: string[];
  retryResponseFingerprint?: string;
  createdAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIdentifier(value: unknown): value is string {
  return typeof value === "string" && value.length >= 8 && value.length <= 128;
}

function serializedBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function parseLineage(value: Record<string, unknown>): ContextLineage | undefined {
  if (!isIdentifier(value.firstWindowId) || !isIdentifier(value.currentWindowId)) return undefined;
  if (value.previousWindowId !== undefined && !isIdentifier(value.previousWindowId)) return undefined;
  return {
    firstWindowId: value.firstWindowId,
    ...(typeof value.previousWindowId === "string" ? { previousWindowId: value.previousWindowId } : {}),
    currentWindowId: value.currentWindowId,
  };
}

export function parseContextState(value: unknown): ContextStateEntryData | undefined {
  if (!isRecord(value)) return undefined;
  const lineage = parseLineage(value);
  if (
    !lineage ||
    value.kind !== CONTEXT_DETAILS_KIND ||
    value.version !== CONTEXT_VERSION ||
    value.previousWindowId !== undefined ||
    lineage.firstWindowId !== lineage.currentWindowId
  ) {
    return undefined;
  }
  return { kind: CONTEXT_DETAILS_KIND, version: CONTEXT_VERSION, ...lineage };
}

export function parseContextManagementDetails(value: unknown): ContextManagementDetails | undefined {
  if (!isRecord(value) || value.kind !== CONTEXT_DETAILS_KIND || value.version !== CONTEXT_VERSION) return undefined;
  try {
    if (serializedBytes(value) > MAX_DETAILS_BYTES) return undefined;
  } catch {
    return undefined;
  }
  const lineage = parseLineage(value);
  if (
    !lineage?.previousWindowId ||
    lineage.currentWindowId === lineage.previousWindowId ||
    (value.reason !== "manual" && value.reason !== "threshold" && value.reason !== "overflow") ||
    (value.requestId !== undefined && !isIdentifier(value.requestId)) ||
    !Array.isArray(value.keptMessageFingerprints) ||
    value.keptMessageFingerprints.length > MAX_FINGERPRINTS ||
    !value.keptMessageFingerprints.every(
      (fingerprint) => typeof fingerprint === "string" && /^[a-f0-9]{64}$/.test(fingerprint),
    ) ||
    (value.retryResponseFingerprint !== undefined &&
      (typeof value.retryResponseFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(value.retryResponseFingerprint))) ||
    typeof value.createdAt !== "string" ||
    value.createdAt.length > 64
  ) {
    return undefined;
  }
  return {
    kind: CONTEXT_DETAILS_KIND,
    version: CONTEXT_VERSION,
    ...lineage,
    reason: value.reason,
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
    keptMessageFingerprints: [...value.keptMessageFingerprints],
    ...(typeof value.retryResponseFingerprint === "string"
      ? { retryResponseFingerprint: value.retryResponseFingerprint }
      : {}),
    createdAt: value.createdAt,
  };
}

export function parseContextManagementCompaction(
  entry: Pick<CompactionEntry, "summary" | "details">,
): ContextManagementDetails | undefined {
  const details = parseContextManagementDetails(entry.details);
  return details && entry.summary === contextContract(details) ? details : undefined;
}

export function createInitialContextState(windowId = randomUUID()): ContextStateEntryData {
  return {
    kind: CONTEXT_DETAILS_KIND,
    version: CONTEXT_VERSION,
    firstWindowId: windowId,
    currentWindowId: windowId,
  };
}

export function loadContextLineage(entries: readonly SessionEntry[]): ContextLineage | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === "compaction") {
      const details = parseContextManagementCompaction(entry);
      if (details) return details;
      continue;
    }
    if (entry.type === "custom" && entry.customType === CONTEXT_STATE_ENTRY_TYPE) {
      const state = parseContextState(entry.data);
      if (state) return state;
    }
  }
  return undefined;
}

export function activeContextManagementCompaction(entries: readonly SessionEntry[]):
  | {
      entry: CompactionEntry<ContextManagementDetails>;
      details: ContextManagementDetails;
    }
  | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type !== "compaction") continue;
    const details = parseContextManagementCompaction(entry);
    return details ? { entry: entry as CompactionEntry<ContextManagementDetails>, details } : undefined;
  }
  return undefined;
}

export function contextContract(lineage: ContextLineage): string {
  return [
    `[PI_CONTEXT_MANAGEMENT_WINDOW:${lineage.currentWindowId}]`,
    "Experimental Pi-native context management is active.",
    lineage.previousWindowId
      ? `The previous context window was ${lineage.previousWindowId}.`
      : "This is the first context window in this session.",
    "Use context_management_get_context_remaining to inspect capacity, context_management_recall_context to retrieve older history or notes, and context_management_update_notes to preserve durable working memory.",
    "Call context_management_start_new_context when a fresh context is needed. Important information is not summarized automatically.",
  ].join("\n");
}

export function contextDeactivation(): string {
  return [
    "Experimental Pi-native context management is no longer active.",
    "Its context tools are unavailable. Continue with Pi's active compaction strategy and do not call context_management_start_new_context, context_management_get_context_remaining, context_management_recall_context, or context_management_update_notes.",
  ].join("\n");
}

export function latestContextMode(entries: readonly SessionEntry[]): "active" | "inactive" | undefined {
  let mode: "active" | "inactive" | undefined;
  const leafId = entries.at(-1)?.id ?? null;
  for (const entry of buildContextEntries([...entries], leafId)) {
    if (entry.type === "compaction" && parseContextManagementCompaction(entry)) mode = "active";
    for (const message of sessionEntryToContextMessages(entry)) {
      if (message.role !== "custom") continue;
      if (message.customType === CONTEXT_CONTRACT_MESSAGE_TYPE) mode = "active";
      if (message.customType === CONTEXT_DEACTIVATION_MESSAGE_TYPE && message.content === contextDeactivation()) {
        mode = "inactive";
      }
    }
  }
  return mode;
}

export function createContextContractMessage(lineage: ContextLineage): AgentMessage {
  return {
    role: "custom",
    customType: CONTEXT_CONTRACT_MESSAGE_TYPE,
    content: contextContract(lineage),
    display: false,
    details: {
      kind: CONTEXT_DETAILS_KIND,
      version: CONTEXT_VERSION,
      currentWindowId: lineage.currentWindowId,
    },
    timestamp: 0,
  };
}

export function hasContextContract(messages: readonly AgentMessage[], lineage: ContextLineage): boolean {
  const expected = contextContract(lineage);
  return messages.some(
    (message) =>
      (message.role === "custom" &&
        message.customType === CONTEXT_CONTRACT_MESSAGE_TYPE &&
        message.content === expected) ||
      (message.role === "compactionSummary" && message.summary === expected),
  );
}

export function reconcileContextContract(messages: readonly AgentMessage[], lineage: ContextLineage): AgentMessage[] {
  if (hasContextContract(messages, lineage)) return [...messages];
  return [...messages, createContextContractMessage(lineage)];
}

export function compactionRetainedContext(event: SessionBeforeCompactEvent): {
  keptMessages: AgentMessage[];
  retryResponseFingerprint?: string;
} {
  const leafId = event.branchEntries.at(-1)?.id ?? null;
  const contextEntries = buildContextEntries(event.branchEntries, leafId);
  const keptIndex = contextEntries.findIndex((entry) => entry.id === event.preparation.firstKeptEntryId);
  if (keptIndex < 0) {
    throw new Error("Pi compaction cut point is not present in the active context");
  }
  const keptMessages = contextEntries.slice(keptIndex).flatMap(sessionEntryToContextMessages);
  const lastMessage = keptMessages.at(-1);
  if (
    event.willRetry &&
    lastMessage?.role === "assistant" &&
    (lastMessage.stopReason === "error" || lastMessage.stopReason === "length")
  ) {
    return {
      keptMessages: keptMessages.slice(0, -1),
      retryResponseFingerprint: fingerprintMessage(lastMessage),
    };
  }
  return { keptMessages };
}

export function createContextManagementDetails(input: {
  lineage: ContextLineage;
  keptMessages: readonly AgentMessage[];
  retryResponseFingerprint?: string;
  reason: SessionBeforeCompactEvent["reason"];
  requestId?: string;
  windowId?: string;
  createdAt?: string;
}): ContextManagementDetails {
  const currentWindowId = input.windowId ?? randomUUID();
  const details: ContextManagementDetails = {
    kind: CONTEXT_DETAILS_KIND,
    version: CONTEXT_VERSION,
    firstWindowId: input.lineage.firstWindowId,
    previousWindowId: input.lineage.currentWindowId,
    currentWindowId,
    reason: input.reason,
    ...(input.requestId ? { requestId: input.requestId } : {}),
    keptMessageFingerprints: input.keptMessages.map(fingerprintMessage),
    ...(input.retryResponseFingerprint ? { retryResponseFingerprint: input.retryResponseFingerprint } : {}),
    createdAt: input.createdAt ?? new Date().toISOString(),
  };
  const parsed = parseContextManagementDetails(details);
  if (!parsed) throw new Error("Created invalid context-management details");
  return parsed;
}

function isOlderCompactionSummary(message: AgentMessage, timestamp: number): boolean {
  return (
    message.role === "compactionSummary" &&
    Number.isFinite(message.timestamp) &&
    Number.isFinite(timestamp) &&
    message.timestamp < timestamp
  );
}

export function projectContextManagementContext(
  messages: readonly AgentMessage[],
  entry: CompactionEntry<ContextManagementDetails>,
  details: ContextManagementDetails,
): AgentMessage[] | undefined {
  const expectedSummary = contextContract(details);
  if (entry.summary !== expectedSummary) return undefined;
  const summaryIndex = messages.findIndex(
    (message) => message.role === "compactionSummary" && message.summary === expectedSummary,
  );
  if (summaryIndex < 0) return undefined;
  const timestamp = messages[summaryIndex].timestamp;
  let messageIndex = summaryIndex + 1;
  let fingerprintIndex = 0;
  while (fingerprintIndex < details.keptMessageFingerprints.length) {
    if (messageIndex >= messages.length) return undefined;
    const message = messages[messageIndex];
    if (fingerprintMessage(message) === details.keptMessageFingerprints[fingerprintIndex]) {
      messageIndex += 1;
      fingerprintIndex += 1;
      continue;
    }
    if (isOlderCompactionSummary(message, timestamp)) {
      messageIndex += 1;
      continue;
    }
    return undefined;
  }
  while (messageIndex < messages.length && isOlderCompactionSummary(messages[messageIndex], timestamp)) {
    messageIndex += 1;
  }
  if (
    details.retryResponseFingerprint &&
    messageIndex < messages.length &&
    fingerprintMessage(messages[messageIndex]) === details.retryResponseFingerprint
  ) {
    messageIndex += 1;
  }
  return [...messages.slice(0, summaryIndex + 1), ...messages.slice(messageIndex)];
}
