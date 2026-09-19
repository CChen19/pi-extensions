import assert from "node:assert/strict";
import type { Api, Model, Usage } from "@earendil-works/pi-ai";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { HistoryUnit } from "../src/history-units.js";
import { summarizeWithActiveModel } from "../src/summary.js";

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

function unit(index = 0, content = "selected fact"): HistoryUnit {
  return {
    id: `unit-${index}`,
    order: index,
    kind: "assistant-text",
    source: "history",
    label: "Assistant",
    content,
  };
}

function response(overrides: Record<string, unknown> = {}) {
  return {
    role: "assistant",
    content: [{ type: "text", text: "## Goal\nContinue safely" }],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage,
    stopReason: "stop",
    timestamp: Date.now(),
    ...overrides,
  };
}

test("uses the exact active model, thinking level, prior summary, and custom instructions", async () => {
  let observedModel: unknown;
  let observedContext: unknown;
  let observedOptions: Record<string, unknown> | undefined;
  const { ctx } = createMockContext({
    model,
    thinkingLevel: "high",
    modelRegistry: {
      async complete(currentModel: unknown, context: unknown, options: Record<string, unknown>) {
        observedModel = currentModel;
        observedContext = context;
        observedOptions = options;
        return response();
      },
    },
  });
  const result = await summarizeWithActiveModel(ctx, {
    model,
    thinkingLevel: "high",
    selectedUnits: [unit()],
    previousSummary: "Earlier compressed work",
    customInstructions: "Focus on the parser",
    reserveTokens: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(observedModel, model);
  assert.equal((observedContext as { tools?: unknown }).tools, undefined);
  const prompt = JSON.stringify(observedContext);
  assert.match(prompt, /selected fact/u);
  assert.match(prompt, /Earlier compressed work/u);
  assert.match(prompt, /Focus on the parser/u);
  assert.equal(observedOptions?.reasoning, "high");
  assert.equal(observedOptions?.cacheRetention, "none");
  assert.equal(observedOptions?.maxTokens, 8_000);
  assert.equal(typeof observedOptions?.sessionId, "string");
  assert.deepEqual(result, { text: "## Goal\nContinue safely", usage });
});

test("non-reasoning models omit reasoning and use the reserve output limit", async () => {
  const plainModel = { ...model, reasoning: false, maxTokens: 20_000 } as Model<Api>;
  let observedOptions: Record<string, unknown> | undefined;
  const { ctx } = createMockContext({
    model: plainModel,
    modelRegistry: {
      async complete(_model: unknown, _context: unknown, options: Record<string, unknown>) {
        observedOptions = options;
        return response();
      },
    },
  });
  await summarizeWithActiveModel(ctx, {
    model: plainModel,
    thinkingLevel: "high",
    selectedUnits: [unit()],
    reserveTokens: 10_000,
    signal: new AbortController().signal,
  });
  assert.equal(observedOptions?.reasoning, undefined);
  assert.equal(observedOptions?.maxTokens, 8_000);
});

test("empty selections preserve only the prior compressed summary without a model request", async () => {
  let calls = 0;
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      async complete() {
        calls += 1;
        return response();
      },
    },
  });
  assert.deepEqual(
    await summarizeWithActiveModel(ctx, {
      model,
      thinkingLevel: "off",
      selectedUnits: [],
      previousSummary: "prior",
      reserveTokens: 1_000,
      signal: new AbortController().signal,
    }),
    { text: "prior" },
  );
  assert.equal(calls, 0);
});

test("empty selections still honor explicit compaction instructions", async () => {
  let observedContext: unknown;
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      async complete(_model: unknown, context: unknown) {
        observedContext = context;
        return response();
      },
    },
  });
  const result = await summarizeWithActiveModel(ctx, {
    model,
    thinkingLevel: "off",
    selectedUnits: [],
    previousSummary: "prior",
    customInstructions: "Focus on unresolved tests",
    reserveTokens: 1_000,
    signal: new AbortController().signal,
  });
  assert.match(JSON.stringify(observedContext), /prior/u);
  assert.match(JSON.stringify(observedContext), /Focus on unresolved tests/u);
  assert.deepEqual(result, { text: "## Goal\nContinue safely", usage });
});

test.each([
  ["length", response({ stopReason: "length" }), /token limit/u],
  ["provider error", response({ stopReason: "error", errorMessage: "bad" }), /failed: bad/u],
  [
    "tool call",
    response({ content: [{ type: "toolCall", id: "1", name: "read", arguments: {} }], stopReason: "stop" }),
    /attempted to call/u,
  ],
  ["empty", response({ content: [{ type: "text", text: "  " }] }), /no text/u],
  ["unexpected stop", response({ stopReason: "aborted" }), /stopped unexpectedly/u],
])("rejects %s summary responses", async (_label, assistantResponse, pattern) => {
  const { ctx } = createMockContext({
    model,
    modelRegistry: { complete: async () => assistantResponse },
  });
  await assert.rejects(
    summarizeWithActiveModel(ctx, {
      model,
      thinkingLevel: "off",
      selectedUnits: [unit()],
      reserveTokens: 1_000,
      signal: new AbortController().signal,
    }),
    pattern,
  );
});

test("cancellation after provider completion prevents publication", async () => {
  const controller = new AbortController();
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      async complete() {
        controller.abort();
        return response();
      },
    },
  });
  await assert.rejects(
    summarizeWithActiveModel(ctx, {
      model,
      thinkingLevel: "off",
      selectedUnits: [unit()],
      reserveTokens: 1_000,
      signal: controller.signal,
    }),
    /abort/iu,
  );
});
