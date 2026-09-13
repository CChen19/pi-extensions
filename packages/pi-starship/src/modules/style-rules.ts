import type { ModuleStyleContext, ModuleStyleRule, ModuleStyleSelector } from "./types.js";

export function resolveStyleRule(
  rules: readonly ModuleStyleRule[],
  selectors: Readonly<Record<string, ModuleStyleSelector>>,
  context: ModuleStyleContext,
): string | undefined {
  for (const rule of rules) {
    const matches = Object.entries(rule.selectors).every(([name, expected]) => selectors[name]?.(context) === expected);
    if (matches) return rule.style;
  }
  return undefined;
}
