import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import {
  OPENROUTER_CREDENTIALS_FILE_ENV,
  OPENROUTER_MANAGEMENT_API_KEY_ENV,
  resolveOpenRouterManagementCredentials,
} from "../src/providers/openrouter-auth.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

test("OpenRouter management credentials prefer the explicit environment key", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ managementApiKey: "file-secret" }));
  await chmod(credentialsPath, 0o600);
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "environment-secret");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, credentialsPath);

  const credentials = await resolveOpenRouterManagementCredentials();
  assertCredentials(credentials, "environment-secret", "environment");
});

test("OpenRouter management credentials reject a non-empty invalid environment key before reading the file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ managementApiKey: "file-secret" }));
  await chmod(credentialsPath, 0o600);
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "invalid");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, credentialsPath);

  await assert.rejects(() => resolveOpenRouterManagementCredentials(), /not a valid Management API key/);
});

test("OpenRouter management credentials load an owner-private JSON file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ managementApiKey: "file-secret" }));
  await chmod(credentialsPath, 0o600);
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, credentialsPath);

  const credentials = await resolveOpenRouterManagementCredentials();
  assertCredentials(credentials, "file-secret", "file");
});

test("OpenRouter management credentials reject world-readable files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ managementApiKey: "file-secret" }));
  await chmod(credentialsPath, 0o644);
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, credentialsPath);

  await assert.rejects(() => resolveOpenRouterManagementCredentials(), /mode 644/);
});

test("OpenRouter management credentials reject oversized files", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-"));
  temporaryDirectories.push(directory);
  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, `${" ".repeat(17 * 1024)}{}`);
  await chmod(credentialsPath, 0o600);
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, credentialsPath);

  await assert.rejects(() => resolveOpenRouterManagementCredentials(), /exceeds/);
});

test("OpenRouter management credentials reject symbolic links", async () => {
  if (process.platform === "win32") return;
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-"));
  temporaryDirectories.push(directory);
  const targetPath = join(directory, "target.json");
  const linkPath = join(directory, "credentials.json");
  await writeFile(targetPath, JSON.stringify({ managementApiKey: "file-secret" }));
  await chmod(targetPath, 0o600);
  await symlink(targetPath, linkPath);
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, linkPath);

  await assert.rejects(() => resolveOpenRouterManagementCredentials(), /non-symlink/);
});

test("OpenRouter management credentials ignore a missing file and an explicitly disabled file", async () => {
  const directory = await mkdtemp(join(tmpdir(), "pi-usage-openrouter-"));
  temporaryDirectories.push(directory);
  vi.stubEnv(OPENROUTER_MANAGEMENT_API_KEY_ENV, "");
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, join(directory, "missing.json"));
  assert.deepEqual(await resolveOpenRouterManagementCredentials(), {});

  const credentialsPath = join(directory, "credentials.json");
  await writeFile(credentialsPath, JSON.stringify({ managementApiKey: "file-secret" }));
  await chmod(credentialsPath, 0o600);
  vi.stubEnv(OPENROUTER_CREDENTIALS_FILE_ENV, "");
  assert.deepEqual(await resolveOpenRouterManagementCredentials(), {});
});

function assertCredentials(
  credentials: Awaited<ReturnType<typeof resolveOpenRouterManagementCredentials>>,
  key: string,
  source: string,
): void {
  if (!credentials.managementApiKey) throw new Error("Expected a management key.");
  assert.equal(credentials.managementApiKey, key);
  assert.equal(credentials.source, source);
}
