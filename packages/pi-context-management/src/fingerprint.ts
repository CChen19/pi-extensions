import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, child]) => [key, stableValue(child)]),
  );
}

export function fingerprintMessage(message: AgentMessage): string {
  return createHash("sha256")
    .update(JSON.stringify(stableValue(message)))
    .digest("hex");
}
