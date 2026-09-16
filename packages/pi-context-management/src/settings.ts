import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export const CONTEXT_MANAGEMENT_SETTINGS_FILE = "pi-context-management.json";
export const MAX_SETTINGS_BYTES = 64 * 1024;

export interface ContextManagementSettings {
  enabled: boolean;
}

export const DEFAULT_CONTEXT_MANAGEMENT_SETTINGS: Readonly<ContextManagementSettings> = Object.freeze({
  enabled: false,
});

export interface ContextManagementSettingsState {
  kind: "missing" | "loaded" | "invalid";
  path: string;
  settings: ContextManagementSettings;
  document?: Record<string, unknown>;
  issue?: string;
}

export interface ContextManagementSettingsRuntime {
  get(): Readonly<ContextManagementSettingsState>;
  reload(signal?: AbortSignal): Promise<Readonly<ContextManagementSettingsState>>;
  update(
    patch: Partial<ContextManagementSettings>,
    signal?: AbortSignal,
  ): Promise<Readonly<ContextManagementSettingsState>>;
  flush(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function normalizeContextManagementSettings(value: unknown): ContextManagementSettings | undefined {
  if (!isRecord(value)) return undefined;
  if (Object.hasOwn(value, "enabled") && typeof value.enabled !== "boolean") return undefined;
  return {
    enabled: typeof value.enabled === "boolean" ? value.enabled : DEFAULT_CONTEXT_MANAGEMENT_SETTINGS.enabled,
  };
}

export function contextManagementSettingsPath(): string {
  return join(getAgentDir(), CONTEXT_MANAGEMENT_SETTINGS_FILE);
}

function aborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException("Settings operation aborted", "AbortError");
}

export async function loadContextManagementSettings(
  path = contextManagementSettingsPath(),
  signal?: AbortSignal,
): Promise<ContextManagementSettingsState> {
  aborted(signal);
  try {
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    let text: string;
    try {
      const stats = await handle.stat();
      aborted(signal);
      if (!stats.isFile()) throw new Error("settings path is not a regular file");
      if (stats.size > MAX_SETTINGS_BYTES) throw new Error("settings file exceeds 64 KiB");
      text = await handle.readFile("utf8");
    } finally {
      await handle.close();
    }
    aborted(signal);
    const document = JSON.parse(text) as unknown;
    const settings = normalizeContextManagementSettings(document);
    if (!settings || !isRecord(document)) throw new Error("invalid settings shape");
    return { kind: "loaded", path, settings, document };
  } catch (error) {
    if (signal?.aborted) throw error;
    if (isNodeError(error) && error.code === "ENOENT") {
      return {
        kind: "missing",
        path,
        settings: { ...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS },
        document: {},
      };
    }
    return {
      kind: "invalid",
      path,
      settings: { ...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS },
      issue:
        isNodeError(error) && error.code === "ELOOP"
          ? "symbolic links are not accepted"
          : error instanceof Error
            ? error.message
            : String(error),
    };
  }
}

async function savePatch(
  path: string,
  patch: Partial<ContextManagementSettings>,
  signal?: AbortSignal,
): Promise<ContextManagementSettingsState> {
  const latest = await loadContextManagementSettings(path, signal);
  if (latest.kind === "invalid") {
    throw new Error("Cannot overwrite an invalid pi-context-management.json; repair it and reload first");
  }
  const document = { ...latest.document, ...patch };
  const settings = normalizeContextManagementSettings(document);
  if (!settings) throw new Error("Refusing to save invalid context management settings");
  const temporaryPath = join(dirname(path), `.${basename(path)}.${randomUUID()}.tmp`);
  await mkdir(dirname(path), { recursive: true });
  aborted(signal);
  try {
    await writeFile(temporaryPath, `${JSON.stringify(document, null, 2)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    aborted(signal);
    const current = await loadContextManagementSettings(path, signal);
    if (
      current.kind === "invalid" ||
      current.kind !== latest.kind ||
      JSON.stringify(current.document) !== JSON.stringify(latest.document)
    ) {
      throw new Error("pi-context-management.json changed while saving; reopen settings and retry");
    }
    await rename(temporaryPath, path);
  } finally {
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
  return { kind: "loaded", path, settings, document };
}

export function createContextManagementSettingsRuntime(
  path = contextManagementSettingsPath(),
): ContextManagementSettingsRuntime {
  let state: ContextManagementSettingsState = {
    kind: "missing",
    path,
    settings: { ...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS },
    document: {},
  };
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
    get: () => structuredClone(state),
    reload: (signal) =>
      enqueue(async () => {
        state = await loadContextManagementSettings(path, signal);
        return structuredClone(state);
      }),
    update: (patch, signal) =>
      enqueue(async () => {
        state = await savePatch(path, patch, signal);
        return structuredClone(state);
      }),
    flush: () => queue,
  };
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}
