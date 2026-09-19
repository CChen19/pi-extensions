import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, truncate, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "vitest";
import {
  discoverSearchFiles,
  isSensitiveFileName,
  loadTextFile,
  resolveSearchRoot,
  UnsupportedSearchFileError,
} from "../src/files.js";

async function withWorkspace(fn: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pi-jev-files-"));
  try {
    await fn(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("discovery is deterministic and excludes symlinks, generated directories, and sensitive files", async () => {
  await withWorkspace(async (workspace) => {
    await mkdir(path.join(workspace, "src"));
    await mkdir(path.join(workspace, "node_modules"));
    await writeFile(path.join(workspace, "src", "b.ts"), "export const b = 2;\n");
    await writeFile(path.join(workspace, "src", "a.ts"), "export const a = 1;\n");
    await writeFile(path.join(workspace, ".env"), "TOKEN=secret\n");
    await writeFile(path.join(workspace, "node_modules", "ignored.js"), "ignored\n");
    await symlink(path.join(workspace, "src", "a.ts"), path.join(workspace, "linked.ts"));

    const result = await discoverSearchFiles(workspace, ".");
    assert.deepEqual(
      result.files.map((file) => file.path),
      ["src/a.ts", "src/b.ts"],
    );
    assert.equal(result.skippedDirectories, 1);
    assert.ok(result.skippedFiles >= 2);
  });
});

test("search roots remain inside the canonical workspace", async () => {
  await withWorkspace(async (workspace) => {
    const outside = await mkdtemp(path.join(os.tmpdir(), "pi-jev-outside-"));
    try {
      await symlink(outside, path.join(workspace, "outside"));
      await assert.rejects(resolveSearchRoot(workspace, "../"), /inside the current workspace/);
      await assert.rejects(resolveSearchRoot(workspace, "outside"), /outside the current workspace/);
      assert.equal(await resolveSearchRoot(workspace, "@."), await resolveSearchRoot(workspace, "."));
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

test("safe loading decodes UTF-8, rejects unsupported or changed data, and honors cancellation", async () => {
  await withWorkspace(async (workspace) => {
    await writeFile(path.join(workspace, "text.txt"), "alpha\r\nbeta\r\n");
    await writeFile(path.join(workspace, "binary.bin"), Buffer.from([1, 0, 2]));
    await writeFile(path.join(workspace, "invalid.txt"), Buffer.from([0xc3, 0x28]));
    await writeFile(path.join(workspace, "oversized.txt"), Buffer.alloc(512 * 1024 + 1, 97));
    const discovery = await discoverSearchFiles(workspace, ".");
    const text = discovery.files.find((file) => file.path === "text.txt");
    const binary = discovery.files.find((file) => file.path === "binary.bin");
    const invalid = discovery.files.find((file) => file.path === "invalid.txt");
    assert.ok(text);
    assert.ok(binary);
    assert.ok(invalid);
    assert.equal(
      discovery.files.some((file) => file.path === "oversized.txt"),
      false,
    );
    assert.deepEqual((await loadTextFile(text, discovery.root)).lines, ["alpha", "beta", ""]);
    await assert.rejects(loadTextFile(binary, discovery.root), UnsupportedSearchFileError);
    await assert.rejects(loadTextFile(invalid, discovery.root), UnsupportedSearchFileError);

    await writeFile(path.join(workspace, "text.txt"), "changed size after discovery\n");
    await assert.rejects(loadTextFile(text, discovery.root), /changed size/);

    const controller = new AbortController();
    controller.abort();
    await assert.rejects(discoverSearchFiles(workspace, ".", controller.signal), (error: unknown) =>
      Boolean(error instanceof Error && error.name === "AbortError"),
    );
  });
});

test("discovery rejects corpora beyond the configured byte budget", async () => {
  await withWorkspace(async (workspace) => {
    for (let index = 0; index < 101; index += 1) {
      const file = path.join(workspace, `${String(index).padStart(3, "0")}.txt`);
      await writeFile(file, "");
      await truncate(file, 512 * 1024);
    }
    await assert.rejects(discoverSearchFiles(workspace, "."), /byte index limit/);
  });
});

test("sensitive filename policy covers common credential material", () => {
  for (const name of [
    ".env",
    ".env.local",
    ".git-credentials",
    ".netrc",
    "credentials",
    "server.pem",
    "private.key",
    "id_rsa",
    "secrets.json",
    "token.secret",
  ]) {
    assert.equal(isSensitiveFileName(name), true, name);
  }
  for (const name of ["environment.md", "keyboard.ts", ".github", "public.crt"]) {
    assert.equal(isSensitiveFileName(name), false, name);
  }
});
