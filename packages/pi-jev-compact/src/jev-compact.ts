import type { Api, Model } from "@earendil-works/pi-ai";
import type {
  ExtensionAPI,
  ExtensionContext,
  SessionBeforeCompactEvent,
  SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { createTypeSafeClient, evaluateHistoryUnits, type TypeSafeClientFactory } from "./evaluator.js";
import {
  appendFileOperations,
  assertRetainedUnitsBounded,
  combineHistoryUnits,
  composeCompactionSummary,
  fileOperationLists,
  JEV_COMPACT_DETAILS_KIND,
  JEV_COMPACT_DETAILS_VERSION,
  type JevCompactDetails,
  MAX_COMPACTION_DETAILS_BYTES,
  MAX_COMPACTION_SUMMARY_BYTES,
  parseJevCompactDetails,
} from "./history-units.js";
import { showJevCompactMenu } from "./menu.js";
import { createJevCompactSettingsRuntime, type JevCompactSettingsRuntime } from "./settings.js";
import { summarizeWithActiveModel } from "./summary.js";

const STATUS_KEY = "jev-compact";
type Summarize = typeof summarizeWithActiveModel;

export interface JevCompactExtensionOptions {
  settingsRuntime?: JevCompactSettingsRuntime;
  clientFactory?: TypeSafeClientFactory;
  summarize?: Summarize;
}

function modelIdentity(model: Model<Api> | undefined): string | undefined {
  return model ? `${model.provider}\0${model.api}\0${model.id}` : undefined;
}

function latestPriorDetails(entries: readonly SessionEntry[]): JevCompactDetails | undefined {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry?.type !== "compaction") continue;
    return parseJevCompactDetails(entry.details);
  }
  return undefined;
}

function safeError(error: unknown, apiKey?: string): string {
  let message = error instanceof Error ? error.message : String(error);
  if (apiKey) message = message.split(apiKey).join("[REDACTED]");
  return [...message]
    .filter((character) => {
      const code = character.codePointAt(0) ?? 0;
      return code === 0x0a || (code >= 0x20 && code !== 0x7f && !(code >= 0x80 && code <= 0x9f));
    })
    .join("")
    .slice(0, 2_000);
}

function sessionOwned(
  ctx: ExtensionContext,
  generation: number,
  currentGeneration: () => number,
  sessionId: string,
  ownerSignal: AbortSignal,
): boolean {
  return !ownerSignal.aborted && generation === currentGeneration() && ctx.sessionManager.getSessionId() === sessionId;
}

async function compactWithJev(
  event: SessionBeforeCompactEvent,
  ctx: ExtensionContext,
  options: {
    runtime: JevCompactSettingsRuntime;
    clientFactory: TypeSafeClientFactory;
    summarize: Summarize;
    generation: number;
    currentGeneration(): number;
    ownerSignal: AbortSignal;
  },
) {
  const settingsState = options.runtime.get();
  const apiKey = settingsState.kind === "loaded" ? settingsState.settings.apiKey : undefined;
  const model = ctx.model;
  const thinkingLevel = ctx.thinkingLevel;
  if (!apiKey || !model) return undefined;

  const sessionId = ctx.sessionManager.getSessionId();
  const identity = modelIdentity(model);
  const signal = AbortSignal.any([event.signal, options.ownerSignal]);
  const isCurrent = () =>
    sessionOwned(ctx, options.generation, options.currentGeneration, sessionId, options.ownerSignal) &&
    !signal.aborted &&
    modelIdentity(ctx.model) === identity &&
    options.runtime.get().settings.apiKey === apiKey;
  if (!isCurrent()) return { cancel: true as const };

  if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, "JEV evaluating history…");
  try {
    const prior = latestPriorDetails(event.branchEntries);
    const units = combineHistoryUnits(
      prior?.retainedUnits ?? [],
      event.preparation.messagesToSummarize,
      event.preparation.turnPrefixMessages,
    );
    const evaluation = await evaluateHistoryUnits(options.clientFactory(apiKey), units, signal);
    if (!isCurrent()) return { cancel: true as const };

    const selectedUnits = evaluation.decisions
      .filter((decision) => decision.summarize)
      .map((decision) => decision.unit);
    const retainedUnits = evaluation.decisions
      .filter((decision) => !decision.summarize)
      .map((decision) => decision.unit);
    assertRetainedUnitsBounded(retainedUnits);

    if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, `Summarizing ${selectedUnits.length} JEV-selected units…`);
    const generated = await options.summarize(ctx, {
      model,
      thinkingLevel,
      selectedUnits,
      previousSummary: prior?.compressedSummary ?? event.preparation.previousSummary,
      customInstructions: event.customInstructions,
      reserveTokens: event.preparation.settings.reserveTokens,
      signal,
    });
    if (!isCurrent()) return { cancel: true as const };

    const { readFiles, modifiedFiles } = fileOperationLists(event.preparation.fileOps);
    const summary = appendFileOperations(
      composeCompactionSummary(generated.text, retainedUnits),
      readFiles,
      modifiedFiles,
    );
    if (Buffer.byteLength(summary, "utf8") > MAX_COMPACTION_SUMMARY_BYTES) {
      throw new Error("Final JEV compaction summary exceeds the 512 KiB limit");
    }
    const details: JevCompactDetails = {
      kind: JEV_COMPACT_DETAILS_KIND,
      version: JEV_COMPACT_DETAILS_VERSION,
      compressedSummary: generated.text,
      retainedUnits,
      evaluator: {
        model: "jev-latest",
        evaluated: evaluation.decisions.length,
        summarized: selectedUnits.length,
        retained: retainedUnits.length,
        inputTokens: evaluation.usage.inputTokens,
        outputTokens: evaluation.usage.outputTokens,
      },
      readFiles,
      modifiedFiles,
    };
    if (Buffer.byteLength(JSON.stringify(details), "utf8") > MAX_COMPACTION_DETAILS_BYTES) {
      throw new Error("JEV compaction details exceed the 768 KiB limit");
    }
    return {
      compaction: {
        summary,
        firstKeptEntryId: event.preparation.firstKeptEntryId,
        tokensBefore: event.preparation.tokensBefore,
        usage: generated.usage,
        details,
      },
    };
  } catch (error) {
    if (signal.aborted || !isCurrent()) return { cancel: true as const };
    if (ctx.hasUI) {
      ctx.ui.notify(`JEV compaction failed; using Pi-native compaction. ${safeError(error, apiKey)}`, "warning");
    }
    return undefined;
  } finally {
    if (sessionOwned(ctx, options.generation, options.currentGeneration, sessionId, options.ownerSignal) && ctx.hasUI) {
      ctx.ui.setStatus(STATUS_KEY, undefined);
    }
  }
}

export function createJevCompactExtension(options: JevCompactExtensionOptions = {}): (pi: ExtensionAPI) => void {
  return (pi) => {
    const runtime = options.settingsRuntime ?? createJevCompactSettingsRuntime();
    const clientFactory = options.clientFactory ?? createTypeSafeClient;
    const summarize = options.summarize ?? summarizeWithActiveModel;
    let generation = 0;
    let sessionController = new AbortController();

    pi.registerCommand("jev-compact", {
      description: "Configure JEV-guided compaction",
      handler: async (args, ctx) => {
        if (args.trim()) throw new Error("Usage: /jev-compact");
        const ownerGeneration = generation;
        const ownerController = sessionController;
        await showJevCompactMenu(runtime, ctx, {
          signal: ownerController.signal,
          isCurrent: () => ownerGeneration === generation && !ownerController.signal.aborted,
        });
      },
    });

    pi.on("session_start", async (_event, ctx) => {
      sessionController.abort();
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      sessionController = new AbortController();
      generation += 1;
      const ownerGeneration = generation;
      const sessionId = ctx.sessionManager.getSessionId();
      try {
        const state = await runtime.reload(sessionController.signal);
        if (
          sessionController.signal.aborted ||
          ownerGeneration !== generation ||
          ctx.sessionManager.getSessionId() !== sessionId
        ) {
          return;
        }
        if (state.kind === "invalid" && ctx.hasUI) {
          ctx.ui.notify(
            `Invalid pi-jev-compact.json; Pi-native compaction remains active. ${safeError(state.issue ?? "unknown validation error")}`,
            "warning",
          );
        }
      } catch (error) {
        if (sessionController.signal.aborted || ownerGeneration !== generation) return;
        if (ctx.hasUI) {
          ctx.ui.notify(
            `Could not load pi-jev-compact.json; Pi-native compaction remains active. ${safeError(error)}`,
            "warning",
          );
        }
      }
    });

    pi.on("session_before_compact", (event, ctx) =>
      compactWithJev(event, ctx, {
        runtime,
        clientFactory,
        summarize,
        generation,
        currentGeneration: () => generation,
        ownerSignal: sessionController.signal,
      }),
    );

    pi.on("session_shutdown", async (_event, ctx) => {
      generation += 1;
      sessionController.abort();
      if (ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
      await runtime.flush();
    });
  };
}

export default createJevCompactExtension();
