import { createHash } from "node:crypto";
import { chunkTextFile } from "./chunks.js";
import type { SearchDatabase } from "./database.js";
import { type DiscoveryResult, loadTextFile, UnsupportedSearchFileError } from "./files.js";

export interface IndexProgress {
  current: number;
  total: number;
  path: string;
}

export interface IndexUpdateResult {
  indexed: number;
  unchanged: number;
  removed: number;
  skipped: number;
}

const mutationQueues = new Map<string, Promise<void>>();

export function refreshIndex(
  database: SearchDatabase,
  discovery: DiscoveryResult,
  signal?: AbortSignal,
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexUpdateResult> {
  return enqueueMutation(database.path, () => refreshIndexNow(database, discovery, signal, onProgress));
}

async function refreshIndexNow(
  database: SearchDatabase,
  discovery: DiscoveryResult,
  signal?: AbortSignal,
  onProgress?: (progress: IndexProgress) => void,
): Promise<IndexUpdateResult> {
  signal?.throwIfAborted();
  const existing = new Map(database.listFiles().map((file) => [file.path, file]));
  const discoveredPaths = new Set(discovery.files.map((file) => file.path));
  let indexed = 0;
  let unchanged = 0;
  let skipped = discovery.skippedFiles;

  for (let index = 0; index < discovery.files.length; index += 1) {
    signal?.throwIfAborted();
    const file = discovery.files[index];
    if (!file) continue;
    onProgress?.({ current: index + 1, total: discovery.files.length, path: file.path });
    const previous = existing.get(file.path);
    if (
      previous &&
      previous.dev === file.dev &&
      previous.ino === file.ino &&
      previous.size === file.size &&
      previous.mtimeNs === file.mtimeNs
    ) {
      unchanged += 1;
      continue;
    }

    try {
      const loaded = await loadTextFile(file, discovery.root, signal);
      signal?.throwIfAborted();
      const chunked = chunkTextFile(file.path, loaded.lines);
      const hash = createHash("sha256").update(loaded.text, "utf8").digest("hex");
      database.replaceFile(
        {
          path: file.path,
          dev: file.dev,
          ino: file.ino,
          size: file.size,
          mtimeNs: file.mtimeNs,
          hash,
          title: chunked.title,
          outline: chunked.outline,
        },
        chunked.chunks,
      );
      indexed += 1;
    } catch (error: unknown) {
      if (signal?.aborted || isAbortError(error)) throw error;
      if (error instanceof UnsupportedSearchFileError) {
        database.removeFiles([file.path]);
      }
      skipped += 1;
    }
  }

  signal?.throwIfAborted();
  const removedPaths = [...existing.keys()].filter((path) => !discoveredPaths.has(path));
  database.removeFiles(removedPaths);
  await database.secureArtifacts();
  return { indexed, unchanged, removed: removedPaths.length, skipped };
}

function enqueueMutation<T>(path: string, mutation: () => Promise<T>): Promise<T> {
  const previous = mutationQueues.get(path) ?? Promise.resolve();
  const result = previous.then(mutation, mutation);
  const settled = result.then(
    () => undefined,
    () => undefined,
  );
  mutationQueues.set(path, settled);
  void settled.finally(() => {
    if (mutationQueues.get(path) === settled) mutationQueues.delete(path);
  });
  return result;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "APIUserAbortError");
}
