import assert from "node:assert/strict";
import { resolveMenuScreen } from "@narumitw/pi-tui-kit";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import {
  type ContextManagementSettingsRuntime,
  type ContextManagementSettingsState,
  DEFAULT_CONTEXT_MANAGEMENT_SETTINGS,
} from "../src/settings.js";
import { createContextManagementMenu, showContextManagementMenu } from "../src/settings-menu.js";

function memoryRuntime(kind: ContextManagementSettingsState["kind"] = "missing") {
  let state: ContextManagementSettingsState = {
    kind,
    path: "/tmp/pi-context-management.json",
    settings: { ...DEFAULT_CONTEXT_MANAGEMENT_SETTINGS },
    ...(kind === "invalid" ? { issue: "bad file" } : { document: {} }),
  };
  const patches: unknown[] = [];
  const runtime: ContextManagementSettingsRuntime = {
    get: () => structuredClone(state),
    async reload() {
      return structuredClone(state);
    },
    async update(patch) {
      patches.push(patch);
      state = { ...state, kind: "loaded", settings: { ...state.settings, ...patch } };
      return structuredClone(state);
    },
    async flush() {},
  };
  return { runtime, patches };
}

test("menu reports configuration and runtime status with one bounded setting", () => {
  const memory = memoryRuntime();
  const menu = createContextManagementMenu(memory.runtime, { isActive: () => false });
  const main = resolveMenuScreen(menu, "main", memory.runtime.get());
  assert.equal(main.kind, "actions");
  if (main.kind !== "actions") assert.fail("Expected actions screen");
  assert.deepEqual(
    main.items.map((item) => item.label),
    ["Settings", "Status", "Help", "Close"],
  );
  assert.match(main.lines?.join("\n") ?? "", /Configured: Off/);

  const settings = resolveMenuScreen(menu, "settings", memory.runtime.get());
  assert.equal(settings.kind, "settings");
  if (settings.kind !== "settings") assert.fail("Expected settings screen");
  assert.deepEqual(
    settings.items.map((item) => [item.id, item.currentValue]),
    [["enabled", "Off"]],
  );
});

test("invalid settings remain read-only", () => {
  const memory = memoryRuntime("invalid");
  const menu = createContextManagementMenu(memory.runtime);
  const main = resolveMenuScreen(menu, "main", memory.runtime.get());
  assert.equal(main.kind, "actions");
  if (main.kind !== "actions") assert.fail("Expected actions screen");
  assert.equal("to" in main.items[0] ? main.items[0].to : undefined, "invalid");
  const invalid = resolveMenuScreen(menu, "invalid", memory.runtime.get());
  assert.equal(invalid.kind, "detail");
  if (invalid.kind !== "detail") assert.fail("Expected detail screen");
  assert.match(invalid.lines.join("\n"), /will not be overwritten/);
});

test("setting changes apply immediately and runtime failures restore the prior value", async () => {
  const memory = memoryRuntime();
  const applied: boolean[] = [];
  const menu = createContextManagementMenu(memory.runtime, {
    onSettingsChanged: () => {
      applied.push(memory.runtime.get().settings.enabled);
      if (applied.length === 1) throw new Error("activation failed");
    },
  });
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  const result = await menu.actions["set-enabled"]({
    ctx,
    state: memory.runtime.get(),
    signal: new AbortController().signal,
    itemId: "enabled",
    value: "On",
  });

  assert.deepEqual(result, { kind: "rejected" });
  assert.deepEqual(memory.patches, [{ enabled: true }, { enabled: false }]);
  assert.deepEqual(applied, [true, false]);
  assert.equal(memory.runtime.get().settings.enabled, false);
  assert.match(notifications[0]?.message ?? "", /activation failed/);
  assert.match(notifications[0]?.message ?? "", /previous setting was restored/i);
});

test("a committed save reconciles runtime state after menu cancellation", async () => {
  const memory = memoryRuntime();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  const runtime: ContextManagementSettingsRuntime = {
    ...memory.runtime,
    async update(patch) {
      await blocked;
      return memory.runtime.update(patch);
    },
  };
  let reconciliations = 0;
  const menu = createContextManagementMenu(runtime, {
    onSettingsChanged: () => {
      reconciliations += 1;
    },
  });
  const controller = new AbortController();
  const { ctx, notifications } = createMockContext({ mode: "tui" });
  const pending = menu.actions["set-enabled"]({
    ctx,
    state: runtime.get(),
    signal: controller.signal,
    itemId: "enabled",
    value: "On",
  });
  controller.abort();
  release();

  assert.deepEqual(await pending, { kind: "rejected" });
  assert.equal(reconciliations, 1);
  assert.equal(runtime.get().settings.enabled, true);
  assert.deepEqual(notifications, []);
});

test("non-TUI command reports through RPC and rejects print and JSON modes", async () => {
  const memory = memoryRuntime();
  const rpc = createMockContext({ mode: "rpc", hasUI: true });
  await showContextManagementMenu(memory.runtime, rpc.ctx, {
    signal: new AbortController().signal,
    isCurrent: () => true,
    isActive: () => false,
    onSettingsChanged: () => undefined,
  });
  assert.match(rpc.notifications[0]?.message ?? "", /pi-context-management\.json/);

  for (const mode of ["print", "json"] as const) {
    const nonInteractive = createMockContext({ mode, hasUI: false });
    await assert.rejects(
      showContextManagementMenu(memory.runtime, nonInteractive.ctx, {
        signal: new AbortController().signal,
        isCurrent: () => true,
        isActive: () => false,
        onSettingsChanged: () => undefined,
      }),
      /requires TUI or RPC UI support/,
    );
  }
});
