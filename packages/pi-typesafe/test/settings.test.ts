import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test, vi } from "vitest";
import { createMockContext, createMockPi } from "../../../test/support.js";
import jevExtension from "../src/jev.js";
import { loadSettings } from "../src/settings.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function settingsFixture() {
  const directory = await mkdtemp(join(tmpdir(), "pi-typesafe-settings-"));
  temporaryDirectories.push(directory);
  const agentDirectory = join(directory, "agent");
  return {
    agentDirectory,
    path: join(agentDirectory, "pi-typesafe.json"),
  };
}

test("uses disabled defaults without creating a missing settings path", async () => {
  const fixture = await settingsFixture();
  assert.deepEqual(await loadSettings(fixture.path), {
    settings: { openRouterFallback: false },
  });
  await assert.rejects(stat(fixture.agentDirectory), { code: "ENOENT" });
});

test("loads the explicit OpenRouter fallback setting and ignores unknown fields", async () => {
  const fixture = await settingsFixture();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(fixture.path, '{"openRouterFallback":true,"futureOption":"preserved"}\n');

  assert.deepEqual(await loadSettings(fixture.path), {
    settings: { openRouterFallback: true },
  });

  await writeFile(fixture.path, '{"futureOption":"preserved"}\n');
  assert.deepEqual(await loadSettings(fixture.path), {
    settings: { openRouterFallback: false },
  });
});

test("rejects malformed and invalid settings without changing the file", async () => {
  const fixture = await settingsFixture();
  await mkdir(fixture.agentDirectory, { recursive: true });

  for (const document of ["{ invalid\n", "[]\n", '{"openRouterFallback":"yes"}\n']) {
    await writeFile(fixture.path, document);
    const loaded = await loadSettings(fixture.path);
    assert.deepEqual(loaded.settings, { openRouterFallback: false });
    assert.match(loaded.warning ?? "", /using defaults without changing pi-typesafe\.json/);
    assert.equal(await readFile(fixture.path, "utf8"), document);
  }
});

test("reloads the settings on session start and warns about invalid settings", async () => {
  const fixture = await settingsFixture();
  await mkdir(fixture.agentDirectory, { recursive: true });
  await writeFile(fixture.path, '{"openRouterFallback":true}\n');

  const fetchImpl = vi.fn<typeof fetch>(async () =>
    Response.json({
      model: "typesafe/jev-1.13",
      answers: { answer: { type: "noul", noul: 0.75 } },
    }),
  );
  const getProviderAuth = vi.fn(async () => ({ auth: { apiKey: "sk-or-secret" } }));
  const context = createMockContext({
    modelRegistry: {
      getProviderAuth,
      getProvider: () => ({ baseUrl: "https://openrouter.ai/api/v1" }),
    },
  });
  const mock = createMockPi();
  jevExtension(mock.pi, { env: {}, fetch: fetchImpl, settingsPath: fixture.path });
  const tool = mock.tools.find((candidate) => candidate.name === "typesafe_question") as {
    execute(
      toolCallId: string,
      params: unknown,
      signal: AbortSignal,
      onUpdate: undefined,
      ctx: typeof context.ctx,
    ): Promise<unknown>;
  };
  const input = {
    state: "x",
    questions: { answer: { type: "noul", instructions: "Is this true?" } },
  };

  await assert.rejects(
    () => tool.execute("before-start", input, new AbortController().signal, undefined, context.ctx),
    /openRouterFallback/,
  );
  assert.equal(getProviderAuth.mock.calls.length, 0);

  await mock.events.get("session_start")?.[0]?.({ reason: "startup" }, context.ctx);
  await tool.execute("enabled", input, new AbortController().signal, undefined, context.ctx);
  assert.equal(fetchImpl.mock.calls.length, 1);

  await writeFile(fixture.path, '{"openRouterFallback":false}\n');
  await mock.events.get("session_start")?.[0]?.({ reason: "reload" }, context.ctx);
  await assert.rejects(
    () => tool.execute("disabled", input, new AbortController().signal, undefined, context.ctx),
    /openRouterFallback/,
  );
  assert.equal(getProviderAuth.mock.calls.length, 1);
  assert.equal(fetchImpl.mock.calls.length, 1);

  await writeFile(fixture.path, "{ invalid\n");
  await mock.events.get("session_start")?.[0]?.({ reason: "reload" }, context.ctx);
  assert.match(context.notifications.at(-1)?.message ?? "", /using defaults/);
  assert.equal(context.notifications.at(-1)?.level, "warning");
});
