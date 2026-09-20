import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import type { UsageReport } from "../src/index.js";
import {
  awaitWithDeadline,
  fingerprintResolvedAuth,
  formatUsageStatusline,
  queryProviderUsage,
  redactUsageError,
  resolveUsageAuth,
  runWithConcurrency,
  SUPPORTED_ADAPTERS,
  sanitizeDisplayText,
  UsageCache,
} from "../src/index.js";
import {
  OPENROUTER_CREDENTIALS_FILE_ENV,
  OPENROUTER_MANAGEMENT_API_KEY_ENV,
} from "../src/providers/openrouter-auth.js";

const report: UsageReport = {
  providerId: "openrouter",
  providerName: "OpenRouter",
  capturedAt: 1,
  source: "openrouter-key",
  semantics: { kind: "api-key", label: "API-key spend limits" },
  buckets: [],
  metrics: [{ id: "usage-total", label: "All-time usage", value: 1, unit: "usd" }],
};

test("credential fingerprints are process-salted, deterministic, and do not expose secrets", () => {
  const auth = {
    apiKey: "sk-secret",
    headers: { Authorization: "Bearer header-secret", "X-Test": "value" },
  };
  const first = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
  const same = fingerprintResolvedAuth(auth, Buffer.alloc(32, 1));
  const anotherProcess = fingerprintResolvedAuth(auth, Buffer.alloc(32, 2));
  const anotherAccount = fingerprintResolvedAuth({ apiKey: "different" }, Buffer.alloc(32, 1));

  assert.equal(first, same);
  assert.notEqual(first, anotherProcess);
  assert.notEqual(first, anotherAccount);
  assert.doesNotMatch(first, /secret/);
});

test("usage cache isolates identities, expires entries, and remains bounded", () => {
  const cache = new UsageCache(300_000, 4);
  cache.set("openrouter", "account-a", report, 1_000);

  assert.equal(cache.get("openrouter", "account-a", 1_001), report);
  assert.equal(cache.get("openrouter", "account-b", 1_001), undefined);
  assert.equal(cache.get("openai-codex", "account-a", 1_001), undefined);
  assert.equal(cache.get("openrouter", "account-a", 301_001), undefined);
  assert.equal(cache.size, 0);

  for (let index = 0; index < 10; index += 1) {
    cache.set("openrouter", `account-${index}`, report, 400_000 + index);
  }
  assert.equal(cache.size, 4);
  assert.equal(cache.get("openrouter", "account-0", 400_020), undefined);
  assert.equal(cache.get("openrouter", "account-9", 400_020), report);
  cache.clearProvider("openrouter");
  assert.equal(cache.size, 0);
});

test("usage cache deletion preserves other credentials and providers", () => {
  const cache = new UsageCache(300_000);
  cache.set("zai", "account-a", report, 1_000);
  cache.set("zai", "account-b", report, 1_000);
  cache.set("zai-coding-cn", "account-a", report, 1_000);
  cache.delete("zai", "account-a");
  cache.delete("zai", "account-a");
  assert.equal(cache.get("zai", "account-a", 1_001), undefined);
  assert.equal(cache.get("zai", "account-b", 1_001), report);
  assert.equal(cache.get("zai-coding-cn", "account-a", 1_001), report);
});

test("bounded orchestration retains stable partial results and respects cancellation", async () => {
  let active = 0;
  let maximumActive = 0;
  const controller = new AbortController();
  const results = await runWithConcurrency(
    [1, 2, 3, 4],
    2,
    async (value) => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise<void>((resolve) => setTimeout(resolve, value === 1 ? 10 : 1));
      active -= 1;
      if (value === 3) throw new Error("provider failed");
      return value * 2;
    },
    controller.signal,
  );

  assert.equal(maximumActive, 2);
  assert.deepEqual(
    results.map((result) => (result.status === "fulfilled" ? ["ok", result.value] : ["error", result.reason.message])),
    [
      ["ok", 2],
      ["ok", 4],
      ["error", "provider failed"],
      ["ok", 8],
    ],
  );

  controller.abort();
  await assert.rejects(() => runWithConcurrency([1], 2, async (value) => value, controller.signal), /aborted/i);
});

test("end-to-end deadline bounds slow work and preserves caller cancellation", async () => {
  const never = new Promise<never>(() => undefined);
  const controller = new AbortController();
  await assert.rejects(
    () => awaitWithDeadline(never, controller.signal, 5, "resolving auth"),
    (error: unknown) => error instanceof Error && error.name === "TimeoutError",
  );

  const cancelled = new AbortController();
  const pending = awaitWithDeadline(never, cancelled.signal, 1_000, "resolving auth");
  cancelled.abort();
  await assert.rejects(
    () => pending,
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("runtime auth rejects proxy origins and forwards only adapter-approved headers", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const proxyModel = {
    id: "proxy-model",
    name: "Proxy",
    provider: "openrouter",
    baseUrl: "https://proxy.example.test/v1",
  };
  const { ctx: proxyContext } = createMockContext({
    model: proxyModel,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "proxy-key" } }),
      getAvailable: () => [proxyModel],
      getAll: () => [proxyModel],
    },
  });
  await assert.rejects(() => resolveUsageAuth(proxyContext, adapter), /custom.*base URL|official/iu);

  const officialModel = { ...proxyModel, baseUrl: "https://openrouter.ai/api/v1" };
  const { ctx: effectiveProxyContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
      getProviderAuth: async () => ({
        auth: { apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" },
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  await assert.rejects(() => resolveUsageAuth(effectiveProxyContext, adapter), /proxy-resolved.*official/iu);

  const { ctx: providerOverrideContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://proxy.example.test/v1" }),
      getProviderAuth: async () => ({ auth: { apiKey: "must-not-send" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  await assert.rejects(
    () => resolveUsageAuth(providerOverrideContext, adapter),
    /overridden provider credential.*official/iu,
  );

  const { ctx: officialContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
      getProviderAuth: async () => ({
        auth: {
          apiKey: "official-key",
          headers: { "X-Proxy-Secret": "must-not-leak", "X-Title": "private-title" },
        },
        env: { OPENROUTER_ACCOUNT: "account-a" },
        source: "test credential",
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const auth = await resolveUsageAuth(officialContext, adapter, undefined, undefined, undefined, {});
  assert.deepEqual(auth?.headers, { Authorization: "Bearer official-key" });
  assert.deepEqual(auth?.auth, {
    apiKey: "official-key",
    headers: { "X-Proxy-Secret": "must-not-leak", "X-Title": "private-title" },
  });
  assert.deepEqual(auth?.env, { OPENROUTER_ACCOUNT: "account-a" });
  assert.equal(auth?.source, "test credential");
  assert.equal(auth?.effectiveBaseUrl, "https://openrouter.ai/api/v1");

  const { ctx: rotatedEnvContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
      getProviderAuth: async () => ({
        auth: { apiKey: "official-key" },
        env: { OPENROUTER_ACCOUNT: "account-b" },
        source: "test credential",
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const rotatedEnv = await resolveUsageAuth(rotatedEnvContext, adapter, undefined, undefined, undefined, {});
  assert.notEqual(rotatedEnv?.fingerprint, auth?.fingerprint);

  const { ctx: modelScopedContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "provider-default-key",
        headers: {
          Authorization: "Bearer current-model-key",
          "X-Model-Secret": "must-not-leak",
        },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const modelScopedAuth = await resolveUsageAuth(modelScopedContext, adapter, undefined, undefined, undefined, {});
  assert.deepEqual(modelScopedAuth?.headers, { Authorization: "Bearer current-model-key" });
  assert.ok(modelScopedAuth?.secrets.includes("Bearer current-model-key"));
  assert.ok(modelScopedAuth?.secrets.includes("must-not-leak"));

  const { ctx: modelKeyContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "current-model-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "provider-default-key" } }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const modelKeyAuth = await resolveUsageAuth(modelKeyContext, adapter, undefined, undefined, undefined, {});
  assert.deepEqual(modelKeyAuth?.headers, { Authorization: "Bearer current-model-key" });
});

test("OpenRouter resolves management credentials from a configured file during auth resolution", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-auth-"));
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ managementApiKey: "file-secret" }));
  await chmod(credentialsPath, 0o600);
  t.onTestFinished(async () => {
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true, force: true });
  });
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, credentialsPath);

  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const model = {
    id: "test-model",
    name: "Test model",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "inference-secret", baseUrl: model.baseUrl } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });

  const auth = await resolveUsageAuth(ctx, adapter);
  assert.equal(auth?.managementAuth?.headers.Authorization, "Bearer file-secret");
  assert.equal(auth?.managementAuth?.source, "file");
});

test("OpenRouter uses separate inference and management credentials for account credits", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const model = {
    id: "test-model",
    name: "Test model",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "inference-secret", baseUrl: model.baseUrl } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const auth = await resolveUsageAuth(ctx, adapter, undefined, undefined, undefined, {
    managementApiKey: "management-secret",
    source: "file",
  });
  assert.ok(auth);
  assert.equal(auth.headers.Authorization, "Bearer inference-secret");
  assert.equal(auth.managementAuth?.headers.Authorization, "Bearer management-secret");
  assert.ok(auth.secrets.includes("inference-secret"));
  assert.ok(auth.secrets.includes("management-secret"));
  assert.doesNotMatch(auth.fingerprint, /management-secret|inference-secret/);
  const rotatedAuth = await resolveUsageAuth(ctx, adapter, undefined, undefined, undefined, {
    managementApiKey: "rotated-management-secret",
    source: "file",
  });
  assert.ok(rotatedAuth);
  assert.notEqual(rotatedAuth.fingerprint, auth.fingerprint);

  const originalFetch = globalThis.fetch;
  const requests: Array<{ url: string; headers: Record<string, string> }> = [];
  globalThis.fetch = async (input, init) => {
    const url = String(input);
    const headers = { ...(init?.headers as Record<string, string> | undefined) };
    requests.push({ url, headers });
    const payload = url.endsWith("/key")
      ? { data: { limit: 100, limit_remaining: 75, usage: 25 } }
      : { data: { total_credits: 100, total_usage: 20 } };
    return new Response(JSON.stringify(payload), { status: 200 });
  };
  try {
    const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000, async () => {});
    assert.deepEqual(
      requests.map((request) => request.url),
      ["https://openrouter.ai/api/v1/key", "https://openrouter.ai/api/v1/credits"],
    );
    assert.deepEqual(requests[0]?.headers, {
      Authorization: "Bearer inference-secret",
      "User-Agent": "pi-usage",
    });
    assert.deepEqual(requests[1]?.headers, {
      Authorization: "Bearer management-secret",
      "User-Agent": "pi-usage",
    });
    assert.equal(report.metrics.find((metric) => metric.id === "account-credits-remaining")?.value, 80);
    assert.equal(formatUsageStatusline(report), "openrouter $80.00 left");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter account credits fall back to key limits and redact management-key errors", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const model = {
    id: "test-model",
    name: "Test model",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "inference-secret", baseUrl: model.baseUrl } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const auth = await resolveUsageAuth(ctx, adapter, undefined, undefined, undefined, {
    managementApiKey: "management-secret",
    source: "file",
  });
  assert.ok(auth);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return requestCount === 1
      ? new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 75, usage: 25 } }), { status: 200 })
      : new Response(`{"error":"management-secret"}`, { status: 403 });
  };
  try {
    const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000, async () => {});
    assert.equal(requestCount, 2);
    assert.match(report.notes?.join("\n") ?? "", /Account balance unavailable/);
    assert.match(report.notes?.join("\n") ?? "", /valid Management API key/i);
    assert.doesNotMatch(JSON.stringify(report), /management-secret/);
    assert.equal(formatUsageStatusline(report), "openrouter $75.00 left");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter account credits fall back for non-auth endpoint failures", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const model = {
    id: "test-model",
    name: "Test model",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "inference-secret", baseUrl: model.baseUrl } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const auth = await resolveUsageAuth(ctx, adapter, undefined, undefined, undefined, {
    managementApiKey: "management-secret",
    source: "file",
  });
  assert.ok(auth);
  const originalFetch = globalThis.fetch;
  try {
    for (const makeFailureResponse of [
      () => new Response("management-secret", { status: 500 }),
      () => new Response("management-secret", { status: 200 }),
    ]) {
      let requestCount = 0;
      globalThis.fetch = async () => {
        requestCount += 1;
        return requestCount === 1
          ? new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 75, usage: 25 } }), { status: 200 })
          : makeFailureResponse();
      };
      const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000, async () => {});
      assert.equal(requestCount, 2);
      assert.match(report.notes?.join("\n") ?? "", /Account balance unavailable/);
      assert.doesNotMatch(JSON.stringify(report), /management-secret/);
      assert.equal(formatUsageStatusline(report), "openrouter $75.00 left");
    }
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter keeps per-key fallback when no management credentials are configured", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const model = {
    id: "test-model",
    name: "Test model",
    provider: "openrouter",
    baseUrl: "https://openrouter.ai/api/v1",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "inference-secret", baseUrl: model.baseUrl } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const auth = await resolveUsageAuth(ctx, adapter, undefined, undefined, undefined, {});
  assert.ok(auth);
  const originalFetch = globalThis.fetch;
  let requestCount = 0;
  globalThis.fetch = async () => {
    requestCount += 1;
    return new Response(JSON.stringify({ data: { limit: 100, limit_remaining: 75, usage: 25 } }), { status: 200 });
  };
  try {
    const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000, async () => {});
    assert.equal(requestCount, 1);
    assert.match(report.notes?.join("\n") ?? "", /Account balance requires/);
    assert.equal(formatUsageStatusline(report), "openrouter $75.00 left");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("OpenRouter account credits fail closed without a request-boundary guard", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const auth = {
    headers: { Authorization: "Bearer management-secret" },
    fingerprint: "fingerprint",
    secrets: ["management-secret"],
    model: { id: "test-model", name: "Test model", provider: "openrouter" } as never,
    managementAuth: {
      apiKey: "management-secret",
      headers: { Authorization: "Bearer management-secret" },
    },
  };
  await assert.rejects(
    () => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000),
    /request-boundary revalidation/,
  );
});

test("GitHub Copilot usage uses the matching Pi OAuth refresh token", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "github-copilot");
  assert.ok(adapter);
  const model = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: "copilot-session-token", baseUrl: model.baseUrl },
      }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const credentialReader = () => ({
    type: "oauth",
    access: "copilot-session-token",
    refresh: "github-oauth-token",
    expires: Date.now() + 60_000,
    enterpriseUrl: "github.com",
  });

  const auth = await resolveUsageAuth(ctx, adapter, new Uint8Array(32), credentialReader);
  assert.deepEqual(auth?.headers, {
    Authorization: "Bearer github-oauth-token",
    "X-GitHub-Api-Version": "2025-05-01",
  });
  assert.ok(auth?.secrets.includes("copilot-session-token"));
  assert.ok(auth?.secrets.includes("github-oauth-token"));

  await assert.rejects(
    () =>
      resolveUsageAuth(ctx, adapter, new Uint8Array(32), () => ({
        ...credentialReader(),
        access: "another-session-token",
      })),
    /does not match/iu,
  );
  const { ctx: conflictingHeaderContext } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "copilot-session-token",
        headers: { Authorization: "Bearer another-session-token" },
      }),
      getProviderAuth: async () => ({ auth: { apiKey: "copilot-session-token" } }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  await assert.rejects(
    () => resolveUsageAuth(conflictingHeaderContext, adapter, new Uint8Array(32), credentialReader),
    /does not match/iu,
  );
  await assert.rejects(
    () =>
      resolveUsageAuth(ctx, adapter, new Uint8Array(32), () => ({
        ...credentialReader(),
        enterpriseUrl: "company.ghe.com",
      })),
    /Enterprise/iu,
  );
});

test("GitHub Copilot named credential selection is deterministic and reaches only the official endpoint", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "github-copilot");
  assert.ok(adapter);
  const model = {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "github-copilot",
    baseUrl: "https://api.individual.githubcopilot.com",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getProviderAuth: async () => ({
        auth: { apiKey: "runtime-access", baseUrl: model.baseUrl },
      }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const matching = {
    type: "oauth" as const,
    access: "runtime-access",
    refresh: "matching-github-oauth",
    expires: Date.now() + 60_000,
    enterpriseUrl: "github.com",
  };
  const candidateReader = () => ({ ok: true as const, candidates: [matching] });
  const auth = await resolveUsageAuth(
    ctx,
    adapter,
    new Uint8Array(32),
    () => ({ ...matching, access: "default-access" }),
    candidateReader,
  );
  assert.ok(auth);
  assert.equal(auth.apiKey, "matching-github-oauth");

  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        quota_snapshots: {
          premium_interactions: { entitlement: 10, remaining: 7 },
        },
        login: "named-user",
      }),
      { status: 200 },
    ),
  );
  try {
    await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);
    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0]?.[0], "https://api.github.com/copilot_internal/user");
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    assert.deepEqual(init.headers, {
      Authorization: "Bearer matching-github-oauth",
      "X-GitHub-Api-Version": "2025-05-01",
      "User-Agent": "pi-usage",
    });
  } finally {
    fetchMock.mockRestore();
  }

  for (const candidates of [
    [matching, { ...matching, refresh: "conflicting-oauth" }],
    [{ ...matching, refresh: "conflicting-oauth" }, matching],
  ]) {
    await assert.rejects(
      () =>
        resolveUsageAuth(
          ctx,
          adapter,
          new Uint8Array(32),
          () => undefined,
          () => ({
            ok: true,
            candidates,
          }),
        ),
      /conflicting/iu,
    );
  }
  const duplicate = await resolveUsageAuth(
    ctx,
    adapter,
    new Uint8Array(32),
    () => undefined,
    () => ({ ok: true, candidates: [matching, structuredClone(matching)] }),
  );
  assert.equal(duplicate?.apiKey, "matching-github-oauth");
  await assert.rejects(
    () =>
      resolveUsageAuth(
        ctx,
        adapter,
        new Uint8Array(32),
        () => undefined,
        () => ({
          ok: true,
          candidates: [{ ...matching, enterpriseUrl: "company.ghe.test" }],
        }),
      ),
    /Enterprise/iu,
  );
  await assert.rejects(
    () =>
      resolveUsageAuth(
        ctx,
        adapter,
        new Uint8Array(32),
        () => undefined,
        () => ({
          ok: false,
        }),
      ),
    /failed closed/iu,
  );
});

test("OpenCode Go usage resolves auth before using the canonical versioned endpoint", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "opencode-go");
  assert.ok(adapter);
  const model = {
    id: "test-model",
    name: "Test model",
    provider: "opencode-go",
    baseUrl: "https://opencode.ai/zen/v1",
  };
  const { ctx } = createMockContext({
    model,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({
        ok: true,
        apiKey: "provider-default-key",
        headers: {
          Authorization: "Bearer current-model-key",
          "X-Model-Secret": "must-not-leak",
        },
      }),
      getProviderAuth: async () => ({
        auth: { apiKey: "provider-default-key", baseUrl: model.baseUrl },
      }),
      getAvailable: () => [model],
      getAll: () => [model],
    },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response(
      JSON.stringify({
        usage: {
          rolling: { status: "ok", percent: 1 },
        },
      }),
      { status: 200 },
    ),
  );
  try {
    const auth = await resolveUsageAuth(ctx, adapter);
    assert.ok(auth);
    const report = await queryProviderUsage(adapter, auth, new AbortController().signal, 1_000);

    assert.equal(fetchMock.mock.calls.length, 1);
    assert.equal(fetchMock.mock.calls[0]?.[0], "https://opencode.ai/zen/go/v1/usage");
    const request = fetchMock.mock.calls[0]?.[1];
    assert.equal(request?.method, "GET");
    assert.deepEqual(request?.headers, {
      Authorization: "Bearer current-model-key",
      "User-Agent": "pi-usage",
    });
    assert.ok(request?.signal instanceof AbortSignal);
    assert.equal(report.providerId, "opencode-go");
    assert.equal(report.buckets[0]?.used, 1);
    assert.equal(report.buckets[0]?.remaining, 99);
  } finally {
    fetchMock.mockRestore();
  }
});

test("OpenCode Go usage rejects custom model and auth origins before fetching", async () => {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "opencode-go");
  assert.ok(adapter);
  const proxyModel = {
    id: "proxy-model",
    name: "Proxy model",
    provider: "opencode-go",
    baseUrl: "https://proxy.example.test/v1",
  };
  const { ctx: proxyModelContext } = createMockContext({
    model: proxyModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "proxy-key" }),
      getProviderAuth: async () => ({ auth: { apiKey: "proxy-key" } }),
      getAvailable: () => [proxyModel],
      getAll: () => [proxyModel],
    },
  });
  const officialModel = {
    ...proxyModel,
    id: "official-model",
    name: "Official model",
    baseUrl: "https://opencode.ai/zen/v1",
  };
  const { ctx: proxyAuthContext } = createMockContext({
    model: officialModel,
    modelRegistry: {
      getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "official-key" }),
      getProviderAuth: async () => ({
        auth: { apiKey: "proxy-key", baseUrl: "https://proxy.example.test/v1" },
      }),
      getAvailable: () => [officialModel],
      getAll: () => [officialModel],
    },
  });
  const fetchMock = vi.spyOn(globalThis, "fetch");
  try {
    await assert.rejects(() => resolveUsageAuth(proxyModelContext, adapter), /custom.*base URL|official/iu);
    await assert.rejects(() => resolveUsageAuth(proxyAuthContext, adapter), /proxy-resolved.*official/iu);
    assert.equal(fetchMock.mock.calls.length, 0);
  } finally {
    fetchMock.mockRestore();
  }
});

test("provider cancellation preserves AbortError identity", async () => {
  const abort = Object.assign(new Error("cancelled"), { name: "AbortError" });
  const adapter = {
    id: "test",
    displayName: "Test",
    semantics: { kind: "api-key" as const, label: "Test" },
    query: async () => {
      throw abort;
    },
  };
  const controller = new AbortController();
  await assert.rejects(
    () =>
      queryProviderUsage(
        adapter,
        {
          headers: { Authorization: "Bearer secret" },
          fingerprint: "fingerprint",
          secrets: ["secret"],
          model: {} as never,
        },
        controller.signal,
        10,
      ),
    (error: unknown) => error instanceof Error && error.name === "AbortError",
  );
});

test("display sanitization strips terminal escapes, controls, and excessive text", () => {
  const sanitized = sanitizeDisplayText("safe\u001b]8;;https://evil.test\u0007link\u001b]8;;\u0007\nnext", 20);
  assert.equal(sanitized, "safelink next");
  assert.equal(sanitizeDisplayText("x".repeat(100), 10), "xxxxxxxxx…");
});

test("provider response reads are byte-bounded", async (t) => {
  const originalFetch = globalThis.fetch;
  t.onTestFinished(() => {
    globalThis.fetch = originalFetch;
  });
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "openrouter");
  assert.ok(adapter);
  const auth = {
    headers: { Authorization: "Bearer secret" },
    fingerprint: "fingerprint",
    secrets: ["secret"],
    model: { ...report, baseUrl: "https://openrouter.ai/api/v1" } as never,
  };
  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 200 });
  await assert.rejects(
    () => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000, async () => {}),
    /exceeded.*bytes|too large/iu,
  );

  globalThis.fetch = async () => new Response("x".repeat(70_000), { status: 500 });
  await assert.rejects(
    () => queryProviderUsage(adapter, auth, new AbortController().signal, 1_000, async () => {}),
    (error: unknown) => error instanceof Error && error.message.length < 1_000 && /returned 500/.test(error.message),
  );
});

test("usage error redaction removes exact runtime auth and common token fields", () => {
  const redacted = redactUsageError('Bearer common-token {"access_token":"json-token"} sk-secret header-secret', [
    "sk-secret",
    "header-secret",
  ]);
  assert.doesNotMatch(redacted, /common-token|json-token|sk-secret|header-secret/);
  assert.match(redacted, /<redacted>/);
});
