import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { link, lstat, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { setTimeout as delay } from "node:timers/promises";
import { test } from "vitest";
import type { SearchChunk } from "../src/chunks.js";
import { databasePathForRoot, openSearchDatabase } from "../src/database.js";
import { ftsExpression } from "../src/text-normalization.js";

async function withTempAgent(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-jev-db-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function waitForPath(target: string): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await lstat(target);
      return;
    } catch (error: unknown) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") throw error;
    }
    await delay(5);
  }
  throw new Error(`Timed out waiting for path: ${target}`);
}

function chunk(body: string, sequence = 0): SearchChunk {
  return {
    sequence,
    startLine: sequence + 1,
    endLine: sequence + 1,
    heading: "Search",
    body,
    hash: `hash-${sequence}-${body}`,
  };
}

const file = {
  path: "docs/search.md",
  dev: "1",
  ino: "2",
  size: 10,
  mtimeNs: "3",
  hash: "file-hash",
  title: "Search Guide",
  outline: "Path: docs/search.md\nSearch Guide",
};

test("database creates a private per-workspace FTS5 index and persists chunks", async () => {
  await withTempAgent(async (agentDirectory) => {
    const root = path.join(agentDirectory, "workspace");
    const database = await openSearchDatabase(root, agentDirectory);
    database.replaceFile(file, [chunk("semantic retrieval with sqlite")]);
    await database.secureArtifacts();

    const expression = ftsExpression("sqlite retrieval");
    assert.ok(expression);
    const matches = database.searchFts(expression, 10);
    assert.equal(matches[0]?.filePath, file.path);
    assert.match(matches[0]?.body ?? "", /semantic retrieval/);
    database.close();

    const reopened = await openSearchDatabase(root, agentDirectory);
    assert.equal(reopened.listFiles().length, 1);
    assert.equal(reopened.representativeChunks(file.path, 3).length, 1);
    reopened.close();

    if (process.platform !== "win32") {
      const dbPath = databasePathForRoot(root, agentDirectory);
      assert.equal((await stat(path.dirname(dbPath))).mode & 0o777, 0o700);
      assert.equal((await stat(dbPath)).mode & 0o777, 0o600);
    }
  });
});

test("concurrent first opens serialize initialization and leave no lock artifact", async () => {
  await withTempAgent(async (agentDirectory) => {
    const root = path.join(agentDirectory, "concurrent-workspace");
    const databases = await Promise.all(Array.from({ length: 12 }, () => openSearchDatabase(root, agentDirectory)));
    try {
      assert.ok(databases.every((database) => database.listFiles().length === 0));
      databases[0]?.replaceFile(file, [chunk("shared initialized index")]);
      assert.ok(databases.every((database) => database.listFiles().length === 1));
    } finally {
      for (const database of databases) database.close();
    }

    await assert.rejects(lstat(`${databasePathForRoot(root, agentDirectory)}.lock`), (error: unknown) =>
      Boolean(error instanceof Error && "code" in error && error.code === "ENOENT"),
    );
  });
});

test("concurrent stale-lock recovery uses one atomic quarantine claim", async () => {
  if (process.platform === "win32") return;
  await withTempAgent(async (agentDirectory) => {
    const root = path.join(agentDirectory, "stale-lock-workspace");
    const initial = await openSearchDatabase(root, agentDirectory);
    initial.close();
    const databasePath = databasePathForRoot(root, agentDirectory);
    const lockPath = `${databasePath}.lock`;
    await writeFile(lockPath, `99999999:dead-owner\n${Date.now()}\n`, { mode: 0o600 });

    const databases = await Promise.all(Array.from({ length: 12 }, () => openSearchDatabase(root, agentDirectory)));
    for (const database of databases) database.close();
    const quarantines = (await readdir(path.dirname(databasePath))).filter((name) =>
      name.startsWith(`${path.basename(databasePath)}.lock.stale-`),
    );
    assert.equal(quarantines.length, 1);
    await assert.rejects(lstat(lockPath), (error: unknown) =>
      Boolean(error instanceof Error && "code" in error && error.code === "ENOENT"),
    );
  });
});

test("stale-lock recovery completes a claim left behind by a crashed claimant", async () => {
  if (process.platform === "win32") return;
  await withTempAgent(async (agentDirectory) => {
    const root = path.join(agentDirectory, "crashed-claim-workspace");
    const initial = await openSearchDatabase(root, agentDirectory);
    initial.close();
    const databasePath = databasePathForRoot(root, agentDirectory);
    const lockPath = `${databasePath}.lock`;
    const owner = `99999999:dead-owner\n${Date.now()}\n`;
    await writeFile(lockPath, owner, { mode: 0o600 });
    const stats = await lstat(lockPath);
    const identity = createHash("sha256")
      .update(`${stats.dev}:${stats.ino}:${stats.mtimeMs}:${owner}`, "utf8")
      .digest("hex")
      .slice(0, 24);
    await link(lockPath, `${lockPath}.stale-${identity}`);

    const recovered = await openSearchDatabase(root, agentDirectory);
    recovered.close();
    await assert.rejects(lstat(lockPath), (error: unknown) =>
      Boolean(error instanceof Error && "code" in error && error.code === "ENOENT"),
    );
  });
});

test("database lock waits honor cancellation", async () => {
  await withTempAgent(async (agentDirectory) => {
    const root = path.join(agentDirectory, "cancel-lock-workspace");
    const initial = await openSearchDatabase(root, agentDirectory);
    initial.close();
    const lockPath = `${databasePathForRoot(root, agentDirectory)}.lock`;
    await writeFile(lockPath, `${process.pid}:live-owner\n${Date.now()}\n`, { mode: 0o600 });
    const controller = new AbortController();
    const pending = openSearchDatabase(root, agentDirectory, controller.signal);
    setTimeout(() => controller.abort(), 10);
    await assert.rejects(pending, (error: unknown) => Boolean(error instanceof Error && error.name === "AbortError"));
  });
});

test("file replacement is transactional and removal clears FTS rows", async () => {
  await withTempAgent(async (agentDirectory) => {
    const database = await openSearchDatabase("/workspace", agentDirectory);
    database.replaceFile(file, [chunk("stable previous content")]);
    await assert.rejects(
      async () => database.replaceFile({ ...file, hash: "next" }, [chunk("duplicate", 0), chunk("duplicate", 0)]),
      /UNIQUE/,
    );
    assert.match(database.representativeChunks(file.path, 1)[0]?.body ?? "", /stable previous/);

    database.removeFiles([file.path]);
    assert.equal(database.listFiles().length, 0);
    assert.equal(database.searchFts(ftsExpression("stable") ?? "", 10).length, 0);
    database.close();
  });
});

test("database paths reject symbolic links", async () => {
  if (process.platform === "win32") return;
  await withTempAgent(async (agentDirectory) => {
    const root = "/workspace/symlink";
    const database = await openSearchDatabase(root, agentDirectory);
    database.close();
    const databasePath = databasePathForRoot(root, agentDirectory);
    const target = `${databasePath}.target`;
    await rm(databasePath);
    await writeFile(target, "not an index", { mode: 0o600 });
    await symlink(target, databasePath);
    await assert.rejects(openSearchDatabase(root, agentDirectory), /not a private regular file/);
  });
});

test("schema recovery waits for live database handles before replacing the index", async () => {
  await withTempAgent(async (agentDirectory) => {
    const root = "/workspace/live-handle";
    const active = await openSearchDatabase(root, agentDirectory);
    active.replaceFile(file, [chunk("active handle content")]);
    const databasePath = databasePathForRoot(root, agentDirectory);
    const sqlite = new DatabaseSync(databasePath);
    sqlite.prepare("UPDATE meta SET value = 'obsolete' WHERE key = 'schema_version'").run();
    sqlite.close();

    let settled = false;
    const recovery = openSearchDatabase(root, agentDirectory);
    void recovery.then(
      () => {
        settled = true;
      },
      () => {
        settled = true;
      },
    );
    await waitForPath(`${databasePath}.lock`);
    await delay(50);
    assert.equal(settled, false);
    assert.match(active.representativeChunks(file.path, 1)[0]?.body ?? "", /active handle/);

    active.close();
    const rebuilt = await recovery;
    assert.deepEqual(rebuilt.listFiles(), []);
    rebuilt.close();
    const leases = (await readdir(path.dirname(databasePath))).filter((name) =>
      name.startsWith(`${path.basename(databasePath)}.lease-`),
    );
    assert.deepEqual(leases, []);
  });
});

test("separate handles can read committed updates and schema mismatches rebuild", async () => {
  await withTempAgent(async (agentDirectory) => {
    const root = "/workspace/shared";
    const writer = await openSearchDatabase(root, agentDirectory);
    const reader = await openSearchDatabase(root, agentDirectory);
    writer.replaceFile(file, [chunk("visible committed update")]);
    assert.equal(reader.listFiles().length, 1);
    assert.match(reader.representativeChunks(file.path, 1)[0]?.body ?? "", /committed update/);
    reader.close();
    writer.close();

    const sqlite = new DatabaseSync(databasePathForRoot(root, agentDirectory));
    sqlite.prepare("UPDATE meta SET value = 'obsolete' WHERE key = 'schema_version'").run();
    sqlite.close();

    const rebuilt = await openSearchDatabase(root, agentDirectory);
    assert.deepEqual(rebuilt.listFiles(), []);
    rebuilt.close();
  });
});

test("corrupt derived indexes rebuild safely and workspace hashes stay isolated", async () => {
  await withTempAgent(async (agentDirectory) => {
    const firstRoot = "/workspace/one";
    const secondRoot = "/workspace/two";
    assert.notEqual(databasePathForRoot(firstRoot, agentDirectory), databasePathForRoot(secondRoot, agentDirectory));

    const initial = await openSearchDatabase(firstRoot, agentDirectory);
    initial.replaceFile(file, [chunk("old data")]);
    initial.close();
    const dbPath = databasePathForRoot(firstRoot, agentDirectory);
    await writeFile(dbPath, "not sqlite", { mode: 0o600 });

    const rebuilt = await openSearchDatabase(firstRoot, agentDirectory);
    assert.equal(rebuilt.listFiles().length, 0);
    rebuilt.close();
    assert.notEqual((await readFile(dbPath, "utf8")).slice(0, 10), "not sqlite");
  });
});
