import { stripVTControlCharacters } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, truncateHead } from "@earendil-works/pi-coding-agent";
import type { JevDecisionInput, JevDecisionResponse } from "./types.js";
import { normalizeJevResponse } from "./validation.js";

export const JEV_ENDPOINT = "https://openrouter.ai/api/alpha/decisions";
export const JEV_MODEL = "~typesafe/jev-latest";
const OPENROUTER_ORIGIN = "https://openrouter.ai";
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_ERROR_BYTES = 2048;

export interface OpenRouterAuthorization {
  authorization: string;
  secrets: string[];
}

export interface JevResultDetails {
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
}

export async function resolveOpenRouterAuthorization(
  ctx: Pick<ExtensionContext, "modelRegistry">,
): Promise<OpenRouterAuthorization> {
  const result = await ctx.modelRegistry.getProviderAuth("openrouter");
  if (!result) {
    throw new Error("OpenRouter authentication is not configured. Run /login openrouter or set OPENROUTER_API_KEY.");
  }

  assertOfficialOpenRouterUrl(result.auth.baseUrl, "resolved OpenRouter authentication");
  const provider = ctx.modelRegistry.getProvider("openrouter");
  assertOfficialOpenRouterUrl(provider?.baseUrl, "configured OpenRouter provider");

  const configuredHeader = headerValue(result.auth.headers, "authorization")?.trim();
  const apiKey = result.auth.apiKey?.trim();
  const authorization = configuredHeader || (apiKey ? `Bearer ${apiKey}` : undefined);
  if (!authorization || !/^Bearer\s+\S+$/iu.test(authorization)) {
    throw new Error("OpenRouter authentication did not resolve to a Bearer credential.");
  }

  const token = authorization.replace(/^Bearer\s+/iu, "");
  return {
    authorization,
    secrets: [...new Set([apiKey, configuredHeader, authorization, token].filter(isNonEmptyString))],
  };
}

export async function requestJevDecision(
  input: JevDecisionInput,
  auth: OpenRouterAuthorization,
  signal: AbortSignal | undefined,
  fetchImpl: typeof fetch = fetch,
): Promise<JevDecisionResponse> {
  const body = JSON.stringify({
    model: JEV_MODEL,
    state: input.state,
    questions: input.questions,
  });
  if (Buffer.byteLength(body, "utf8") > MAX_REQUEST_BYTES) {
    throw new Error(`Jev request exceeds the ${formatSize(MAX_REQUEST_BYTES)} request limit.`);
  }

  const response = await fetchImpl(JEV_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: auth.authorization,
      "Content-Type": "application/json",
    },
    body,
    signal,
  });
  const responseText = await response.text();
  if (Buffer.byteLength(responseText, "utf8") > MAX_RESPONSE_BYTES) {
    throw new Error(`OpenRouter Jev response exceeds the ${formatSize(MAX_RESPONSE_BYTES)} response limit.`);
  }
  if (!response.ok) {
    const detail = formatErrorDetail(responseText, auth.secrets);
    throw new Error(`OpenRouter Jev request failed (${response.status})${detail ? `: ${detail}` : ""}`);
  }

  let payload: unknown;
  try {
    payload = JSON.parse(responseText) as unknown;
  } catch {
    throw new Error("OpenRouter Jev returned a non-JSON response.");
  }
  try {
    return normalizeJevResponse(payload, input);
  } catch (error) {
    throw new Error(`OpenRouter Jev returned an invalid response: ${errorMessage(error)}`);
  }
}

export function formatJevResult(response: JevDecisionResponse) {
  const serialized = escapeTerminalControls(JSON.stringify(response, null, 2));
  const initial = truncateHead(serialized, {
    maxBytes: DEFAULT_MAX_BYTES,
    maxLines: DEFAULT_MAX_LINES,
  });
  if (!initial.truncated) {
    return {
      content: [{ type: "text" as const, text: initial.content }],
      details: resultDetails(initial, false),
    };
  }

  let byteBudget = DEFAULT_MAX_BYTES;
  let lineBudget = DEFAULT_MAX_LINES;
  for (;;) {
    const excerpt = truncateHead(serialized, { maxBytes: byteBudget, maxLines: lineBudget });
    const footer = `[Jev output truncated: showing ${excerpt.outputLines} of ${excerpt.totalLines} lines (${formatSize(excerpt.outputBytes)} of ${formatSize(excerpt.totalBytes)}). Ask fewer questions or use fewer choice options.]`;
    const separator = excerpt.content ? "\n\n" : "";
    const text = `${excerpt.content}${separator}${footer}`;
    if (Buffer.byteLength(text, "utf8") <= DEFAULT_MAX_BYTES && countLines(text) <= DEFAULT_MAX_LINES) {
      return {
        content: [{ type: "text" as const, text }],
        details: resultDetails(excerpt, true),
      };
    }
    const nextByteBudget = Math.max(0, DEFAULT_MAX_BYTES - Buffer.byteLength(footer, "utf8") - 2);
    const nextLineBudget = Math.max(0, DEFAULT_MAX_LINES - countLines(footer) - 1);
    if (nextByteBudget === byteBudget && nextLineBudget === lineBudget) {
      throw new Error("Could not fit the Jev truncation notice within Pi's tool output limits.");
    }
    byteBudget = Math.min(byteBudget, nextByteBudget);
    lineBudget = Math.min(lineBudget, nextLineBudget);
  }
}

function resultDetails(
  truncation: {
    truncatedBy?: "lines" | "bytes" | null;
    totalLines: number;
    totalBytes: number;
    outputLines: number;
    outputBytes: number;
  },
  truncated: boolean,
): JevResultDetails {
  return {
    truncated,
    ...(truncation.truncatedBy ? { truncatedBy: truncation.truncatedBy } : {}),
    totalLines: truncation.totalLines,
    totalBytes: truncation.totalBytes,
    outputLines: truncation.outputLines,
    outputBytes: truncation.outputBytes,
  };
}

function formatErrorDetail(responseText: string, secrets: readonly string[]): string {
  if (!responseText) return "";
  let value = responseText;
  try {
    const payload = JSON.parse(responseText) as unknown;
    if (isRecord(payload) && typeof payload.error === "string") value = payload.error;
    else if (isRecord(payload) && isRecord(payload.error) && typeof payload.error.message === "string") {
      value = payload.error.message;
    } else if (isRecord(payload) && typeof payload.message === "string") value = payload.message;
    else value = JSON.stringify(payload);
  } catch {
    // Keep the plain-text response.
  }
  for (const secret of [...secrets].sort((left, right) => right.length - left.length)) {
    value = value.replaceAll(secret, "[redacted]");
  }
  const safe = stripControlCharacters(stripVTControlCharacters(value)).replace(/\s+/gu, " ").trim();
  return truncateHead(safe, { maxBytes: MAX_ERROR_BYTES, maxLines: 1 }).content;
}

function escapeTerminalControls(value: string): string {
  let escaped = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if ((code >= 0x7f && code <= 0x9f) || (code >= 0x202a && code <= 0x202e) || (code >= 0x2066 && code <= 0x2069)) {
      escaped += `\\u${code.toString(16).padStart(4, "0")}`;
    } else {
      escaped += character;
    }
  }
  return escaped;
}

function stripControlCharacters(value: string): string {
  let safe = "";
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    safe += code <= 0x08 || (code >= 0x0b && code <= 0x1f) || (code >= 0x7f && code <= 0x9f) ? " " : character;
  }
  return safe;
}

function assertOfficialOpenRouterUrl(value: string | undefined, source: string): void {
  if (!value) return;
  let origin: string;
  try {
    origin = new URL(value).origin;
  } catch {
    throw new Error(`The ${source} has an invalid base URL.`);
  }
  if (origin !== OPENROUTER_ORIGIN) {
    throw new Error(`The ${source} uses a proxy base URL; refusing to send that credential to OpenRouter.`);
  }
}

function headerValue(headers: Record<string, string | null> | undefined, name: string): string | undefined {
  if (!headers) return undefined;
  const entry = Object.entries(headers).find(([key]) => key.toLowerCase() === name.toLowerCase());
  return typeof entry?.[1] === "string" ? entry[1] : undefined;
}

function countLines(content: string): number {
  if (!content) return 0;
  const lines = content.split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines.length;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
