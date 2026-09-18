import assert from "node:assert/strict";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@earendil-works/pi-coding-agent";
import { test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import { JEV_ENDPOINT, JEV_MODEL } from "../src/client.js";
import jevExtension, {
  formatJevResult,
  type JevDecisionInput,
  type JevDecisionResponse,
  normalizeJevInput,
  normalizeJevResponse,
  requestJevDecision,
  resolveOpenRouterAuthorization,
} from "../src/jev.js";

const decisionInput: JevDecisionInput = {
  state: "Help! My payouts have been failing for 3 days.",
  questions: {
    is_urgent: {
      type: "noul",
      instructions: "Does this message convey urgency?",
      criteria: {
        true: "Explicitly time-sensitive",
        false: "No urgency expressed",
      },
    },
    department: {
      type: "choice",
      instructions: "Which team should handle this?",
      criteria: {
        billing: "Payments, invoicing, refunds",
        technical: "Bugs, outages, integrations",
        sales: "Pricing, upgrades, new accounts",
      },
    },
    frustration: {
      type: "score",
      instructions: "How frustrated is the customer?",
      criteria: ["Calm", "Frustrated", "Very angry"],
    },
  },
};

const decisionResponse: JevDecisionResponse = {
  model: "typesafe/jev-1.13",
  answers: {
    is_urgent: { type: "noul", noul: 0.92 },
    department: {
      type: "choice",
      choice: "billing",
      probabilities: { billing: 0.84, technical: 0.12, sales: 0.04 },
      confidence: 0.8,
    },
    frustration: {
      type: "score",
      score: 1.6,
      legend: { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
      probabilities: { "0": 0.05, "1": 0.3, "2": 0.65 },
      confidence: 0.78,
    },
  },
  usage: { input_tokens: 312, output_tokens: 48 },
};

function officialContext(auth: Record<string, unknown> = { apiKey: "sk-or-secret" }) {
  return createMockContext({
    modelRegistry: {
      getProviderAuth: async () => ({ auth }),
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  }).ctx;
}

function registeredTool(fetchImpl: typeof fetch) {
  const mock = createMockPi();
  jevExtension(mock.pi, { fetch: fetchImpl });
  const tool = mock.tools.find((candidate) => candidate.name === "jev_decide");
  assert.ok(tool);
  return tool as {
    name: string;
    description: string;
    promptSnippet: string;
    promptGuidelines: string[];
    parameters: unknown;
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: ReturnType<typeof officialContext>,
    ): Promise<{ content: Array<{ type: "text"; text: string }>; details: { truncated: boolean } }>;
  };
}

test("registers one stable Jev decision tool with all supported question types", () => {
  const tool = registeredTool(vi.fn<typeof fetch>());
  assert.equal(tool.name, "jev_decide");
  assert.match(tool.description, /noul, choice, and score/);
  assert.match(tool.promptSnippet, /typed noul, choice, or score/);
  assert.match(tool.promptGuidelines[0] ?? "", /Use jev_decide/);

  const schema = JSON.stringify(tool.parameters);
  assert.match(schema, /"enum":\["noul","choice","score"\]/);
  assert.match(schema, /"minProperties":1/);

  const second = registeredTool(vi.fn<typeof fetch>());
  assert.deepEqual(
    {
      name: second.name,
      description: second.description,
      promptSnippet: second.promptSnippet,
      promptGuidelines: second.promptGuidelines,
      parameters: second.parameters,
    },
    {
      name: tool.name,
      description: tool.description,
      promptSnippet: tool.promptSnippet,
      promptGuidelines: tool.promptGuidelines,
      parameters: tool.parameters,
    },
  );
});

test("tool sends a fixed-model request with Pi-resolved OpenRouter auth and returns validated JSON", async () => {
  const controller = new AbortController();
  const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
    assert.equal(input, JEV_ENDPOINT);
    assert.equal(init?.method, "POST");
    assert.equal(init?.signal, controller.signal);
    assert.deepEqual(init?.headers, {
      Authorization: "Bearer sk-or-secret",
      "Content-Type": "application/json",
    });
    assert.deepEqual(JSON.parse(String(init?.body)), {
      model: JEV_MODEL,
      state: decisionInput.state,
      questions: decisionInput.questions,
    });
    return new Response(JSON.stringify(decisionResponse), { status: 200 });
  });
  const tool = registeredTool(fetchImpl);

  const result = await tool.execute("call-1", decisionInput, controller.signal, undefined, officialContext());

  assert.equal(fetchImpl.mock.calls.length, 1);
  assert.deepEqual(JSON.parse(result.content[0]?.text ?? ""), decisionResponse);
  assert.equal(result.details.truncated, false);
});

test("resolved Authorization header takes precedence over the API key", async () => {
  const ctx = officialContext({
    apiKey: "unused-key",
    headers: { authorization: "Bearer runtime-token" },
  });
  assert.deepEqual(await resolveOpenRouterAuthorization(ctx), {
    authorization: "Bearer runtime-token",
    secrets: ["unused-key", "Bearer runtime-token", "runtime-token"],
  });
});

test("authentication fails closed before network access", async () => {
  const missing = createMockContext({
    modelRegistry: {
      getProviderAuth: async () => undefined,
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  }).ctx;
  await assert.rejects(() => resolveOpenRouterAuthorization(missing), /not configured/);
  const fetchImpl = vi.fn<typeof fetch>();
  await assert.rejects(
    () => registeredTool(fetchImpl).execute("call-1", decisionInput, new AbortController().signal, undefined, missing),
    /not configured/,
  );
  assert.equal(fetchImpl.mock.calls.length, 0);

  for (const modelRegistry of [
    {
      getProviderAuth: async () => ({ auth: { apiKey: "secret", baseUrl: "https://proxy.example/v1" } }),
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
    {
      getProviderAuth: async () => ({ auth: { apiKey: "secret" } }),
      getProvider: () => ({ baseUrl: "https://proxy.example/v1" }),
    },
  ]) {
    const ctx = createMockContext({ modelRegistry }).ctx;
    await assert.rejects(() => resolveOpenRouterAuthorization(ctx), /proxy base URL/);
  }

  const incompatible = officialContext({ headers: { Authorization: "Basic secret" } });
  await assert.rejects(() => resolveOpenRouterAuthorization(incompatible), /Bearer credential/);
});

test("normalizes structured questions and enforces per-type criteria", () => {
  const structured = normalizeJevInput({
    state: { ticket: ["failed", 3, true, null] },
    questions: {
      risk: {
        type: "noul",
        instructions: { question: "Is this risky?" },
      },
      route: {
        type: "choice",
        instructions: ["Choose", "a route"],
        criteria: { allow: null, review: { when: "uncertain" } },
      },
      severity: {
        type: "score",
        instructions: "Rate severity",
        criteria: ["low", { level: "medium" }, ["high", "urgent"]],
      },
    },
  });
  assert.deepEqual(structured.state, { ticket: ["failed", 3, true, null] });

  const invalidCases: [unknown, RegExp][] = [
    [{ state: 1, questions: { q: { type: "noul", instructions: "Q" } } }, /state must be/],
    [{ state: "x", questions: {} }, /at least one/],
    [
      {
        state: "x",
        questions: { q: { type: "noul", instructions: "Q", criteria: { true: "yes" } } },
      },
      /keys must exactly match/,
    ],
    [
      {
        state: "x",
        questions: { q: { type: "choice", instructions: "Q", criteria: { only: null } } },
      },
      /between 2 and 255/,
    ],
    [
      {
        state: "x",
        questions: { q: { type: "score", instructions: "Q", criteria: ["only"] } },
      },
      /between 2 and 10/,
    ],
    [
      {
        state: "x",
        questions: { q: { type: "unknown", instructions: "Q" } },
      },
      /must be noul, choice, or score/,
    ],
  ];
  for (const [value, pattern] of invalidCases) assert.throws(() => normalizeJevInput(value), pattern);
});

test("rejects non-JSON and circular structured values", () => {
  assert.throws(
    () =>
      normalizeJevInput({
        state: { bad: Number.NaN },
        questions: { q: { type: "noul", instructions: "Q" } },
      }),
    /finite JSON numbers/,
  );
  const circular: Record<string, unknown> = {};
  circular.self = circular;
  assert.throws(
    () => normalizeJevInput({ state: circular, questions: { q: { type: "noul", instructions: "Q" } } }),
    /circular data/,
  );
});

test("normalizes OpenRouter token aliases and optional cost usage", () => {
  const response = structuredClone(decisionResponse) as unknown as Record<string, unknown>;
  response.usage = { prompt_tokens: 12, completion_tokens: 3, cost: 0.001 };
  assert.deepEqual(normalizeJevResponse(response, decisionInput).usage, {
    input_tokens: 12,
    output_tokens: 3,
    cost: 0.001,
  });
});

test("response validation covers answer identity, ranges, distributions, and selected options", () => {
  const cases: [string, (response: JevDecisionResponse) => void, RegExp][] = [
    [
      "missing answer",
      (response) => {
        delete response.answers.is_urgent;
      },
      /keys must exactly match/,
    ],
    [
      "mismatched type",
      (response) => {
        response.answers.is_urgent = { type: "choice", choice: "x", probabilities: { x: 1 }, confidence: 1 };
      },
      /does not match/,
    ],
    [
      "noul outside range",
      (response) => {
        response.answers.is_urgent = { type: "noul", noul: 1.1 };
      },
      /between 0 and 1/,
    ],
    [
      "unknown choice",
      (response) => {
        const answer = response.answers.department;
        if (answer?.type === "choice") answer.choice = "unknown";
      },
      /requested options/,
    ],
    [
      "missing probability",
      (response) => {
        const answer = response.answers.department;
        if (answer?.type === "choice") delete answer.probabilities.sales;
      },
      /keys must exactly match/,
    ],
    [
      "invalid probability sum",
      (response) => {
        const answer = response.answers.department;
        if (answer?.type === "choice") answer.probabilities = { billing: 0.2, technical: 0.2, sales: 0.2 };
      },
      /sum to 1/,
    ],
    [
      "score outside levels",
      (response) => {
        const answer = response.answers.frustration;
        if (answer?.type === "score") answer.score = 3;
      },
      /between 0 and 2/,
    ],
    [
      "legend mismatch",
      (response) => {
        const answer = response.answers.frustration;
        if (answer?.type === "score") delete answer.legend["2"];
      },
      /keys must exactly match/,
    ],
  ];

  for (const [name, mutate, pattern] of cases) {
    const response = structuredClone(decisionResponse);
    mutate(response);
    assert.throws(() => normalizeJevResponse(response, decisionInput), pattern, name);
  }
});

test("HTTP failures are bounded, terminal-safe, and redact credentials", async () => {
  const secret = "sk-or-sensitive";
  const responseText = JSON.stringify({
    error: { message: `bad ${secret}\u001b]8;;https://evil.example\u0007link` },
  });
  const fetchImpl = vi.fn<typeof fetch>(async () => new Response(responseText, { status: 422 }));

  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        { authorization: `Bearer ${secret}`, secrets: [secret, `Bearer ${secret}`] },
        undefined,
        fetchImpl,
      ),
    (error: Error) => {
      assert.match(error.message, /failed \(422\)/);
      assert.match(error.message, /\[redacted\]/);
      assert.equal(error.message.includes(secret), false);
      assert.equal(error.message.includes("\u001b"), false);
      assert.ok(Buffer.byteLength(error.message, "utf8") < 2300);
      return true;
    },
  );
});

test("non-JSON, invalid, oversized, and oversized-request responses fail observably", async () => {
  const auth = { authorization: "Bearer secret", secrets: ["secret"] };
  await assert.rejects(
    () => requestJevDecision(decisionInput, auth, undefined, async () => new Response("not json", { status: 200 })),
    /non-JSON response/,
  );
  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        auth,
        undefined,
        async () => new Response(JSON.stringify({ model: "jev", answers: {} }), { status: 200 }),
      ),
    /invalid response/,
  );
  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        auth,
        undefined,
        async () => new Response("x".repeat(1024 * 1024 + 1), { status: 200 }),
      ),
    /response exceeds the (?:1|1\.0)MB/,
  );
  const fetchImpl = vi.fn<typeof fetch>();
  await assert.rejects(
    () =>
      requestJevDecision(
        { state: "x".repeat(1024 * 1024), questions: decisionInput.questions },
        auth,
        undefined,
        fetchImpl,
      ),
    /request exceeds the (?:1|1\.0)MB/,
  );
  assert.equal(fetchImpl.mock.calls.length, 0);
});

test("fetch cancellation is preserved", async () => {
  const controller = new AbortController();
  controller.abort();
  const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
    assert.equal(init?.signal, controller.signal);
    throw new DOMException("cancelled", "AbortError");
  });
  await assert.rejects(
    () =>
      requestJevDecision(
        decisionInput,
        { authorization: "Bearer secret", secrets: ["secret"] },
        controller.signal,
        fetchImpl,
      ),
    (error: Error) => error.name === "AbortError",
  );
});

test("model-visible output is terminal-safe and bounded", () => {
  const safeResponse = structuredClone(decisionResponse);
  safeResponse.model = "jev\u202eunsafe";
  const safeResult = formatJevResult(safeResponse);
  assert.equal((safeResult.content[0]?.text ?? "").includes("\u202e"), false);
  assert.match(safeResult.content[0]?.text ?? "", /\\u202e/);
  assert.equal(JSON.parse(safeResult.content[0]?.text ?? "").model, safeResponse.model);

  const answers: JevDecisionResponse["answers"] = {};
  for (let index = 0; index < 2500; index += 1) {
    answers[`question_${index}`] = { type: "noul", noul: 0.5 };
  }
  const bounded = formatJevResult({ model: "jev", answers });
  const text = bounded.content[0]?.text ?? "";
  assert.ok(Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES);
  assert.ok(text.split("\n").length <= DEFAULT_MAX_LINES);
  assert.match(text, /Jev output truncated/);
  assert.equal(bounded.details.truncated, true);
});
