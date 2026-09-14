import assert from "node:assert/strict";
import { test } from "vitest";
import { createMockContext } from "../../../test/support.js";
import { configureSyncStatus, setSyncStatus } from "../src/ui/sync-status.js";

test("sync status defaults on and disabling it clears and suppresses text", () => {
  const { ctx, notifications, statuses, widgets } = createMockContext({ mode: "tui" });
  notifications.push({ message: "keep", level: "info" });
  widgets.set("sync:attention", ["keep"]);

  setSyncStatus(ctx, "sync ...");
  assert.equal(statuses.get("sync"), "sync ...");

  configureSyncStatus(ctx, false);
  assert.equal(statuses.get("sync"), undefined);
  setSyncStatus(ctx, "sync ⇡");
  assert.equal(statuses.get("sync"), undefined);
  assert.deepEqual(notifications, [{ message: "keep", level: "info" }]);
  assert.deepEqual(widgets.get("sync:attention"), ["keep"]);

  configureSyncStatus(ctx, true);
  setSyncStatus(ctx, "sync ⇡");
  assert.equal(statuses.get("sync"), "sync ⇡");
  setSyncStatus(ctx, undefined);
  assert.equal(statuses.get("sync"), undefined);
});

test("sync status preferences are isolated by session manager", () => {
  const disabled = createMockContext({ mode: "rpc" });
  const enabled = createMockContext({ mode: "rpc" });
  configureSyncStatus(disabled.ctx, false);

  setSyncStatus(disabled.ctx, "hidden");
  setSyncStatus(enabled.ctx, "visible");

  assert.equal(disabled.statuses.get("sync"), undefined);
  assert.equal(enabled.statuses.get("sync"), "visible");
});
