import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "vitest";
import {
  createContextManagementSettingsRuntime,
  DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
  loadContextManagementSettings,
  normalizeContextManagementSettings,
} from "../src/settings.js";

const temporaryDirectories: string[] = [];

async function tempSettingsPath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "pi-context-management-test-"));
  temporaryDirectories.push(directory);
  return join(directory, "pi-context-management.json");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("normalizes the disabled default and validates the enabled field", () => {
  assert.deepEqual(normalizeContextManagementSettings({}), DEFAULT_CONTEXT_MANAGEMENT_SETTINGS);
  assert.deepEqual(normalizeContextManagementSettings({ enabled: true }), { enabled: true });
  assert.equal(normalizeContextManagementSettings({ enabled: "yes" }), undefined);
  assert.equal(normalizeContextManagementSettings([]), undefined);
});

test("loads missing and valid files without creating defaults", async () => {
  const path = await tempSettingsPath();
  const missing = await loadContextManagementSettings(path);
  assert.equal(missing.kind, "missing");
  assert.equal(missing.settings.enabled, false);
  await assert.rejects(stat(path));

  await writeFile(path, '{"enabled":true,"futureField":"kept"}\n');
  const loaded = await loadContextManagementSettings(path);
  assert.equal(loaded.kind, "loaded");
  assert.equal(loaded.settings.enabled, true);
  assert.equal(loaded.document?.futureField, "kept");
});

test("rejects invalid, oversized, and symbolic-link settings without overwriting", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, "{invalid");
  const runtime = createContextManagementSettingsRuntime(path);
  await runtime.reload();
  await assert.rejects(runtime.update({ enabled: true }), /Cannot overwrite an invalid/);
  assert.equal(await readFile(path, "utf8"), "{invalid");

  const oversized = await tempSettingsPath();
  await writeFile(oversized, JSON.stringify({ padding: "x".repeat(70 * 1024) }));
  assert.match((await loadContextManagementSettings(oversized)).issue ?? "", /64 KiB/);

  const target = await tempSettingsPath();
  const link = await tempSettingsPath();
  await writeFile(target, "{}");
  await symlink(target, link);
  assert.match((await loadContextManagementSettings(link)).issue ?? "", /symbolic links/);
});

test("serialized updates preserve unknown fields and publish atomically with private permissions", async () => {
  const path = await tempSettingsPath();
  await writeFile(path, '{"enabled":false,"external":"newer"}\n');
  const runtime = createContextManagementSettingsRuntime(path);
  await runtime.reload();
  await runtime.update({ enabled: true });
  await runtime.flush();

  const document = JSON.parse(await readFile(path, "utf8"));
  assert.deepEqual(document, { enabled: true, external: "newer" });
  if (process.platform !== "win32") assert.equal((await stat(path)).mode & 0o777, 0o600);
  assert.deepEqual(
    (await readdir(join(path, ".."))).filter((name) => name.endsWith(".tmp")),
    [],
  );
});

test("aborted settings operations do not publish", async () => {
  const path = await tempSettingsPath();
  const runtime = createContextManagementSettingsRuntime(path);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(runtime.update({ enabled: true }, controller.signal), /aborted/i);
  assert.equal((await loadContextManagementSettings(path)).kind, "missing");
});
