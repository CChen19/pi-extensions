import { sanitizeDisplayText } from "../core.js";
import type {
  OpenRouterCreditsPayload,
  OpenRouterKeyPayload,
  UsageBucket,
  UsageMetric,
  UsageReport,
} from "../types.js";

export function normalizeOpenRouterKeyPayload(payload: OpenRouterKeyPayload, capturedAt: number): UsageReport {
  const data = asObject(payload.data);
  if (!data) throw new Error("OpenRouter key response data was not an object.");

  const limit = asNonnegativeNumber(data.limit);
  const remaining = asNonnegativeNumber(data.limit_remaining);
  const period = asString(data.limit_reset);
  const totalUsage = asNonnegativeNumber(data.usage);
  const buckets: UsageBucket[] = [];
  if (limit !== undefined) {
    buckets.push({
      id: "key-limit",
      label: "Key limit",
      ...(remaining !== undefined ? { used: Math.max(0, limit - remaining), remaining } : {}),
      limit,
      unit: "usd",
      ...(period ? { period } : {}),
    });
  }

  const metrics: UsageMetric[] = [];
  addUsageMetric(metrics, "usage-daily", "Usage today", data.usage_daily);
  addUsageMetric(metrics, "usage-weekly", "Usage this week", data.usage_weekly);
  addUsageMetric(metrics, "usage-monthly", "Usage this month", data.usage_monthly);
  addUsageMetric(metrics, "usage-total", "All-time usage", totalUsage);
  if (buckets.length === 0 && metrics.length === 0) {
    throw new Error("OpenRouter key response returned no displayable usage data.");
  }

  const notes: string[] = [];
  if (data.limit === null) notes.push("No per-key spend cap");
  else if (limit === undefined) notes.push("Per-key spend cap unavailable");
  if (data.is_free_tier === true) notes.push("Free-tier API key");

  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    capturedAt,
    source: "openrouter-key",
    semantics: { kind: "api-key", label: "API-key spend limits" },
    accountLabel: asString(data.label),
    buckets,
    metrics,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

/** Normalize the account-wide credits returned by OpenRouter's management endpoint. */
export function normalizeOpenRouterCreditsPayload(payload: OpenRouterCreditsPayload, capturedAt: number): UsageReport {
  const data = asObject(payload.data);
  if (!data) throw new Error("OpenRouter credits response data was not an object.");

  const totalCredits = requiredNonnegativeNumber(data.total_credits, "total_credits");
  const totalUsage = requiredNonnegativeNumber(data.total_usage, "total_usage");
  const remaining = totalCredits - totalUsage;
  const metrics: UsageMetric[] = [
    { id: "account-credits-purchased", label: "Credits purchased", value: totalCredits, unit: "usd" },
    { id: "account-credits-used", label: "Credits used", value: totalUsage, unit: "usd" },
    { id: "account-credits-remaining", label: "Credits remaining", value: remaining, unit: "usd" },
  ];

  return {
    providerId: "openrouter",
    providerName: "OpenRouter",
    capturedAt,
    source: "openrouter-credits",
    semantics: { kind: "api-key", label: "Account credits" },
    accountLabel: "OpenRouter account",
    buckets: [],
    metrics,
    notes: ["Account balance is total credits purchased minus total credits used."],
  };
}

/** Merge the two independently scoped OpenRouter reports without conflating their balances. */
export function mergeOpenRouterAccountCredits(
  keyReport: UsageReport,
  accountReport: UsageReport,
  managementSource?: string,
): UsageReport {
  const sourceLabel = managementSource ? ` (${sanitizeDisplayText(managementSource, 40)})` : "";
  const notes = [
    ...(keyReport.notes ?? []),
    `Account credits were queried with management credentials${sourceLabel}.`,
    "Account credits are account-wide; key limits are scoped to the inference key.",
    ...(accountReport.notes ?? []),
  ];
  return {
    ...keyReport,
    source: "openrouter-key+credits",
    semantics: { kind: "api-key", label: "API-key spend limits and account credits" },
    metrics: [...keyReport.metrics, ...accountReport.metrics],
    notes,
  };
}

function addUsageMetric(metrics: UsageMetric[], id: string, label: string, value: unknown): void {
  const amount = typeof value === "number" ? asNonnegativeNumber(value) : undefined;
  if (amount === undefined) return;
  metrics.push({ id, label, value: amount, unit: "usd" });
}

function requiredNonnegativeNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`OpenRouter credits response field ${field} must be a non-negative number.`);
  }
  return value;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, 80) || undefined;
}

function asNonnegativeNumber(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
  return value;
}
