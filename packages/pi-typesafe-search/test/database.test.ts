import assert from "node:assert/strict";
import { lstat, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
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
