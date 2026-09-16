import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";

const MAX_FINGERPRINT_DEPTH = 512;
const MAX_FINGERPRINT_UNITS = 4 * 1024 * 1024;
const MAX_FINGERPRINT_BYTES = 8 * 1024 * 1024;

type JsonContainer = unknown[] | Record<string, unknown>;

interface CloneTask {
  source: unknown;
  parent: JsonContainer;
  key: string | number;
  depth: number;
}

function failLimit(): never {
  throw new Error("Context message fingerprint exceeded its traversal limit");
}

function assign(parent: JsonContainer, key: string | number, value: unknown): void {
  if (Array.isArray(parent)) parent[key as number] = value;
  else parent[String(key)] = value;
}

function stableValue(value: unknown): unknown {
  const root: Record<string, unknown> = {};
  const tasks: CloneTask[] = [{ source: value, parent: root, key: "value", depth: 0 }];
  let remainingUnits = MAX_FINGERPRINT_UNITS;
  const consume = (units: number) => {
    if (!Number.isSafeInteger(units) || units < 0 || units > remainingUnits) failLimit();
    remainingUnits -= units;
  };

  while (tasks.length > 0) {
    const task = tasks.pop();
    if (!task) break;
    consume(1);
    const source = task.source;
    if (typeof source === "string") consume(source.length);
    if (typeof source !== "object" || source === null) {
      if (typeof source === "bigint") throw new Error("Context message fingerprint cannot serialize bigint values");
      assign(task.parent, task.key, source);
      continue;
    }
    if (task.depth >= MAX_FINGERPRINT_DEPTH) failLimit();
    if (Array.isArray(source)) {
      consume(source.length);
      const target = new Array<unknown>(source.length);
      assign(task.parent, task.key, target);
      for (let index = source.length - 1; index >= 0; index -= 1) {
        tasks.push({ source: source[index], parent: target, key: index, depth: task.depth + 1 });
      }
      continue;
    }

    const keys: string[] = [];
    for (const key in source) {
      if (!Object.hasOwn(source, key)) continue;
      consume(1 + key.length);
      keys.push(key);
    }
    keys.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    const target: Record<string, unknown> = {};
    assign(task.parent, task.key, target);
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      tasks.push({
        source: (source as Record<string, unknown>)[key],
        parent: target,
        key,
        depth: task.depth + 1,
      });
    }
  }
  return root.value;
}

export function fingerprintMessage(message: AgentMessage): string {
  const serialized = JSON.stringify(stableValue(message));
  if (serialized === undefined || Buffer.byteLength(serialized, "utf8") > MAX_FINGERPRINT_BYTES) failLimit();
  return createHash("sha256").update(serialized).digest("hex");
}
