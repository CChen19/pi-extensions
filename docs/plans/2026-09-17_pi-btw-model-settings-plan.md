# pi-btw model settings plan

## Goal

Add a searchable **Model** row to `/btw` → **Settings** so users can choose an available side-thread model or reset to **Same as main thread**, with immediate durable saving and no change to the main session model.

## Context

- `pi-btw.json` already accepts `model: "provider/model-id"`, and `resolveBtwModel()` already resolves credentials, warns on failure, and falls back to the main model.
- `packages/pi-btw/src/menu.ts` exposes the other settings but cannot currently write or clear `model`.
- The selector should use Pi's authenticated model snapshot and honor `ctx.scopedModels` when the session has a model scope; an existing manual model reference outside that scope must remain visible and unchanged until the user explicitly selects another choice.
- Selecting a model changes the supported thinking-level choices shown by the same Settings flow, but does not rewrite a saved thinking level merely because the new model clamps its effective value.
- The working tree is clean, but local `node_modules` is stale: `packages/pi-btw` currently resolves `@narumitw/pi-tui-kit@0.59.0` while the lockfile requires `0.64.0`; run root `npm install` before verification.

### Applicable rules

- **Settings persistence — MUST (Test + Review):** preserve unknown fields, reject malformed or invalid files without rewriting them, serialize writes, publish atomically, and restore the previous displayed value after save failure.
- **TUI lifecycle — MUST (Test + Review):** keep the flow TUI-only, preserve the editor, make Back/Ctrl+C/disposal read-only, abort owned pending saves, and revalidate state after each `await`.
- **Terminal safety — MUST (Test + Review):** treat provider IDs, model IDs, and model names as untrusted display text; retain raw identities for lookup and persistence while sanitizing at the Kit display/search boundary.
- **Model-picker behavior — Review:** list only currently available models, apply Pi's current model scope, provide searchable labels and names, and keep unavailable or out-of-scope configured references observable without silently deleting them.
- **Published behavior — MUST (Review):** add a Changesets minor entry for `@narumitw/pi-btw`.
- **Documentation — MUST (Review + Validator):** keep the README's existing required sections and make the Settings section match the implemented menu, fallback, path, and reload behavior.
- **Verification — MUST (Validator + Test):** run `npm run check` and `npm test`; validate the generated runtime through the existing build/Jiti tests.

## Architecture

- Keep model discovery and selection in the existing declarative `@narumitw/pi-tui-kit` menu flow; add a searchable choice screen rather than nesting another `ctx.ui.custom()` call.
- Snapshot the current model, `modelRegistry.getAvailable()`, and effective scoped candidates when the menu opens. Use stable synthetic item IDs mapped to raw model objects so duplicate labels or sanitized text never become identities.
- Represent inheritance by omitting `model` from `pi-btw.json`. Selecting **Same as main thread** therefore sends a patch that deletes the field; selecting a model stores its raw `provider/model-id` reference.
- Resolve the Settings summary and thinking-level choices from the newly saved model after every menu-state reload. Keep request-time credential validation and fallback in `resolveBtwModel()` as the final authority.

## Non-Goals

- Do not change the main Pi session model.
- Do not add a `/btw settings` textual subcommand or a second settings implementation.
- Do not test credentials or make a model request while browsing Settings.
- Do not migrate the existing string model format or add project-scoped settings.

## Plan

- [x] Run root `npm install`, then verify `npm ls @narumitw/pi-tui-kit --workspace @narumitw/pi-btw` resolves the lockfile-compatible Kit version without changing package intent. Evidence: `@narumitw/pi-tui-kit@0.64.0`; no lockfile diff.
- [x] Extend `packages/pi-btw/src/settings.ts` so `BtwSettingsPatch` can set or delete `model`; verify focused settings tests cover first save, replacement, reset, unknown-field preservation, invalid-file protection, ordered writes, and atomic failure recovery. Evidence: focused settings tests pass.
- [x] Update `packages/pi-btw/src/menu.ts` and the `showCommandMenuForBtw()` wiring in `packages/pi-btw/src/btw.ts` to add the Model row and searchable model screen, honor available/scoped models, preserve unavailable configured references, return to Settings after an immediate save, and recompute effective thinking choices; verify with menu tests for selection, reset, search, scope, unavailable/out-of-scope state, save rollback, cancellation, disposal, narrow rendering, and unsafe model metadata. Evidence: focused menu tests pass.
- [x] Update affected `packages/pi-btw/test/*.test.ts` fixtures and navigation assertions so existing start, resume, thinking, shortcut, editor-preservation, credential-fallback, and command flows remain covered after inserting the new row; run the focused pi-btw tests. Evidence: 15 files and 344 pi-btw tests pass.
- [x] Update `packages/pi-btw/README.md` to state that model selection is available through `/btw` → **Settings** as well as manual JSON editing, and add a minor `.changeset/*.md` entry describing the new selector without adding a package version to long-lived guidance.
- [ ] Audit the final diff against `docs/extension-conventions.md`, `docs/extension-settings.md`, and `docs/readme-conventions.md`; record any deviation or unverified path, then run `npm run check` and `npm test` from the repository root. Evidence: semantic audit and `npm run check` pass; the affected root and pi-btw gate passes all 25 files and 394 tests. Plain full `npm test` was attempted three times but remains blocked by unrelated 5-second timeouts in unchanged Git/process-heavy packages under sustained host load.

## Completion Checklist

- [x] `/btw` → **Settings** shows the effective model and opens a searchable, terminal-safe selector.
- [x] Choosing a model persists exactly `provider/model-id`; choosing **Same as main thread** removes `model` and leaves the main session unchanged.
- [x] Model changes immediately refresh the Settings summary and model-dependent thinking choices, and apply to the next new or resumed BTW invocation.
- [x] Cancellation, disposal, invalid settings, and failed saves preserve the previous file, displayed value, editor draft, and effective behavior.
- [x] Available/scoped, unavailable, out-of-scope, duplicate-label, and unsafe-metadata cases have deterministic test coverage.
- [x] README and minor changeset match the shipped behavior.
- [ ] `npm run check` and `npm test` pass, including generated-runtime/Jiti coverage. `npm run check` and the affected root/pi-btw `npm test` gate pass all 25 files and 394 tests, including generated-runtime/Jiti coverage; the full suite remains blocked by unrelated host-timeout failures.
