import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model, ProviderHeaders, Usage } from "@earendil-works/pi-ai";
import { type CompactionResult, compact, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { formatUnits, type HistoryUnit } from "./history-units.js";

const MAX_SELECTED_CONTEXT_BYTES = 512 * 1024;

export type PiCompactionPreparation = Parameters<typeof compact>[0];

export interface ActiveModelSummary {
  text: string;
  usage?: Usage;
}

export interface PiNativeCompactRequest {
  preparation: PiCompactionPreparation;
  model: Model<Api>;
  apiKey?: string;
  headers?: Record<string, string>;
  customInstructions?: string;
  signal: AbortSignal;
  thinkingLevel: ExtensionContext["thinkingLevel"];
  env?: Record<string, string>;
}

export type PiNativeCompactor = (request: PiNativeCompactRequest) => Promise<CompactionResult>;

const compactWithPi: PiNativeCompactor = (request) =>
  compact(
    request.preparation,
    request.model,
    request.apiKey,
    request.headers,
    request.customInstructions,
    request.signal,
    request.thinkingLevel,
    undefined,
    request.env,
  );

function selectedContextMessage(units: readonly HistoryUnit[]): {
  message: AgentMessage;
  bytes: number;
} {
  const text = formatUnits(units);
  return {
    message: {
      role: "user",
      content: [{ type: "text", text }],
      timestamp: Date.now(),
    },
    bytes: Buffer.byteLength(text, "utf8"),
  };
}

function selectedPreparation(
  preparation: PiCompactionPreparation,
  units: readonly HistoryUnit[],
): PiCompactionPreparation {
  const historyUnits = units.filter((unit) => unit.source !== "turn-prefix");
  const turnPrefixUnits = units.filter((unit) => unit.source === "turn-prefix");
  const history = historyUnits.length > 0 ? selectedContextMessage(historyUnits) : undefined;
  const turnPrefix = turnPrefixUnits.length > 0 ? selectedContextMessage(turnPrefixUnits) : undefined;
  const selectedBytes = (history?.bytes ?? 0) + (turnPrefix?.bytes ?? 0);
  if (selectedBytes > MAX_SELECTED_CONTEXT_BYTES) {
    throw new Error("Selected history exceeds the 512 KiB Pi-native compact request limit");
  }
  return {
    ...preparation,
    messagesToSummarize: history ? [history.message] : [],
    turnPrefixMessages: turnPrefix ? [turnPrefix.message] : [],
    isSplitTurn: turnPrefix !== undefined,
  };
}

function stringHeaders(headers: ProviderHeaders | undefined): Record<string, string> | undefined {
  if (!headers) return undefined;
  return Object.fromEntries(Object.entries(headers).filter((entry): entry is [string, string] => entry[1] !== null));
}

function staleError(): DOMException {
  return new DOMException("Compaction ownership changed", "AbortError");
}

export async function summarizeWithPiNativeCompact(
  ctx: ExtensionContext,
  options: {
    model: Model<Api>;
    thinkingLevel: ExtensionContext["thinkingLevel"];
    selectedUnits: readonly HistoryUnit[];
    preparation: PiCompactionPreparation;
    customInstructions?: string;
    signal: AbortSignal;
    isCurrent(): boolean;
  },
  runCompact: PiNativeCompactor = compactWithPi,
): Promise<ActiveModelSummary> {
  const preparation = selectedPreparation(options.preparation, options.selectedUnits);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(options.model);
  options.signal.throwIfAborted();
  if (!options.isCurrent()) throw staleError();
  if (!auth.ok) throw new Error(`Could not authenticate the active model: ${auth.error}`);

  const result = await runCompact({
    preparation,
    model: options.model,
    apiKey: auth.apiKey,
    headers: stringHeaders(auth.headers),
    customInstructions: options.customInstructions,
    signal: options.signal,
    thinkingLevel: options.thinkingLevel,
    env: auth.env,
  });
  options.signal.throwIfAborted();
  if (!options.isCurrent()) throw staleError();
  return { text: result.summary, usage: result.usage };
}
