import type { ModuleStyleContext, ModuleStyleRule, ModuleStyleSelector } from "./types.js";

export function resolveStyleRule(
  rules: readonly ModuleStyleRule[],
  selectors: Readonly<Record<string, ModuleStyleSelector>>,
  context: ModuleStyleContext,
): string | undefined {
  for (const rule of rules) {
    let matches = true;
    for (const name in rule.selectors) {
      if (!Object.hasOwn(rule.selectors, name)) continue;
      const selector = Object.hasOwn(selectors, name) ? selectors[name] : undefined;
      if (!selector || selector(context) !== rule.selectors[name]) {
        matches = false;
        break;
      }
    }
    if (matches) return rule.style;
  }
  return undefined;
}
