import { constants } from "node:fs";
import { type FileHandle, open } from "node:fs/promises";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { abortError, errorMessage, redactUsageError } from "../core.js";

// StepFun signs China and overseas web sessions for different platform origins and app IDs. The
// token's app_id claim selects the destination; the official model origin is only a fallback for
// legacy tokens without that claim. A token is never sent to the other region.
export interface StepFunPlatform {
  readonly origin: "https://platform.stepfun.com" | "https://platform.stepfun.ai";
  readonly appId: "10300" | "20700";
}

export const STEPFUN_CHINA_PLATFORM: StepFunPlatform = Object.freeze({
  origin: "https://platform.stepfun.com",
  appId: "10300",
});
export const STEPFUN_OVERSEAS_PLATFORM: StepFunPlatform = Object.freeze({
  origin: "https://platform.stepfun.ai",
  appId: "20700",
});
export const STEPFUN_DEFAULT_WEB_ID = "c8a1002d2c457e758785a9979832217c7c0b884c";

const STEPFUN_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36";
const STEPFUN_CREDENTIALS_FILE = "pi-usage-stepfun.json";
const MAX_CREDENTIAL_FILE_BYTES = 16 * 1024;
const MAX_SUCCESS_BODY_BYTES = 64 * 1024;
const MAX_ERROR_BODY_BYTES = 4 * 1024;
const TOKEN_PATTERN = /^[A-Za-z0-9._~+/-]{8,8192}$/u;
const DEVICE_ID_PATTERN = /^[A-Za-z0-9._~-]{1,128}$/u;

export interface StepFunCredentials {
  token?: string;
}

export function stepfunCredentialsFromEnv(env: Record<string, string | undefined> = process.env): StepFunCredentials {
  return { token: normalizeStepFunToken(env.STEPFUN_TOKEN) };
}

// Daemon and desktop launchers may not inherit shell variables. When STEPFUN_TOKEN is absent, read
// an owner-private JSON file from Pi's agent directory. An explicitly empty file variable disables
// the fallback, which is also useful for isolated tests.
export async function resolveStepFunCredentials(
  env: Record<string, string | undefined> = process.env,
): Promise<StepFunCredentials> {
  const fromEnv = stepfunCredentialsFromEnv(env);
  if (fromEnv.token || env.STEPFUN_CREDENTIALS_FILE === "") return fromEnv;
  const path = env.STEPFUN_CREDENTIALS_FILE ?? join(getAgentDir(), STEPFUN_CREDENTIALS_FILE);
  return readStepFunCredentialsFile(path);
}

async function readStepFunCredentialsFile(path: string): Promise<StepFunCredentials> {
  let handle: FileHandle;
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch (error) {
    if (errorCode(error) === "ENOENT") return {};
    throw new Error("StepFun credentials file could not be opened safely.");
  }
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.size > MAX_CREDENTIAL_FILE_BYTES) {
      throw new Error("StepFun credentials file is invalid.");
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error("StepFun credentials file must be readable only by its owner (mode 600).");
    }
    const value = asObject(JSON.parse(await handle.readFile("utf8")) as unknown);
    if (!value || !validOptionalString(value.token)) throw new Error("StepFun credentials file is invalid.");
    return { token: normalizeStepFunToken(value.token as string | undefined) };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("StepFun credentials file")) throw error;
    throw new Error("StepFun credentials file is invalid.");
  } finally {
    await handle.close();
  }
}

// Accept a raw Oasis-Token, a browser cookie header, or a shell-quoted value.
export function normalizeStepFunToken(value: string | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  let token = value.trim();
  const cookieMatch = /(?:^|;\s*)Oasis-Token=([^;]*)/iu.exec(token);
  if (cookieMatch) token = cookieMatch[1] ?? "";
  if (
    token.length >= 2 &&
    ((token.startsWith('"') && token.endsWith('"')) || (token.startsWith("'") && token.endsWith("'")))
  ) {
    token = token.slice(1, -1).trim();
  }
  return token ? token.slice(0, 8192) : undefined;
}

export function requireStepFunToken(credentials: StepFunCredentials): string {
  if (!credentials.token) {
    throw new Error(
      "StepFun platform credentials are not configured. Set STEPFUN_TOKEN or create ~/.pi/agent/pi-usage-stepfun.json with an Oasis-Token.",
    );
  }
  if (!TOKEN_PATTERN.test(credentials.token)) throw new Error("StepFun Oasis-Token format is invalid.");
  return credentials.token;
}

export async function refreshStepFunSession(
  token: string,
  signal: AbortSignal,
  timeoutMs: number,
  fallbackPlatform: StepFunPlatform = STEPFUN_CHINA_PLATFORM,
): Promise<string> {
  const platform = stepfunPlatformForToken(token) ?? fallbackPlatform;
  const webid = stepfunWebId(token);
  const response = await stepfunPlatformFetch(
    `${platform.origin}/passport/proto.api.passport.v1.PassportService/RefreshToken`,
    {
      headers: {
        ...stepfunBaseHeaders(platform),
        "oasis-webid": webid,
        "Oasis-Token": token,
        Cookie: `Oasis-Token=${token}; Oasis-Webid=${webid}`,
      },
      signal,
      timeoutMs,
      secrets: [token],
    },
  );
  if (!response.ok) throw new Error(`StepFun platform session request failed with HTTP ${response.status}.`);
  const refreshed = combinedToken(parseJson(response.text));
  if (!refreshed) throw new Error("StepFun token refresh did not return a session token.");
  return refreshed;
}

// The refresh half carries the device_id claim that must match Oasis-Webid.
export function stepfunWebId(token: string): string {
  for (const half of token.split("...").reverse()) {
    const deviceId = jwtPayload(half)?.device_id;
    if (typeof deviceId === "string" && DEVICE_ID_PATTERN.test(deviceId)) return deviceId;
  }
  return STEPFUN_DEFAULT_WEB_ID;
}

export function stepfunPlatformForApiBaseUrl(baseUrl: string): StepFunPlatform {
  let hostname: string;
  try {
    hostname = new URL(baseUrl).hostname.toLowerCase();
  } catch {
    throw new Error("StepFun model base URL is invalid.");
  }
  if (hostname === "api.stepfun.ai") return STEPFUN_OVERSEAS_PLATFORM;
  if (hostname === "api.stepfun.com") return STEPFUN_CHINA_PLATFORM;
  throw new Error("StepFun model base URL is not an official StepFun origin.");
}

export function stepfunPlatformForToken(token: string): StepFunPlatform | undefined {
  for (const half of token.split("...").reverse()) {
    const appId = jwtPayload(half)?.app_id;
    const normalized = typeof appId === "string" || typeof appId === "number" ? String(appId) : undefined;
    if (normalized === STEPFUN_OVERSEAS_PLATFORM.appId) return STEPFUN_OVERSEAS_PLATFORM;
    if (normalized === STEPFUN_CHINA_PLATFORM.appId) return STEPFUN_CHINA_PLATFORM;
  }
  return undefined;
}

export function stepfunDashboardUrl(
  platform: StepFunPlatform,
  method: "QueryStepPlanRateLimit" | "GetStepPlanStatus",
): string {
  return `${platform.origin}/api/step.openapi.devcenter.Dashboard/${method}`;
}

export function stepfunRequestHeaders(
  token: string,
  fallbackPlatform: StepFunPlatform = STEPFUN_CHINA_PLATFORM,
): Record<string, string> {
  const webid = stepfunWebId(token);
  const platform = stepfunPlatformForToken(token) ?? fallbackPlatform;
  return {
    ...stepfunBaseHeaders(platform),
    "oasis-webid": webid,
    Cookie: `Oasis-Token=${token}; Oasis-Webid=${webid}`,
  };
}

async function stepfunPlatformFetch(
  url: string,
  request: {
    headers: Record<string, string>;
    signal: AbortSignal;
    timeoutMs: number;
    secrets: readonly string[];
  },
): Promise<{ ok: boolean; status: number; text: string }> {
  const controller = new AbortController();
  const abortFromCaller = () => controller.abort();
  if (request.signal.aborted) controller.abort();
  else request.signal.addEventListener("abort", abortFromCaller, { once: true });
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: request.headers,
      body: "{}",
      signal: controller.signal,
      redirect: "error",
    });
    if (controller.signal.aborted) throw abortError();
    const text = await readBoundedText(
      response,
      response.ok ? MAX_SUCCESS_BODY_BYTES : MAX_ERROR_BODY_BYTES,
      controller.signal,
    );
    if (controller.signal.aborted) throw abortError();
    return { ok: response.ok, status: response.status, text };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw error;
    throw new Error(redactUsageError(errorMessage(error), request.secrets));
  } finally {
    clearTimeout(timeout);
    request.signal.removeEventListener("abort", abortFromCaller);
  }
}

async function readBoundedText(response: Response, maxBytes: number, signal: AbortSignal): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const cancel = () => void reader.cancel().catch(() => undefined);
  if (signal.aborted) cancel();
  else signal.addEventListener("abort", cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const remaining = maxBytes - total;
      if (value.byteLength > remaining) {
        if (remaining > 0) {
          chunks.push(value.subarray(0, remaining));
          total += remaining;
        }
        await reader.cancel();
        break;
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } finally {
    signal.removeEventListener("abort", cancel);
  }
  const merged = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function combinedToken(payload: unknown): string | undefined {
  const object = asObject(payload);
  const access = tokenRaw(object?.accessToken);
  if (!access) return undefined;
  const refresh = tokenRaw(object?.refreshToken);
  return refresh ? `${access}...${refresh}` : access;
}

function tokenRaw(value: unknown): string | undefined {
  const raw = asObject(value)?.raw;
  return typeof raw === "string" && TOKEN_PATTERN.test(raw) ? raw : undefined;
}

function stepfunBaseHeaders(platform: StepFunPlatform): Record<string, string> {
  return {
    "content-type": "application/json",
    "oasis-appid": platform.appId,
    "oasis-platform": "web",
    "oasis-webid": STEPFUN_DEFAULT_WEB_ID,
    "user-agent": STEPFUN_USER_AGENT,
  };
}

function jwtPayload(jwt: string): Record<string, unknown> | undefined {
  const payload = jwt.split(".")[1];
  if (!payload) return undefined;
  try {
    return asObject(JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as unknown);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function validOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string";
}

function errorCode(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error && typeof error.code === "string"
    ? error.code
    : undefined;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
