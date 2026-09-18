import assert from "node:assert/strict";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { test } from "vitest";
import { fingerprintMessage } from "../src/fingerprint.js";

function message(argumentsValue: unknown): AgentMessage {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id: "call", name: "foreign_tool", arguments: argumentsValue as never }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 1,
  };
}

test("fingerprints equivalent object key orders deterministically", () => {
  assert.equal(
    fingerprintMessage(message({ beta: 2, alpha: { delta: 4, gamma: 3 } })),
    fingerprintMessage(message({ alpha: { gamma: 3, delta: 4 }, beta: 2 })),
  );
});

test("rejects deeply nested fingerprint input with an explicit bound", () => {
  let nested: unknown = "value";
  for (let index = 0; index < 20_000; index += 1) nested = [nested];
  assert.throws(() => fingerprintMessage(message(nested)), /fingerprint exceeded its traversal limit/);
});

test("rejects wide fingerprint input before traversing every element", () => {
  let reads = 0;
  const wide = new Proxy([], {
    get(target, property, receiver) {
      if (property === "length") return 5_000_000;
      if (typeof property === "string" && /^\d+$/.test(property)) reads += 1;
      return Reflect.get(target, property, receiver);
    },
  });
  assert.throws(() => fingerprintMessage(message(wide)), /fingerprint exceeded its traversal limit/);
  assert.equal(reads, 0);
});
