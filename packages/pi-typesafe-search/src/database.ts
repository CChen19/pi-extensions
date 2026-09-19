import { createHash, randomUUID } from "node:crypto";
import { chmodSync, lstatSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import type { SearchChunk } from "./chunks.js";
import { INDEX_POLICY_VERSION, SCHEMA_VERSION } from "./constants.js";
import { searchableText } from "./text-normalization.js";

const DATABASE_DIRECTORY_MODE = 0o700;
const DATABASE_FILE_MODE = 0o600;
const BUSY_TIMEOUT_MS = 5_000;
const DATABASE_LOCK_WAIT_MS = 10_000;
const DATABASE_LOCK_RETRY_MS = 25;
const INCOMPLETE_LOCK_STALE_MS = 2_000;

export interface IndexedFileRecord {
  path: string;
  dev: string;
  ino: string;
  size: number;
  mtimeNs: string;
  hash: string;
  title: string;
  outline: string;
}

export interface StoredFileRecord extends IndexedFileRecord {}

export interface StoredChunk {
  id: number;
  filePath: string;
  sequence: number;
  startLine: number;
  endLine: number;
  heading: string;
  body: string;
  hash: string;
}

export interface FtsChunk extends StoredChunk {
  bm25: number;
}

export interface FileMapRecord {
  path: string;
  title: string;
  outline: string;
}

export function databasePathForRoot(root: string, agentDirectory = getAgentDir()): string {
  const digest = createHash("sha256").update(root, "utf8").digest("hex");
  return join(agentDirectory, "pi-typesafe-search", "indexes", `${digest}.sqlite`);
}

export async function openSearchDatabase(root: string, agentDirectory = getAgentDir()): Promise<SearchDatabase> {
  const path = databasePathForRoot(root, agentDirectory);
  await ensurePrivateIndexDirectory(agentDirectory);
  const release = await acquireDatabaseLock(path);
  let database: SearchDatabase | undefined;
  let openError: unknown;
  try {
    database = await openSearchDatabaseLocked(path, root);
  } catch (error) {
    openError = error;
  }
  try {
    await release();
  } catch (error) {
    database?.close();
    throw openError
      ? new Error(`Cannot open search index (${formatError(openError)}) or release its lock: ${formatError(error)}`)
      : error;
  }
  if (openError) throw openError;
  if (!database) throw new Error("Search index did not open");
  return database;
}

async function openSearchDatabaseLocked(path: string, root: string): Promise<SearchDatabase> {
  const state = await databasePathState(path);
  if (state === "unsafe") throw new Error(`Search index path is not a private regular file: ${path}`);
  if (state === "missing") {
    const database = createDatabase(path, root);
    try {
      await secureDatabaseArtifacts(path);
      return database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  let existing: SearchDatabase | undefined;
  try {
    existing = new SearchDatabase(path, root);
    existing.validate();
  } catch (error: unknown) {
    existing?.close();
    await rebuildDatabase(path, root).catch((rebuildError: unknown) => {
      throw new Error(`Cannot recover search index (${formatError(error)}): ${formatError(rebuildError)}`);
    });
    existing = openValidatedDatabase(path, root);
  }
  try {
    await secureDatabaseArtifacts(path);
    return existing;
  } catch (error) {
    existing.close();
    throw error;
  }
}

export class SearchDatabase {
  readonly path: string;
  private readonly database: DatabaseSync;
  private readonly root: string;
  private closed = false;

  constructor(path: string, root: string, initialize = false) {
    this.path = path;
    this.root = root;
    const database = new DatabaseSync(path);
    try {
      const stats = lstatSync(path);
      if (!stats.isFile() || stats.isSymbolicLink()) throw new Error("Search index is not a regular file");
      if (process.platform !== "win32") chmodSync(path, DATABASE_FILE_MODE);
      configureDatabase(database);
      if (initialize) initializeSchema(database, root);
      this.database = database;
    } catch (error) {
      database.close();
      throw error;
    }
  }

  validate(): void {
    this.assertOpen();
    const integrity = this.database.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
    if (integrity?.quick_check !== "ok") throw new Error("SQLite quick_check failed");
    const metadata = Object.fromEntries(
      (this.database.prepare("SELECT key, value FROM meta").all() as Array<{ key: string; value: string }>).map(
        (row) => [row.key, row.value],
      ),
    );
    if (metadata.schema_version !== SCHEMA_VERSION) throw new Error("Search index schema version changed");
    if (metadata.index_policy_version !== INDEX_POLICY_VERSION) throw new Error("Search index policy version changed");
    if (metadata.workspace_root !== this.root) throw new Error("Search index workspace root changed");
  }

  getFile(path: string): StoredFileRecord | undefined {
    this.assertOpen();
    return rowToFile(this.database.prepare("SELECT * FROM files WHERE path = ?").get(path));
  }

  listFiles(): StoredFileRecord[] {
    this.assertOpen();
    return (this.database.prepare("SELECT * FROM files ORDER BY path").all() as unknown[]).flatMap((row) => {
      const file = rowToFile(row);
      return file ? [file] : [];
    });
  }

  replaceFile(file: IndexedFileRecord, chunks: readonly SearchChunk[]): void {
    this.assertOpen();
    this.transaction(() => {
      this.database.prepare("DELETE FROM chunks WHERE file_path = ?").run(file.path);
      this.database
        .prepare(
          `INSERT INTO files(path, dev, ino, size, mtime_ns, hash, title, outline)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(path) DO UPDATE SET
             dev = excluded.dev,
             ino = excluded.ino,
             size = excluded.size,
             mtime_ns = excluded.mtime_ns,
             hash = excluded.hash,
             title = excluded.title,
             outline = excluded.outline`,
        )
        .run(file.path, file.dev, file.ino, file.size, file.mtimeNs, file.hash, file.title, file.outline);
      const insert = this.database.prepare(
        `INSERT INTO chunks(
          file_path, seq, start_line, end_line, heading, body, hash,
          search_path, search_title, search_heading, search_body
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const chunk of chunks) {
        insert.run(
          file.path,
          chunk.sequence,
          chunk.startLine,
          chunk.endLine,
          chunk.heading,
          chunk.body,
          chunk.hash,
          searchableText(file.path),
          searchableText(file.title),
          searchableText(chunk.heading),
          searchableText(chunk.body),
        );
      }
    });
  }

  removeFiles(paths: readonly string[]): void {
    this.assertOpen();
    if (paths.length === 0) return;
    this.transaction(() => {
      const remove = this.database.prepare("DELETE FROM files WHERE path = ?");
      for (const path of paths) remove.run(path);
    });
  }

  setUnavailableFiles(paths: readonly string[]): void {
    this.assertOpen();
    this.database.exec("DELETE FROM temp.unavailable_files");
    const insert = this.database.prepare("INSERT OR IGNORE INTO temp.unavailable_files(path) VALUES (?)");
    for (const path of paths) insert.run(path);
  }

  searchFts(expression: string, limit: number, filePath?: string): FtsChunk[] {
    this.assertOpen();
    const filter = filePath === undefined ? "" : "AND c.file_path = ?";
    const statement = this.database.prepare(
      `SELECT c.id, c.file_path, c.seq, c.start_line, c.end_line, c.heading, c.body, c.hash,
              bm25(chunks_fts, 3.0, 2.5, 2.0, 1.0) AS bm25
       FROM chunks_fts
       JOIN chunks c ON c.id = chunks_fts.rowid
       WHERE chunks_fts MATCH ?
         AND NOT EXISTS (SELECT 1 FROM temp.unavailable_files u WHERE u.path = c.file_path)
         ${filter}
       ORDER BY bm25 ASC, c.file_path ASC, c.seq ASC
       LIMIT ?`,
    );
    const rows = filePath === undefined ? statement.all(expression, limit) : statement.all(expression, filePath, limit);
    return (rows as unknown[]).flatMap((row) => {
      const chunk = rowToChunk(row);
      const bm25 = numericField(row, "bm25");
      return chunk && bm25 !== undefined ? [{ ...chunk, bm25 }] : [];
    });
  }

  listFileMaps(limit: number, paths?: readonly string[]): FileMapRecord[] {
    this.assertOpen();
    if (paths && paths.length === 0) return [];
    if (!paths) {
      return this.database
        .prepare(
          `SELECT path, title, outline FROM files
           WHERE NOT EXISTS (SELECT 1 FROM temp.unavailable_files u WHERE u.path = files.path)
           ORDER BY path LIMIT ?`,
        )
        .all(limit) as unknown as FileMapRecord[];
    }
    const selected: FileMapRecord[] = [];
    const statement = this.database.prepare(
      `SELECT path, title, outline FROM files
       WHERE path = ? AND NOT EXISTS (SELECT 1 FROM temp.unavailable_files u WHERE u.path = files.path)`,
    );
    for (const path of paths.slice(0, limit)) {
      const row = statement.get(path) as FileMapRecord | undefined;
      if (row) selected.push(row);
    }
    return selected;
  }

  representativeChunks(path: string, limit: number): StoredChunk[] {
    this.assertOpen();
    const rows = this.database
      .prepare(
        `WITH ranked AS (
           SELECT c.*, COUNT(*) OVER () AS total,
                  ROW_NUMBER() OVER (ORDER BY seq) AS position
           FROM chunks c
           WHERE file_path = ?
             AND NOT EXISTS (SELECT 1 FROM temp.unavailable_files u WHERE u.path = c.file_path)
         )
         SELECT id, file_path, seq, start_line, end_line, heading, body, hash
         FROM ranked
         ORDER BY CASE
           WHEN position = 1 THEN 0
           WHEN position = total THEN 1
           ELSE 2
         END, ABS(position - ((total + 1) / 2.0)), seq
         LIMIT ?`,
      )
      .all(path, limit);
    return (rows as unknown[]).flatMap((row) => {
      const chunk = rowToChunk(row);
      return chunk ? [chunk] : [];
    });
  }

  secureArtifacts(): Promise<void> {
    return secureDatabaseArtifacts(this.path);
  }

  checkpoint(): void {
    this.assertOpen();
    this.database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.database.close();
  }

  private transaction(callback: () => void): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      callback();
      this.database.exec("COMMIT");
    } catch (error) {
      try {
        this.database.exec("ROLLBACK");
      } catch {
        // Preserve the original mutation failure.
      }
      throw error;
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Search database is closed");
  }
}

function createDatabase(path: string, root: string): SearchDatabase {
  const database = new SearchDatabase(path, root, true);
  try {
    database.validate();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function openValidatedDatabase(path: string, root: string): SearchDatabase {
  const database = new SearchDatabase(path, root);
  try {
    database.validate();
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

function configureDatabase(database: DatabaseSync): void {
  database.exec(`
    PRAGMA foreign_keys = ON;
    PRAGMA journal_mode = WAL;
    PRAGMA synchronous = NORMAL;
    PRAGMA busy_timeout = ${BUSY_TIMEOUT_MS};
    CREATE TEMP TABLE unavailable_files (
      path TEXT PRIMARY KEY
    ) STRICT;
  `);
}

function initializeSchema(database: DatabaseSync, root: string): void {
  database.exec(`
    CREATE TABLE meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) STRICT;
    CREATE TABLE files (
      path TEXT PRIMARY KEY,
      dev TEXT NOT NULL,
      ino TEXT NOT NULL,
      size INTEGER NOT NULL,
      mtime_ns TEXT NOT NULL,
      hash TEXT NOT NULL,
      title TEXT NOT NULL,
      outline TEXT NOT NULL
    ) STRICT;
    CREATE TABLE chunks (
      id INTEGER PRIMARY KEY,
      file_path TEXT NOT NULL REFERENCES files(path) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      heading TEXT NOT NULL,
      body TEXT NOT NULL,
      hash TEXT NOT NULL,
      search_path TEXT NOT NULL,
      search_title TEXT NOT NULL,
      search_heading TEXT NOT NULL,
      search_body TEXT NOT NULL,
      UNIQUE(file_path, seq)
    ) STRICT;
    CREATE VIRTUAL TABLE chunks_fts USING fts5(search_path, search_title, search_heading, search_body);
    CREATE TRIGGER chunks_after_insert AFTER INSERT ON chunks BEGIN
      INSERT INTO chunks_fts(rowid, search_path, search_title, search_heading, search_body)
      VALUES (new.id, new.search_path, new.search_title, new.search_heading, new.search_body);
    END;
    CREATE TRIGGER chunks_after_delete AFTER DELETE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
    END;
    CREATE TRIGGER chunks_after_update AFTER UPDATE ON chunks BEGIN
      DELETE FROM chunks_fts WHERE rowid = old.id;
      INSERT INTO chunks_fts(rowid, search_path, search_title, search_heading, search_body)
      VALUES (new.id, new.search_path, new.search_title, new.search_heading, new.search_body);
    END;
    CREATE INDEX chunks_file_path_seq ON chunks(file_path, seq);
  `);
  const insertMeta = database.prepare("INSERT INTO meta(key, value) VALUES (?, ?)");
  insertMeta.run("schema_version", SCHEMA_VERSION);
  insertMeta.run("index_policy_version", INDEX_POLICY_VERSION);
  insertMeta.run("workspace_root", root);
}

async function rebuildDatabase(path: string, root: string): Promise<void> {
  const temporaryPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const backupPath = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.backup`);
  let replacement: SearchDatabase | undefined;
  try {
    replacement = createDatabase(temporaryPath, root);
    replacement.checkpoint();
    replacement.close();
    replacement = undefined;
    await secureDatabaseArtifacts(temporaryPath);
    await moveDatabaseArtifacts(path, backupPath);
    try {
      await rename(temporaryPath, path);
      await removeDatabaseArtifacts(temporaryPath);
    } catch (error) {
      await moveDatabaseArtifacts(backupPath, path).catch(() => undefined);
      throw error;
    }
    await removeDatabaseArtifacts(backupPath);
    await secureDatabaseArtifacts(path);
  } finally {
    replacement?.close();
    await removeDatabaseArtifacts(temporaryPath);
  }
}

async function acquireDatabaseLock(path: string): Promise<() => Promise<void>> {
  const lockPath = `${path}.lock`;
  const owner = `${process.pid}:${randomUUID()}`;
  const deadline = Date.now() + DATABASE_LOCK_WAIT_MS;
  while (true) {
    try {
      await mkdir(lockPath, { mode: DATABASE_DIRECTORY_MODE });
      try {
        await writeFile(join(lockPath, "owner"), `${owner}\n${Date.now()}\n`, {
          encoding: "utf8",
          flag: "wx",
          mode: DATABASE_FILE_MODE,
        });
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true });
        throw error;
      }
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        const currentOwner = await readFile(join(lockPath, "owner"), "utf8").catch(() => "");
        if (currentOwner.startsWith(`${owner}\n`)) await rm(lockPath, { recursive: true, force: true });
      };
    } catch (error: unknown) {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
      if (await isStaleDatabaseLock(lockPath)) {
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (Date.now() >= deadline) throw new Error(`Timed out waiting for search index initialization: ${path}`);
      await delay(DATABASE_LOCK_RETRY_MS);
    }
  }
}

async function isStaleDatabaseLock(lockPath: string): Promise<boolean> {
  let stats: Awaited<ReturnType<typeof lstat>>;
  try {
    stats = await lstat(lockPath);
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return false;
    throw error;
  }
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error(`Search index lock is not a private regular directory: ${lockPath}`);
  }
  const owner = await readFile(join(lockPath, "owner"), "utf8").catch(() => "");
  const pid = Number.parseInt(owner.split(":", 1)[0] ?? "", 10);
  if (Number.isSafeInteger(pid) && pid > 0) return !isProcessAlive(pid);
  return Date.now() - stats.mtimeMs >= INCOMPLETE_LOCK_STALE_MS;
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return !isNodeError(error) || error.code !== "ESRCH";
  }
}

async function databasePathState(path: string): Promise<"missing" | "regular" | "unsafe"> {
  try {
    const stats = await lstat(path);
    return stats.isFile() && !stats.isSymbolicLink() ? "regular" : "unsafe";
  } catch (error: unknown) {
    if (isNodeError(error) && error.code === "ENOENT") return "missing";
    throw error;
  }
}

async function ensurePrivateIndexDirectory(agentDirectory: string): Promise<void> {
  let current = agentDirectory;
  for (const segment of ["pi-typesafe-search", "indexes"]) {
    current = join(current, segment);
    await mkdir(current, { mode: DATABASE_DIRECTORY_MODE }).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "EEXIST") throw error;
    });
    const stats = await lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Search index directory is not a private regular directory: ${current}`);
    }
    if (process.platform !== "win32") await chmod(current, DATABASE_DIRECTORY_MODE);
  }
}

async function moveDatabaseArtifacts(source: string, destination: string): Promise<void> {
  const moved: string[] = [];
  try {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        await rename(`${source}${suffix}`, `${destination}${suffix}`);
        moved.push(suffix);
      } catch (error: unknown) {
        if (suffix && isNodeError(error) && error.code === "ENOENT") continue;
        throw error;
      }
    }
  } catch (error: unknown) {
    for (const suffix of moved.reverse()) {
      await rename(`${destination}${suffix}`, `${source}${suffix}`).catch(() => undefined);
    }
    throw error;
  }
}

async function secureDatabaseArtifacts(path: string): Promise<void> {
  if (process.platform === "win32") return;
  for (const artifact of [path, `${path}-wal`, `${path}-shm`]) {
    await chmod(artifact, DATABASE_FILE_MODE).catch((error: unknown) => {
      if (!isNodeError(error) || error.code !== "ENOENT") throw error;
    });
  }
}

async function removeDatabaseArtifacts(path: string): Promise<void> {
  await Promise.all([path, `${path}-wal`, `${path}-shm`].map((artifact) => rm(artifact, { force: true })));
}

function rowToFile(value: unknown): StoredFileRecord | undefined {
  if (!isRecord(value)) return undefined;
  const path = stringField(value, "path");
  const dev = stringField(value, "dev");
  const ino = stringField(value, "ino");
  const size = numericField(value, "size");
  const mtimeNs = stringField(value, "mtime_ns");
  const hash = stringField(value, "hash");
  const title = stringField(value, "title");
  const outline = stringField(value, "outline");
  if (!path || dev === undefined || ino === undefined || size === undefined || !mtimeNs || !hash) return undefined;
  return { path, dev, ino, size, mtimeNs, hash, title: title ?? "", outline: outline ?? "" };
}

function rowToChunk(value: unknown): StoredChunk | undefined {
  if (!isRecord(value)) return undefined;
  const id = numericField(value, "id");
  const filePath = stringField(value, "file_path");
  const sequence = numericField(value, "seq");
  const startLine = numericField(value, "start_line");
  const endLine = numericField(value, "end_line");
  const heading = stringField(value, "heading");
  const body = stringField(value, "body");
  const hash = stringField(value, "hash");
  if (
    id === undefined ||
    !filePath ||
    sequence === undefined ||
    startLine === undefined ||
    endLine === undefined ||
    heading === undefined ||
    body === undefined ||
    !hash
  ) {
    return undefined;
  }
  return { id, filePath, sequence, startLine, endLine, heading, body, hash };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, key: string): string | undefined {
  return isRecord(value) && typeof value[key] === "string" ? value[key] : undefined;
}

function numericField(value: unknown, key: string): number | undefined {
  if (!isRecord(value)) return undefined;
  const field = value[key];
  return typeof field === "number" && Number.isFinite(field) ? field : undefined;
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
