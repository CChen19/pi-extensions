import { sanitizeDisplayText } from "../core.js";
import type {
  StepFunPlanInfo,
  StepFunPlanStatusPayload,
  StepFunRateLimitPayload,
  UsageBucket,
  UsageMetric,
  UsageReport,
} from "../types.js";

import { stepfunPayloadError } from "./stepfun-errors.js";

const FIVE_HOUR_WINDOW_MINUTES = 300;
const WEEKLY_WINDOW_MINUTES = 10_080;
const MONTHLY_WINDOW_MINUTES = 43_200;
const CREDIT_PLAN_FAMILY = 2;

// StepFun meters the Step Plan two ways after the 2026-06-18 upgrade: the grandfathered Coding
// Plan meters rolling 5-hour and weekly windows, while the Token Plan meters a monthly Credit pool
// through plan_credit_rate_limit (its rate windows come back as 0 with reset time "0" — "no window
// configured", not "used up"). Classify by the shape the payload actually carries — a live window
// wins over plan_family — so a changed family id can never route a windowed plan onto the credit
// renderer or vice versa.
export function normalizeStepFunRateLimitPayload(
  providerId: string,
  providerName: string,
  payload: StepFunRateLimitPayload,
  capturedAt: number,
  plan?: StepFunPlanInfo,
): UsageReport {
  const error = stepfunPayloadError(payload);
  if (error) throw new Error(error);

  const fiveHourReset = flexibleTimestamp(payload.five_hour_usage_reset_time);
  const weeklyReset = flexibleTimestamp(payload.weekly_usage_reset_time);
  const hasLiveWindow = fiveHourReset !== undefined || weeklyReset !== undefined;
  const credit = asObject(payload.plan_credit_rate_limit);
  const creditLeftRate = creditLeftRateOf(credit);
  const hasCreditPool = creditLeftRate !== undefined || hasCreditBuckets(credit);
  const isCreditPlan = !hasLiveWindow && (hasCreditPool || flexibleNumber(payload.plan_family) === CREDIT_PLAN_FAMILY);

  const buckets: UsageBucket[] = [];
  const metrics: UsageMetric[] = [];
  if (isCreditPlan) {
    addCreditBucket(
      buckets,
      metrics,
      credit,
      creditLeftRate,
      flexibleTimestamp(credit?.subscription_credit_reset_time),
    );
  } else {
    addRateWindow(
      buckets,
      "five-hour",
      "5h window",
      FIVE_HOUR_WINDOW_MINUTES,
      payload.five_hour_usage_left_rate,
      fiveHourReset,
    );
    addRateWindow(
      buckets,
      "weekly",
      "Weekly window",
      WEEKLY_WINDOW_MINUTES,
      payload.weekly_usage_left_rate,
      weeklyReset,
    );
  }
  if (buckets.length === 0) {
    throw new Error("StepFun quota endpoint returned no displayable usage data.");
  }

  const notes = plan?.name ? [`Plan: ${plan.name}`] : [];
  return {
    providerId,
    providerName,
    capturedAt,
    source: "stepfun-platform",
    semantics: { kind: "consumer-subscription", label: "Step Plan usage" },
    buckets,
    metrics,
    ...(notes.length > 0 ? { notes } : {}),
  };
}

// The plan endpoint only contributes the plan name; a missing or failed response leaves the report
// without one instead of blanking the required quota data.
export function normalizeStepFunPlanStatusPayload(payload: StepFunPlanStatusPayload): StepFunPlanInfo | undefined {
  if (stepfunPayloadError(payload)) return undefined;
  const name = asString(asObject(payload.subscription)?.name);
  return name ? { name } : undefined;
}

function addRateWindow(
  buckets: UsageBucket[],
  id: string,
  label: string,
  windowMinutes: number,
  rawLeftRate: unknown,
  resetsAt: number | undefined,
): void {
  const leftRate = flexibleNumber(rawLeftRate);
  if (leftRate === undefined) return;
  buckets.push({
    id,
    label,
    used: roundPercent((1 - leftRate) * 100),
    remaining: roundPercent(leftRate * 100),
    limit: 100,
    unit: "percent",
    windowMinutes,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  });
}

function addCreditBucket(
  buckets: UsageBucket[],
  metrics: UsageMetric[],
  credit: Record<string, unknown> | undefined,
  creditLeftRate: number | undefined,
  resetsAt: number | undefined,
): void {
  if (creditLeftRate === undefined) return;
  buckets.push({
    id: "credit",
    label: "Monthly credits",
    used: roundPercent((1 - creditLeftRate) * 100),
    remaining: roundPercent(creditLeftRate * 100),
    limit: 100,
    unit: "percent",
    windowMinutes: MONTHLY_WINDOW_MINUTES,
    ...(resetsAt !== undefined ? { resetsAt } : {}),
  });
  const totals = creditBucketTotals(credit);
  if (totals) {
    metrics.push({ id: "credit-remaining", label: "Credits remaining", value: totals.residual, unit: "count" });
    metrics.push({ id: "credit-total", label: "Credits total", value: totals.total, unit: "count" });
  }
}

// Subscription and top-up rates are independent fractions, so they cannot be added into a combined
// rate. Prefer the absolute bucket balances and fall back to the subscription rate, then the
// top-up rate, only when no subscription rate exists.
function creditLeftRateOf(credit: Record<string, unknown> | undefined): number | undefined {
  if (!credit) return undefined;
  const totals = creditBucketTotals(credit);
  if (totals && totals.total > 0) return clampRate(totals.residual / totals.total);
  const subscription = flexibleNumber(credit.subscription_credit_left_rate);
  if (subscription !== undefined) return clampRate(subscription);
  const topup = flexibleNumber(credit.topup_credit_left_rate);
  return topup === undefined ? undefined : clampRate(topup);
}

// Bucket balances are only trusted when every bucket carries a sane total and residual; a single
// malformed bucket falls back to the reported rates.
function creditBucketTotals(
  credit: Record<string, unknown> | undefined,
): { total: number; residual: number } | undefined {
  if (!Array.isArray(credit?.credit_buckets) || credit.credit_buckets.length === 0) return undefined;
  let total = 0;
  let residual = 0;
  for (const raw of credit.credit_buckets) {
    const bucket = asObject(raw);
    const bucketTotal = flexibleNumber(bucket?.credit_total);
    const bucketResidual = flexibleNumber(bucket?.credit_residual);
    if (bucketTotal === undefined || bucketResidual === undefined) return undefined;
    if (bucketTotal <= 0 || bucketResidual < 0 || bucketResidual > bucketTotal) return undefined;
    total += bucketTotal;
    residual += bucketResidual;
  }
  return { total, residual };
}

function hasCreditBuckets(credit: Record<string, unknown> | undefined): boolean {
  return Array.isArray(credit?.credit_buckets) && credit.credit_buckets.length > 0;
}

// The API returns numeric fields as JSON integers, floats, or strings (e.g. "400000000").
function flexibleNumber(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

// Timestamps arrive as strings or integers; a zero value means "no window configured".
function flexibleTimestamp(value: unknown): number | undefined {
  const seconds = flexibleNumber(value);
  if (seconds === undefined || seconds <= 0) return undefined;
  return Math.floor(seconds);
}

function clampRate(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function roundPercent(value: number): number {
  return Math.round(value * 100) / 100;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return sanitizeDisplayText(value, 80) || undefined;
}
