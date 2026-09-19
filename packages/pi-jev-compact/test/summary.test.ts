import assert from "node:assert/strict";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import type { CompactionResult } from "@earendil-works/pi-coding-agent";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { HistoryUnit, HistoryUnitSource } from "../src/history-units.js";
import { type PiCompactionPreparation, type PiNativeCompactor, summarizeWithPiNativeCompact } from "../src/summary.js";

const model = {
  provider: "provider",
  api: "openai-responses",
  id: "active-model",
  maxTokens: 8_000,
  reasoning: true,
} as Model<Api>;

const usage: Usage = {
  input: 10,
  output: 4,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 14,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function unit(index = 0, content = "selected fact", source: HistoryUnitSource = "history"): HistoryUnit {
  return {
    id: `unit-${index}`,
    order: index,
    kind: "assistant-text",
    source,
    label: "Assistant",
    content,
  };
}

function preparation(): PiCompactionPreparation {
  return {
    firstKeptEntryId: "kept",
    messagesToSummarize: [],
    turnPrefixMessages: [],
    isSplitTurn: false,
    tokensBefore: 12_345,
    previousSummary: "Earlier compressed work",
    fileOps: {
      read: new Set(["src/read.ts"]),
      written: new Set<string>(),
      edited: new Set(["src/changed.ts"]),
    },
    settings: { enabled: true, reserveTokens: 10_000, keepRecentTokens: 20_000 },
  };
}

type SummaryOptions = Parameters<typeof summarizeWithPiNativeCompact>[1];

function summaryOptions(overrides: Partial<SummaryOptions> = {}): SummaryOptions {
  return {
    model,
    thinkingLevel: "high",
    selectedUnits: [unit()],
    preparation: preparation(),
    customInstructions: "Focus on the parser",
    signal: new AbortController().signal,
    isCurrent: () => true,
    ...overrides,
  };
}

function compactResult(summary = "Pi-native compact summary"): CompactionResult {
  return {
    summary,
    firstKeptEntryId: "kept",
    tokensBefore: 12_345,
    usage,
    details: { readFiles: ["src/read.ts"], modifiedFiles: ["src/changed.ts"] },
  };
}

test("passes only JEV-selected context through Pi's native compact function", async () => {
  let observed: Parameters<PiNativeCompactor>[0] | undefined;
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      async getApiKeyAndHeaders(currentModel: unknown) {
        assert.equal(currentModel, model);
        return {
          ok: true,
          apiKey: "provider-key",
          headers: { "x-provider": "header", "x-removed": null },
          env: { PROVIDER_MODE: "test" },
        };
      },
    },
  });
  const runCompact: PiNativeCompactor = async (request) => {
    observed = request;
    return compactResult();
  };

  const result = await summarizeWithPiNativeCompact(
    ctx,
    summaryOptions({
      selectedUnits: [unit(0, "selected history"), unit(1, "selected turn prefix", "turn-prefix")],
    }),
    runCompact,
  );

  assert.equal(observed?.model, model);
  assert.equal(observed?.thinkingLevel, "high");
  assert.equal(observed?.customInstructions, "Focus on the parser");
  assert.equal(observed?.apiKey, "provider-key");
  assert.deepEqual(observed?.headers, { "x-provider": "header" });
  assert.deepEqual(observed?.env, { PROVIDER_MODE: "test" });
  const nativePreparation = observed?.preparation;
  assert.equal(nativePreparation?.firstKeptEntryId, "kept");
  assert.equal(nativePreparation?.tokensBefore, 12_345);
  assert.equal(nativePreparation?.previousSummary, "Earlier compressed work");
  assert.equal(nativePreparation?.settings.reserveTokens, 10_000);
  assert.equal(nativePreparation?.isSplitTurn, true);
  assert.equal(nativePreparation?.messagesToSummarize.length, 1);
  assert.equal(nativePreparation?.turnPrefixMessages.length, 1);
  assert.match(JSON.stringify(nativePreparation?.messagesToSummarize), /selected history/u);
  assert.doesNotMatch(JSON.stringify(nativePreparation?.messagesToSummarize), /selected turn prefix/u);
  assert.match(JSON.stringify(nativePreparation?.turnPrefixMessages), /selected turn prefix/u);
  assert.deepEqual(result, { text: "Pi-native compact summary", usage });
});

test("empty selections still invoke Pi compact with empty selected context", async () => {
  let observed: Parameters<PiNativeCompactor>[0] | undefined;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
    },
  });

  await summarizeWithPiNativeCompact(
    ctx,
    summaryOptions({ selectedUnits: [], customInstructions: undefined }),
    async (request) => {
      observed = request;
      return compactResult("empty-context summary");
    },
  );
  assert.deepEqual(observed?.preparation.messagesToSummarize, []);
  assert.deepEqual(observed?.preparation.turnPrefixMessages, []);
  assert.equal(observed?.preparation.isSplitTurn, false);
});

test("authentication failures do not start Pi compact", async () => {
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: false, error: "provider auth missing" };
      },
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions(), async () => {
      compactCalls += 1;
      return compactResult();
    }),
    /provider auth missing/u,
  );
  assert.equal(compactCalls, 0);
});

test("stale ownership after authentication prevents Pi compact", async () => {
  let current = true;
  let compactCalls = 0;
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        current = false;
        return { ok: true };
      },
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions({ isCurrent: () => current }), async () => {
      compactCalls += 1;
      return compactResult();
    }),
    /ownership changed/u,
  );
  assert.equal(compactCalls, 0);
});

test("Pi compact failures and cancellation remain observable", async () => {
  const { ctx } = createMockContext({
    modelRegistry: {
      async getApiKeyAndHeaders() {
        return { ok: true };
      },
    },
  });
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions(), async () => {
      throw new Error("Pi native compact failed");
    }),
    /Pi native compact failed/u,
  );

  const controller = new AbortController();
  await assert.rejects(
    summarizeWithPiNativeCompact(ctx, summaryOptions({ signal: controller.signal }), async () => {
      controller.abort();
      return compactResult("stale");
    }),
    /abort/iu,
  );
});
