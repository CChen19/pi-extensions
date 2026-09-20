import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  formatUsageReport,
  formatUsageStatusline,
  normalizeStepFunPlanStatusPayload,
  normalizeStepFunRateLimitPayload,
  queryProviderUsage,
  type ResolvedUsageAuth,
  resolveUsageAuth,
  SUPPORTED_ADAPTERS,
} from "../src/index.js";
import {
  normalizeStepFunToken,
  requireStepFunToken,
  resolveStepFunCredentials,
  stepfunCredentialsFromEnv,
  stepfunRequestHeaders,
  stepfunWebId,
} from "../src/providers/stepfun-auth.js";
import { isStepFunAuthError, stepfunResponseError } from "../src/providers/stepfun-errors.js";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const STEPFUN_MODEL = {
  id: "step-5-preview",
  name: "Step 5 Preview (Step Plan)",
  provider: "stepfun",
  baseUrl: "https://api.stepfun.ai/step_plan/v1",
};

const ACCESS_JWT = jwt({ app_id: 20700, device_id: "access-webid", exp: 4_000_000_000 });
const REFRESH_JWT = jwt({ app_id: 20700, device_id: "refresh-webid", exp: 4_000_000_000 });
const SESSION_TOKEN = `${ACCESS_JWT}...${REFRESH_JWT}`;

const RATE_LIMIT_PAYLOAD = {
  status: 1,
  desc: "",
  five_hour_usage_left_rate: 0.8,
  five_hour_usage_reset_time: "1746000000",
  weekly_usage_left_rate: 0.6,
  weekly_usage_reset_time: 1_746_432_000,
};

const PLAN_STATUS_PAYLOAD = { status: 1, subscription: { name: "Plus", plan_type: 1, status: 1 } };

function jwt(payload: Record<string, unknown>): string {
  const encode = (value: Record<string, unknown>) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "HS256" })}.${encode(payload)}.signature`;
}

function stepfunUsageAuth(model = STEPFUN_MODEL): ResolvedUsageAuth {
  return {
    apiKey: "step-plan-key",
    headers: { Authorization: "Bearer step-plan-key" },
    fingerprint: "fingerprint",
    secrets: ["step-plan-key", "Bearer step-plan-key"],
    model: model as never,
  };
}

function stepfunAdapter() {
  const adapter = SUPPORTED_ADAPTERS.find((candidate) => candidate.id === "stepfun");
  assert.ok(adapter);
  return adapter;
}

interface RecordedRequest {
  url: string;
  method: string;
  headers: Headers;
  body: unknown;
}

interface PlatformBehavior {
  rateLimit?: () => Response;
  planStatus?: () => Response;
  refresh?: () => Response;
}

function stubPlatform(behavior: PlatformBehavior = {}) {
  const requests: RecordedRequest[] = [];
  const tokenResponse = (access = ACCESS_JWT, refresh = REFRESH_JWT) =>
    new Response(JSON.stringify({ accessToken: { raw: access }, refreshToken: { raw: refresh } }), { status: 200 });
  globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body) as unknown;
      } catch {
        body = init.body;
      }
    }
    requests.push({ url, method: init?.method ?? "GET", headers, body });
    const path = new URL(url).pathname;
    if (path.includes("RefreshToken")) return behavior.refresh?.() ?? tokenResponse();
    if (path.includes("QueryStepPlanRateLimit")) {
      return behavior.rateLimit?.() ?? new Response(JSON.stringify(RATE_LIMIT_PAYLOAD), { status: 200 });
    }
    if (path.includes("GetStepPlanStatus")) {
      return behavior.planStatus?.() ?? new Response(JSON.stringify(PLAN_STATUS_PAYLOAD), { status: 200 });
    }
    return new Response("unexpected", { status: 404 });
  };
  return requests;
}

test("StepFun adapter is registered with subscription semantics", () => {
  const adapter = stepfunAdapter();
  assert.equal(adapter.displayName, "StepFun");
  assert.deepEqual(adapter.semantics, { kind: "consumer-subscription", label: "Step Plan usage" });
  assert.equal(adapter.publishesStatusline, undefined);
  assert.equal(adapter.invalidateCacheOnFailure, true);
});

test("normalizes rolling 5-hour and weekly windows from flexible numbers and timestamps", () => {
  const report = normalizeStepFunRateLimitPayload("stepfun", "StepFun", RATE_LIMIT_PAYLOAD, 500, { name: "Plus" });

  assert.equal(report.providerId, "stepfun");
  assert.equal(report.providerName, "StepFun");
  assert.equal(report.source, "stepfun-platform");
  assert.deepEqual(report.semantics, { kind: "consumer-subscription", label: "Step Plan usage" });
  assert.deepEqual(report.buckets, [
    {
      id: "five-hour",
      label: "5h window",
      used: 20,
      remaining: 80,
      limit: 100,
      unit: "percent",
      windowMinutes: 300,
      resetsAt: 1_746_000_000,
    },
    {
      id: "weekly",
      label: "Weekly window",
      used: 40,
      remaining: 60,
      limit: 100,
      unit: "percent",
      windowMinutes: 10_080,
      resetsAt: 1_746_432_000,
    },
  ]);
  assert.deepEqual(report.metrics, []);
  assert.deepEqual(report.notes, ["Plan: Plus"]);
});

test("accepts integer rates and numeric timestamps and clamps out-of-range values", () => {
  const report = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      five_hour_usage_left_rate: 1,
      five_hour_usage_reset_time: 1_746_000_000,
      weekly_usage_left_rate: 0,
      weekly_usage_reset_time: 1_746_432_000,
    },
    600,
  );
  assert.deepEqual(
    report.buckets.map((bucket) => [bucket.id, bucket.used, bucket.remaining]),
    [
      ["five-hour", 0, 100],
      ["weekly", 100, 0],
    ],
  );
});

test("keeps rate windows displayable when the payload reports no reset time", () => {
  const report = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      five_hour_usage_left_rate: 0.35,
      five_hour_usage_reset_time: "0",
      weekly_usage_left_rate: 0.9,
      weekly_usage_reset_time: "0",
    },
    700,
  );
  assert.deepEqual(
    report.buckets.map((bucket) => [bucket.id, bucket.used, bucket.remaining, bucket.resetsAt]),
    [
      ["five-hour", 65, 35, undefined],
      ["weekly", 10, 90, undefined],
    ],
  );
});

test("normalizes the monthly credit pool from weighted credit buckets", () => {
  const report = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      five_hour_usage_left_rate: 0,
      five_hour_usage_reset_time: "0",
      weekly_usage_left_rate: 0,
      weekly_usage_reset_time: "0",
      plan_family: 2,
      plan_credit_rate_limit: {
        subscription_credit_left_rate: 0.9641096,
        subscription_credit_reset_time: "1786288293",
        topup_credit_left_rate: 0,
        credit_buckets: [
          {
            type: 1,
            credit_total: "400000000",
            credit_residual: "385643853",
            expire_at: "1792416128",
            next_reset_at: "1786288293",
          },
        ],
      },
    },
    800,
  );

  assert.deepEqual(report.buckets, [
    {
      id: "credit",
      label: "Monthly credits",
      used: 3.59,
      remaining: 96.41,
      limit: 100,
      unit: "percent",
      windowMinutes: 43_200,
      resetsAt: 1_786_288_293,
    },
  ]);
  assert.deepEqual(report.metrics, [
    { id: "credit-remaining", label: "Credits remaining", value: 385_643_853, unit: "count" },
    { id: "credit-total", label: "Credits total", value: 400_000_000, unit: "count" },
  ]);
  assert.equal(report.notes, undefined);
});

test("weights mixed subscription and top-up credit buckets", () => {
  const report = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      plan_family: 2,
      plan_credit_rate_limit: {
        subscription_credit_left_rate: 0.8,
        topup_credit_left_rate: 0.5,
        credit_buckets: [
          { credit_total: "100", credit_residual: "80" },
          { credit_total: "300", credit_residual: "150" },
        ],
      },
    },
    900,
  );
  // The independent rates sum to 1.3, but the weighted balance is (80 + 150) / (100 + 300).
  assert.deepEqual(
    report.buckets.map((bucket) => [bucket.used, bucket.remaining]),
    [[42.5, 57.5]],
  );
  assert.deepEqual(report.metrics, [
    { id: "credit-remaining", label: "Credits remaining", value: 230, unit: "count" },
    { id: "credit-total", label: "Credits total", value: 400, unit: "count" },
  ]);
});

test("falls back to the subscription and then the top-up credit rate for incomplete buckets", () => {
  const subscription = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      plan_family: 2,
      plan_credit_rate_limit: {
        subscription_credit_left_rate: 0.6,
        topup_credit_left_rate: 0.4,
        credit_buckets: [{ credit_total: "100" }],
      },
    },
    1_000,
  );
  assert.deepEqual(
    subscription.buckets.map((bucket) => [bucket.id, bucket.used]),
    [["credit", 40]],
  );
  assert.deepEqual(subscription.metrics, []);

  const topup = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      plan_family: 2,
      plan_credit_rate_limit: { topup_credit_left_rate: 0.25, subscription_credit_reset_time: "1786288293" },
    },
    1_100,
  );
  assert.deepEqual(
    topup.buckets.map((bucket) => [bucket.id, bucket.used, bucket.resetsAt]),
    [["credit", 75, 1_786_288_293]],
  );
});

test("classifies exhausted credit pools without a plan family id", () => {
  for (const planCreditRateLimit of [
    { subscription_credit_left_rate: 0, subscription_credit_reset_time: "1786288293" },
    { topup_credit_left_rate: 0 },
  ]) {
    const report = normalizeStepFunRateLimitPayload(
      "stepfun",
      "StepFun",
      {
        status: 1,
        five_hour_usage_left_rate: 0,
        five_hour_usage_reset_time: "0",
        weekly_usage_left_rate: 0,
        weekly_usage_reset_time: "0",
        plan_credit_rate_limit: planCreditRateLimit,
      },
      1_200,
    );
    assert.deepEqual(
      report.buckets.map((bucket) => [bucket.id, bucket.used]),
      [["credit", 100]],
    );
  }
});

test("live rolling windows win over a credit-family plan id", () => {
  const report = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      five_hour_usage_left_rate: 0.8,
      five_hour_usage_reset_time: "1746000000",
      weekly_usage_left_rate: 0.6,
      weekly_usage_reset_time: "1746432000",
      plan_family: 2,
      plan_credit_rate_limit: { subscription_credit_left_rate: 1, credit_buckets: [] },
    },
    1_300,
  );
  assert.deepEqual(
    report.buckets.map((bucket) => [bucket.id, bucket.windowMinutes]),
    [
      ["five-hour", 300],
      ["weekly", 10_080],
    ],
  );
});

test("rejects payloads without displayable quota data", () => {
  const ambiguousCreditFamily = {
    status: 1,
    five_hour_usage_left_rate: 0,
    five_hour_usage_reset_time: "0",
    weekly_usage_left_rate: 0,
    weekly_usage_reset_time: "0",
    plan_family: 2,
  };
  for (const payload of [{}, { status: 1 }, ambiguousCreditFamily]) {
    assert.throws(
      () => normalizeStepFunRateLimitPayload("stepfun", "StepFun", payload, 0),
      /no displayable usage data/,
    );
  }

  // A partial window payload stays displayable with whatever window it carries.
  const partial = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    { status: 1, five_hour_usage_left_rate: 0.8, five_hour_usage_reset_time: "1746000000" },
    0,
  );
  assert.deepEqual(
    partial.buckets.map((bucket) => bucket.id),
    ["five-hour"],
  );
});

test("quota classification depends on coded status, not message text or quota data", () => {
  for (const data of [undefined, null, [], false, 0, {}, RATE_LIMIT_PAYLOAD]) {
    for (const message of [undefined, "Unauthorized", "Server error", "任意訊息"]) {
      assert.throws(
        () =>
          normalizeStepFunRateLimitPayload(
            "stepfun",
            "StepFun",
            { status: 0, message, ...(data === undefined ? {} : { data }) },
            0,
          ),
        {
          message: "StepFun: API request failed.",
        },
      );
    }
  }
  assert.throws(() => normalizeStepFunRateLimitPayload("stepfun", "StepFun", { code: "permission_denied" }, 0), {
    message: "StepFun permission_denied: StepFun platform denied the session. Obtain a new platform Oasis-Token.",
  });
});

test("plan status normalization only keeps the subscription name", () => {
  assert.deepEqual(normalizeStepFunPlanStatusPayload(PLAN_STATUS_PAYLOAD), { name: "Plus" });
  assert.deepEqual(normalizeStepFunPlanStatusPayload({ status: 1, subscription: { name: "  " } }), undefined);
  assert.deepEqual(normalizeStepFunPlanStatusPayload({ status: 1, subscription: null }), undefined);
  assert.deepEqual(normalizeStepFunPlanStatusPayload({ status: 0, subscription: { name: "Plus" } }), undefined);
});

test("response errors surface fixed messages and mark recoverable session failures", () => {
  const secret = "s".repeat(100);
  const cases: Array<{ status: number; body: string; expected: string | RegExp; auth?: boolean }> = [
    { status: 200, body: JSON.stringify({ code: "unauthenticated" }), expected: /StepFun unauthenticated/, auth: true },
    {
      status: 200,
      body: JSON.stringify({ code: "permission_denied", message: secret }),
      expected: "StepFun permission_denied: StepFun platform denied the session. Obtain a new platform Oasis-Token.",
    },
    {
      status: 200,
      body: JSON.stringify({ status: 0, message: secret }),
      expected: "StepFun: API request failed.",
      auth: true,
    },
    { status: 401, body: JSON.stringify({ error: "unauthorized" }), expected: "StepFun HTTP 401:", auth: true },
    {
      status: 403,
      body: JSON.stringify({ error: "forbidden" }),
      expected: "StepFun HTTP 403: StepFun platform denied the session. Obtain a new platform Oasis-Token.",
    },
    { status: 500, body: secret, expected: "StepFun HTTP 500: StepFun platform internal error. Try again later." },
    {
      status: 429,
      body: "{}",
      expected: "StepFun HTTP 429: StepFun platform request rate limit reached. Try again later.",
    },
    { status: 200, body: `broken ${secret}`, expected: "StepFun: Invalid JSON response." },
    { status: 200, body: JSON.stringify({ status: 1 }), expected: "" },
  ];
  for (const { status, body, expected, auth } of cases) {
    const error = stepfunResponseError(status, body);
    if (expected === "") {
      assert.equal(error, undefined);
      continue;
    }
    if (error === undefined) assert.fail("expected a StepFun response error");
    const message = typeof error === "string" ? error : error.message;
    assert.match(message, typeof expected === "string" ? new RegExp(expected) : expected);
    assert.ok(!message.includes(secret.slice(0, 20)));
    assert.equal(isStepFunAuthError(error), auth === true);
  }
});

test("token normalization accepts raw, cookie-header, and quoted values", () => {
  assert.equal(normalizeStepFunToken("abc123...def456"), "abc123...def456");
  assert.equal(normalizeStepFunToken("Oasis-Token=abc123...def456; Oasis-Webid=webid"), "abc123...def456");
  assert.equal(normalizeStepFunToken("oasis-token=abc123...def456"), "abc123...def456");
  assert.equal(normalizeStepFunToken('  "abc123...def456"  '), "abc123...def456");
  assert.equal(normalizeStepFunToken("'abc123...def456'"), "abc123...def456");
  assert.equal(normalizeStepFunToken(""), undefined);
  assert.equal(normalizeStepFunToken("   "), undefined);
  assert.equal(normalizeStepFunToken("Oasis-Token=; Oasis-Webid=webid"), undefined);
  assert.equal(normalizeStepFunToken(undefined), undefined);
});

test("token validation rejects missing and header-unsafe values", () => {
  assert.equal(requireStepFunToken({ token: "abc123...def456" }), "abc123...def456");
  assert.throws(() => requireStepFunToken({}), /credentials are not configured/);
  for (const token of ["short", "has space", "crlf\r\ninjection", "semicolon;value"]) {
    assert.throws(() => requireStepFunToken({ token }), /Oasis-Token format is invalid/);
  }
});

test("webid derivation prefers the refresh half device_id and falls back safely", () => {
  assert.equal(stepfunWebId(SESSION_TOKEN), "refresh-webid");
  assert.equal(stepfunWebId(ACCESS_JWT), "access-webid");
  assert.equal(stepfunWebId("not-a-jwt"), "c8a1002d2c457e758785a9979832217c7c0b884c");
  const unsafe = `${jwt({ device_id: "bad\r\nwebid" })}...${jwt({ device_id: "unsafe/webid" })}`;
  assert.equal(stepfunWebId(unsafe), "c8a1002d2c457e758785a9979832217c7c0b884c");
  assert.equal(
    stepfunWebId(`${jwt({ device_id: "bad\r\nwebid" })}...${jwt({ device_id: "safe-webid" })}`),
    "safe-webid",
  );
});

test("request headers carry the session cookie and webid without the API key", () => {
  const headers = stepfunRequestHeaders(SESSION_TOKEN);
  assert.equal(headers.Cookie, `Oasis-Token=${SESSION_TOKEN}; Oasis-Webid=refresh-webid`);
  assert.equal(headers["oasis-webid"], "refresh-webid");
  assert.equal(headers["oasis-appid"], "20700");
  assert.equal(headers["oasis-platform"], "web");
  assert.equal(headers.Authorization, undefined);
  assert.ok(headers["user-agent"]?.startsWith("Mozilla/5.0"));
});

test("credentials are read from STEPFUN_TOKEN with quote stripping", () => {
  vi.stubEnv("STEPFUN_TOKEN", '  "raw-token-value"  ');
  assert.deepEqual(stepfunCredentialsFromEnv(), { token: "raw-token-value" });
  vi.stubEnv("STEPFUN_TOKEN", "");
  assert.deepEqual(stepfunCredentialsFromEnv(), { token: undefined });
});

test("falls back to an owner-private JSON credential file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-stepfun-"));
  const path = join(directory, "credentials.json");
  try {
    await writeFile(path, JSON.stringify({ token: SESSION_TOKEN }), { mode: 0o600 });
    assert.deepEqual(await resolveStepFunCredentials({ STEPFUN_CREDENTIALS_FILE: path }), {
      token: SESSION_TOKEN,
    });

    if (process.platform !== "win32") {
      await chmod(path, 0o644);
      await assert.rejects(
        () => resolveStepFunCredentials({ STEPFUN_CREDENTIALS_FILE: path }),
        /readable only by its owner/,
      );
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("uses a configured Oasis-Token without forwarding the Step Plan API key", async () => {
  vi.stubEnv("STEPFUN_TOKEN", SESSION_TOKEN);
  const requests = stubPlatform();

  const report = await stepfunAdapter().query(stepfunUsageAuth(), new AbortController().signal, 5_000);

  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit",
      "/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus",
    ],
  );
  assert.equal(requests[0]?.headers.get("cookie"), `Oasis-Token=${SESSION_TOKEN}; Oasis-Webid=refresh-webid`);
  assert.equal(new URL(requests[0]?.url ?? "").origin, "https://platform.stepfun.ai");
  assert.equal(requests[0]?.headers.get("oasis-appid"), "20700");
  assert.deepEqual(report.notes, ["Plan: Plus"]);
});

test("routes a China-platform token only to platform.stepfun.com with app ID 10300", async () => {
  const chinaToken = `${jwt({ app_id: 10300, device_id: "china-webid" })}...${jwt({
    app_id: 10300,
    device_id: "china-webid",
  })}`;
  vi.stubEnv("STEPFUN_TOKEN", chinaToken);
  const requests = stubPlatform();
  const chinaModel = { ...STEPFUN_MODEL, baseUrl: "https://api.stepfun.com/v1" };

  await stepfunAdapter().query(stepfunUsageAuth(chinaModel), new AbortController().signal, 5_000);

  assert.deepEqual(
    [...new Set(requests.map((request) => new URL(request.url).origin))],
    ["https://platform.stepfun.com"],
  );
  assert.ok(requests.every((request) => request.headers.get("oasis-appid") === "10300"));
});

test("fails with configuration guidance when no platform credential is available", async () => {
  vi.stubEnv("STEPFUN_TOKEN", "");
  vi.stubEnv("STEPFUN_CREDENTIALS_FILE", "");
  const requests = stubPlatform();

  await assert.rejects(() => stepfunAdapter().query(stepfunUsageAuth(), new AbortController().signal, 5_000), {
    message:
      "StepFun platform credentials are not configured. Set STEPFUN_TOKEN or create ~/.pi/agent/pi-usage-stepfun.json with an Oasis-Token.",
  });
  assert.equal(requests.length, 0);
});

test("refreshes an expired Oasis-Token once and retries the quota query", async () => {
  vi.stubEnv("STEPFUN_TOKEN", SESSION_TOKEN);
  const nextAccess = jwt({ app_id: 20700, device_id: "next-webid", exp: 4_000_000_000 });
  let rateLimitCalls = 0;
  const requests = stubPlatform({
    rateLimit: () => {
      rateLimitCalls += 1;
      return rateLimitCalls === 1
        ? new Response(JSON.stringify({ code: "unauthenticated", message: "auth failed: token is expired" }), {
            status: 200,
          })
        : new Response(JSON.stringify(RATE_LIMIT_PAYLOAD), { status: 200 });
    },
    refresh: () =>
      new Response(
        JSON.stringify({
          accessToken: { raw: nextAccess },
          refreshToken: { raw: REFRESH_JWT },
        }),
        {
          status: 200,
        },
      ),
  });

  const report = await stepfunAdapter().query(stepfunUsageAuth(), new AbortController().signal, 5_000);

  assert.equal(rateLimitCalls, 2);
  assert.deepEqual(
    requests.map((request) => new URL(request.url).pathname),
    [
      "/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit",
      "/passport/proto.api.passport.v1.PassportService/RefreshToken",
      "/api/step.openapi.devcenter.Dashboard/QueryStepPlanRateLimit",
      "/api/step.openapi.devcenter.Dashboard/GetStepPlanStatus",
    ],
  );
  const retried = requests[2];
  assert.ok(retried);
  assert.ok(retried.headers.get("cookie")?.startsWith(`Oasis-Token=${nextAccess}...`));
  assert.deepEqual(report.notes, ["Plan: Plus"]);
});

test("non-session failures surface immediately without refresh attempts", async () => {
  vi.stubEnv("STEPFUN_TOKEN", SESSION_TOKEN);
  const requests = stubPlatform({
    rateLimit: () => new Response("upstream connect error", { status: 503 }),
  });

  await assert.rejects(() => stepfunAdapter().query(stepfunUsageAuth(), new AbortController().signal, 5_000), {
    message: "StepFun HTTP 503: StepFun platform is unavailable. Try again later.",
  });
  assert.equal(requests.length, 1);
});

test("queryProviderUsage redacts the platform session from wrapped failures", async () => {
  vi.stubEnv("STEPFUN_TOKEN", SESSION_TOKEN);
  stubPlatform({
    rateLimit: () =>
      new Response(JSON.stringify({ code: "permission_denied", message: SESSION_TOKEN }), { status: 200 }),
  });
  await assert.rejects(
    () => queryProviderUsage(stepfunAdapter(), stepfunUsageAuth(), new AbortController().signal, 5_000),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /StepFun permission_denied/);
      assert.ok(!error.message.includes(ACCESS_JWT.slice(0, 20)));
      return true;
    },
  );
});

test("a failing plan lookup keeps the quota report without a plan name", async () => {
  vi.stubEnv("STEPFUN_TOKEN", SESSION_TOKEN);
  stubPlatform({ planStatus: () => new Response("gateway timeout", { status: 504 }) });

  const report = await stepfunAdapter().query(stepfunUsageAuth(), new AbortController().signal, 5_000);
  assert.equal(report.notes, undefined);
  assert.equal(report.buckets.length, 2);
});

test("usage resolves only official StepFun API origins", async () => {
  const proxyModel = { ...STEPFUN_MODEL, baseUrl: "https://proxy.example.test/v1" };
  const { ctx: proxyContext } = createMockContext({
    model: proxyModel,
    modelRegistry: {
      getProviderAuth: async () => ({ auth: { apiKey: "proxy-key" } }),
      getAvailable: () => [proxyModel],
      getAll: () => [proxyModel],
    },
  });
  await assert.rejects(() => resolveUsageAuth(proxyContext, stepfunAdapter()), /custom.*base URL|official/iu);

  for (const baseUrl of ["https://api.stepfun.ai/step_plan/v1", "https://api.stepfun.com/v1"]) {
    const model = { ...STEPFUN_MODEL, baseUrl };
    const { ctx } = createMockContext({
      model,
      modelRegistry: {
        getProviderAuth: async () => ({ auth: { apiKey: "official-key", baseUrl } }),
        getAvailable: () => [model],
        getAll: () => [model],
      },
    });
    const auth = await resolveUsageAuth(ctx, stepfunAdapter());
    assert.deepEqual(auth?.headers, { Authorization: "Bearer official-key" });
  }
});

test("statusline and report render both billing models", () => {
  const windowed = normalizeStepFunRateLimitPayload("stepfun", "StepFun", RATE_LIMIT_PAYLOAD, 500, { name: "Plus" });
  const now = 1_745_996_400_000;
  assert.equal(formatUsageStatusline(windowed, undefined, now), "StepFun 80% ↻ 1h │ 60% ↻ 5d1h");
  const rendered = formatUsageReport(windowed, "current");
  assert.match(rendered, /StepFun Usage · Current/);
  assert.match(rendered, /Step Plan usage/);
  assert.match(rendered, /5h window:\s+\[█{16}░{4}\] 80% left \(resets /);
  assert.match(rendered, /Weekly window:\s+\[█{12}░{8}\] 60% left \(resets /);
  assert.match(rendered, /Plan: Plus/);

  const credited = normalizeStepFunRateLimitPayload(
    "stepfun",
    "StepFun",
    {
      status: 1,
      plan_family: 2,
      plan_credit_rate_limit: {
        subscription_credit_left_rate: 0.5,
        subscription_credit_reset_time: "1786288293",
      },
    },
    600,
    { name: "Plus" },
  );
  assert.equal(
    formatUsageStatusline(credited, undefined, 1_786_288_293_000 - 12 * 86_400_000),
    "StepFun Plus · 50% credits ↻ 12d",
  );
  assert.match(formatUsageReport(credited, "current"), /Monthly credits:\s+\[█{10}░{10}\] 50% left \(resets /);
});
