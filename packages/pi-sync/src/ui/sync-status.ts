import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

const STATUS_KEY = "sync";

type SyncStatusContext = Pick<ExtensionContext, "hasUI" | "sessionManager" | "ui">;

const enabledBySession = new WeakMap<ExtensionContext["sessionManager"], boolean>();

export function configureSyncStatus(ctx: SyncStatusContext, enabled: boolean) {
  enabledBySession.set(ctx.sessionManager, enabled);
  if (!enabled && ctx.hasUI) ctx.ui.setStatus(STATUS_KEY, undefined);
}

export function setSyncStatus(ctx: SyncStatusContext, value: string | undefined) {
  if (!ctx.hasUI || (value !== undefined && enabledBySession.get(ctx.sessionManager) === false)) return;
  ctx.ui.setStatus(STATUS_KEY, value);
}
