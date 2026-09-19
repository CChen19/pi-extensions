import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const JEV_COMPACTION_SETTINGS_FILE = "pi-jev-compaction.json";
export const MAX_SETTINGS_BYTES = 64 * 1024;
const MAX_API_KEY_LENGTH = 16 * 1024;

export interface JevCompactionSettings {
  apiKey?: string;
}

export interface JevCompactionSettingsState {
  kind: "missing" | "loaded" | "invalid";
  path: string;
  settings: JevCompactionSettings;
  document?: Record<string, unknown>;
  issue?: string;
  fingerprint?: string;
}

export interface JevCompactionSettingsRuntime {
  get(): Readonly<JevCompactionSettingsState>;
  reload(signal?: AbortSignal): Promise<Readonly<JevCompactionSettingsState>>;
  setApiKey(apiKey: string, signal?: AbortSignal): Promise<Readonly<JevCompactionSettingsState>>;
  removeApiKey(signal?: AbortSignal): Promise<Readonly<JevCompactionSettingsState>>;
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0) ?? 0;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
  });
}

export function normalizeApiKey(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_API_KEY_LENGTH || hasControlCharacter(normalized)) return undefined;
  return normalized;
}

export function normalizeJevCompactionSettings(value: unknown): JevCompactionSettings | undefined {
  if (!isRecord(value)) return undefined;
  if (!Object.hasOwn(value, "apiKey")) return {};
  const apiKey = normalizeApiKey(value.apiKey);
  return apiKey ? { apiKey } : undefined;
}

export function jevCompactionSettingsPath(): string {
  return join(getAgentDir(), JEV_COMPACTION_SETTINGS_FILE);
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

function cloneState(state: JevCompactionSettingsState): JevCompactionSettingsState {
  return structuredClone(state);
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

export async function loadJevCompactionSettings(
  path = jevCompactionSettingsPath(),
  signal?: AbortSignal,
): Promise<JevCompactionSettingsState> {
  throwIfAborted(signal);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const stats = await handle.stat();
      throwIfAborted(signal);
      if (!stats.isFile()) throw new Error("settings path is not a regular file");
      if (stats.size > MAX_SETTINGS_BYTES) throw new Error("settings file exceeds 64 KiB");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    throwIfAborted(signal);
    const document = JSON.parse(text) as unknown;
    const settings = normalizeJevCompactionSettings(document);
    if (!settings || !isRecord(document)) throw new Error("invalid settings shape or API key");
    return { kind: "loaded", path, settings, document, fingerprint: text };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      return { kind: "missing", path, settings: {}, document: {} };
    }
    return {
      kind: "invalid",
      path,
      settings: {},
      issue:
        isNodeError(error) && error.code === "ELOOP"
          ? "symbolic links are not accepted"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function saveApiKeyMutation(
  path: string,
  apiKey: string | undefined,
  signal?: AbortSignal,
): Promise<JevCompactionSettingsState> {
  const latest = await loadJevCompactionSettings(path, signal);
  if (latest.kind === "invalid") {
    throw new Error("Cannot overwrite an invalid pi-jev-compaction.json; repair it and reload first");
  }
  const document = { ...(latest.document ?? {}) };
  if (apiKey === undefined) delete document.apiKey;
  else document.apiKey = apiKey;
  const settings = normalizeJevCompactionSettings(document);
  if (!settings) throw new Error("Refusing to save invalid JEV compaction settings");

  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  throwIfAborted(signal);
  try {
    const text = `${JSON.stringify(document, null, 2)}\n`;
    await writeFile(temporaryPath, text, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    throwIfAborted(signal);
    const current = await loadJevCompactionSettings(path, signal);
    const unchanged =
      current.kind === latest.kind && (latest.kind === "missing" || current.fingerprint === latest.fingerprint);
    if (!unchanged) throw new Error("pi-jev-compaction.json changed while saving; reopen settings and retry");
    await rename(temporaryPath, path);
    return { kind: "loaded", path, settings, document, fingerprint: text };
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

export function createJevCompactionSettingsRuntime(path = jevCompactionSettingsPath()): JevCompactionSettingsRuntime {
  let state: JevCompactionSettingsState = { kind: "missing", path, settings: {}, document: {} };
  let queue = Promise.resolve();
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const result = queue.then(operation, operation);
    queue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  };

  return {
    get: () => cloneState(state),
    reload: (signal) =>
      enqueue(async () => {
        state = await loadJevCompactionSettings(path, signal);
        return cloneState(state);
      }),
    setApiKey: (value, signal) =>
      enqueue(async () => {
        const apiKey = normalizeApiKey(value);
        if (!apiKey) throw new Error("TypeSafe API key must be non-empty and contain no control characters");
        state = await saveApiKeyMutation(path, apiKey, signal);
        return cloneState(state);
      }),
    removeApiKey: (signal) =>
      enqueue(async () => {
        state = await saveApiKeyMutation(path, undefined, signal);
        return cloneState(state);
      }),
    flush: () => queue,
  };
}
