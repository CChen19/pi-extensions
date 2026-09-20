import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from "node:fs";
import { join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const OPENROUTER_MANAGEMENT_API_KEY_ENV = "OPENROUTER_MANAGEMENT_API_KEY";
export const OPENROUTER_CREDENTIALS_FILE_ENV = "OPENROUTER_CREDENTIALS_FILE";

const DEFAULT_CREDENTIALS_FILE = "pi-usage-openrouter.json";
const MAX_CREDENTIALS_FILE_BYTES = 16 * 1024;
const MANAGEMENT_KEY_PATTERN = /^[A-Za-z0-9._~+/=-]{8,8192}$/u;
const NOFOLLOW_FLAG = constants.O_NOFOLLOW;

export type OpenRouterManagementCredentialSource = "environment" | "file";

export interface OpenRouterManagementCredentials {
  managementApiKey?: string;
  source?: OpenRouterManagementCredentialSource;
}

/** Resolve the explicit environment-variable form without touching the filesystem. */
export function openRouterManagementCredentialsFromEnv(
  env: Record<string, string | undefined> = process.env,
): OpenRouterManagementCredentials {
  const rawValue = env[OPENROUTER_MANAGEMENT_API_KEY_ENV];
  if (typeof rawValue !== "string" || rawValue.trim() === "") return {};
  const value = normalizeManagementKey(rawValue);
  if (!value) {
    throw new Error(`${OPENROUTER_MANAGEMENT_API_KEY_ENV} is set but is not a valid Management API key.`);
  }
  return { managementApiKey: value, source: "environment" };
}

/**
 * Resolve account-level credentials. The management key is deliberately kept
 * separate from the runtime inference key used for OpenRouter model requests.
 */
export async function resolveOpenRouterManagementCredentials(
  env: Record<string, string | undefined> = process.env,
): Promise<OpenRouterManagementCredentials> {
  return resolveOpenRouterManagementCredentialsSync(env);
}

/** Synchronous form used while resolving runtime auth so credential discovery adds no event-loop turn. */
export function resolveOpenRouterManagementCredentialsSync(
  env: Record<string, string | undefined> = process.env,
): OpenRouterManagementCredentials {
  const fromEnvironment = openRouterManagementCredentialsFromEnv(env);
  if (fromEnvironment.managementApiKey || env[OPENROUTER_CREDENTIALS_FILE_ENV] === "") {
    return fromEnvironment;
  }

  const credentialsPath = env[OPENROUTER_CREDENTIALS_FILE_ENV] ?? join(getAgentDir(), DEFAULT_CREDENTIALS_FILE);
  return readOpenRouterCredentialsFile(credentialsPath);
}

function readOpenRouterCredentialsFile(path: string): OpenRouterManagementCredentials {
  let descriptor: number | undefined;
  try {
    // O_NOFOLLOW is unavailable on some platforms (notably Windows). Do not silently
    // follow a symlink or reparse point when a secret file is involved.
    if (!NOFOLLOW_FLAG) {
      try {
        lstatSync(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
        throw error;
      }
      throw new Error(
        "OpenRouter management credentials file fallback is unavailable on this platform; set OPENROUTER_MANAGEMENT_API_KEY instead.",
      );
    }
    descriptor = openSync(path, constants.O_RDONLY | NOFOLLOW_FLAG);
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) {
      throw new Error(`OpenRouter management credentials path is not a regular file: ${path}`);
    }
    if (stats.size > MAX_CREDENTIALS_FILE_BYTES) {
      throw new Error(`OpenRouter management credentials file exceeds ${MAX_CREDENTIALS_FILE_BYTES} bytes.`);
    }
    if (process.platform !== "win32" && (stats.mode & 0o077) !== 0) {
      throw new Error(
        `OpenRouter management credentials file must not be accessible by group or other users (mode ${(stats.mode & 0o777).toString(8)}).`,
      );
    }

    const buffer = Buffer.alloc(MAX_CREDENTIALS_FILE_BYTES + 1);
    let offset = 0;
    while (offset <= MAX_CREDENTIALS_FILE_BYTES) {
      const bytesRead = readSync(descriptor, buffer, offset, buffer.length - offset, null);
      if (bytesRead === 0) break;
      offset += bytesRead;
      if (offset > MAX_CREDENTIALS_FILE_BYTES) {
        throw new Error(`OpenRouter management credentials file exceeds ${MAX_CREDENTIALS_FILE_BYTES} bytes.`);
      }
    }
    const contents = buffer.subarray(0, offset).toString("utf8");
    let parsed: unknown;
    try {
      parsed = JSON.parse(contents);
    } catch (error) {
      throw new Error(`OpenRouter management credentials file contains invalid JSON: ${errorMessage(error)}`);
    }
    if (!isRecord(parsed)) {
      throw new Error("OpenRouter management credentials file must contain a JSON object.");
    }

    const canonical = parsed.managementApiKey;
    const alias = parsed.managementKey;
    if (canonical !== undefined && alias !== undefined && canonical !== alias) {
      throw new Error(
        "OpenRouter management credentials file contains conflicting managementApiKey and managementKey values.",
      );
    }
    const value = normalizeManagementKey(typeof canonical === "string" ? canonical : alias);
    if (!value) {
      throw new Error(
        "OpenRouter management credentials file must define managementApiKey or managementKey as a string.",
      );
    }
    return { managementApiKey: value, source: "file" };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return {};
    if (code === "ELOOP" || code === "EMLINK") {
      throw new Error(`OpenRouter management credentials path is not a regular, non-symlink file: ${path}`);
    }
    if (error instanceof Error && error.message.startsWith("OpenRouter management credentials")) throw error;
    throw new Error(`Unable to read OpenRouter management credentials at ${path}: ${errorMessage(error)}`);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function normalizeManagementKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  let key = value.trim();
  if (key.length >= 2 && ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'")))) {
    key = key.slice(1, -1).trim();
  }
  if (!MANAGEMENT_KEY_PATTERN.test(key)) {
    return undefined;
  }
  return key;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
