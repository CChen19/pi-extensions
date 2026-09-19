import assert from "node:assert/strict";
import { mkdtemp, rename, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import { openSearchDatabase } from "../src/database.js";
import { discoverSearchFiles } from "../src/files.js";
import { refreshIndex } from "../src/indexer.js";
import { ftsExpression } from "../src/text-normalization.js";

async function withFixture(fn: (workspace: string, agentDirectory: string) => Promise<void>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pi-jev-indexer-"));
  const workspace = path.join(root, "workspace");
  const agentDirectory = path.join(root, "agent");
  await import("node:fs/promises").then(({ mkdir }) => Promise.all([mkdir(workspace), mkdir(agentDirectory)]));
  try {
    await fn(workspace, agentDirectory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("indexer handles cold, warm, changed, binary, and deleted files incrementally", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const sourcePath = path.join(workspace, "search.md");
    await writeFile(sourcePath, "# Search\nfirst content\n");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
    const database = await openSearchDatabase(workspace, agentDirectory);

    const cold = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.deepEqual(cold, { indexed: 1, unchanged: 0, removed: 0, skipped: 1 });
    assert.equal(database.listFiles().length, 1);

    const warm = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.deepEqual(warm, { indexed: 0, unchanged: 1, removed: 0, skipped: 1 });

    await writeFile(sourcePath, "# Search\nchanged content with more bytes\n");
    const changed = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(changed.indexed, 1);
    assert.match(database.representativeChunks("search.md", 1)[0]?.body ?? "", /changed content/);

    await unlink(sourcePath);
    const removed = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(removed.removed, 1);
    assert.equal(database.listFiles().length, 0);
    database.close();
  });
});

test("renamed and newly excluded files replace stale index rows", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const originalPath = path.join(workspace, "original.txt");
    const renamedPath = path.join(workspace, "renamed.txt");
    await writeFile(originalPath, "searchable content\n");
    const database = await openSearchDatabase(workspace, agentDirectory);
    await refreshIndex(database, await discoverSearchFiles(workspace, "."));

    await rename(originalPath, renamedPath);
    const renamed = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.deepEqual(renamed, { indexed: 1, unchanged: 0, removed: 1, skipped: 0 });
    assert.deepEqual(
      database.listFiles().map((file) => file.path),
      ["renamed.txt"],
    );

    await rename(renamedPath, path.join(workspace, ".env.local"));
    const excluded = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(excluded.removed, 1);
    assert.deepEqual(database.listFiles(), []);
    database.close();
  });
});

test("failed or cancelled refreshes keep complete prior file versions and queues recover", async () => {
  await withFixture(async (workspace, agentDirectory) => {
    const sourcePath = path.join(workspace, "source.txt");
    await writeFile(sourcePath, "previous version\n");
    const database = await openSearchDatabase(workspace, agentDirectory);
    await refreshIndex(database, await discoverSearchFiles(workspace, "."));

    await writeFile(sourcePath, "next version with changed size\n");
    const discovery = await discoverSearchFiles(workspace, ".");
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(refreshIndex(database, discovery, controller.signal), (error: unknown) =>
      Boolean(error instanceof Error && error.name === "AbortError"),
    );
    assert.match(database.representativeChunks("source.txt", 1)[0]?.body ?? "", /previous version/);

    const [first, second] = await Promise.all([refreshIndex(database, discovery), refreshIndex(database, discovery)]);
    assert.equal(first.indexed + second.indexed, 1);
    assert.match(database.representativeChunks("source.txt", 1)[0]?.body ?? "", /next version/);

    const retainedHash = database.getFile("source.txt")?.hash;
    await writeFile(sourcePath, "third version discovered before another change\n");
    const failedDiscovery = await discoverSearchFiles(workspace, ".");
    await writeFile(sourcePath, "fourth version changes size before loading and must hide stale content\n");
    const failed = await refreshIndex(database, failedDiscovery);
    assert.equal(failed.skipped, 1);
    assert.equal(database.getFile("source.txt")?.hash, retainedHash);
    assert.deepEqual(database.representativeChunks("source.txt", 1), []);
    assert.deepEqual(database.listFileMaps(10), []);
    assert.deepEqual(database.searchFts(ftsExpression("next version") ?? "", 10), []);

    const recovered = await refreshIndex(database, await discoverSearchFiles(workspace, "."));
    assert.equal(recovered.indexed, 1);
    assert.match(database.representativeChunks("source.txt", 1)[0]?.body ?? "", /fourth version/);
    database.close();
  });
});
