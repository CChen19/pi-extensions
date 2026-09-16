# Pi TUI Kit public API plan

## Goal

Add focused interaction subpaths plus standalone document-review and multi-select APIs without changing existing root exports or consumer packages, while preserving Kit rendering, lifecycle, TUI, and RPC behavior.

## Context

- The change touches reusable-library package exports, custom TUI interactions, RPC dialogs, public API documentation, runtime benchmarking, and published behavior.
- PR #1315 merged first with the Mermaid Markdown transformer and API version 19. This work reuses the existing internal review Mermaid preparation path, preserves that public API, and advances Kit's API version to 20 without duplication.
- No settings, extension entrypoint, consumer migration, or publication is in scope.

## Applicable MUST rules and verification

- Custom UI runs only in TUI, every rendered line stays within the supplied width, callback theme/keybindings are used, input focus is forwarded, owned work is cancelled on disposal, and stale ownership is checked after awaits. Verify with focused TUI lifecycle, custom-keybinding, mouse, resize, cancellation, disposal, and stale-result tests plus semantic review against `docs/extension-conventions.md` and Pi TUI docs.
- RPC uses supported dialog methods only, never calls `custom()`, and print/JSON return observable typed unsupported results. Verify with scripted RPC and non-UI tests.
- Package contents, exports, declarations, and dependencies stay aligned. Verify with built runtime/type import tests, `npm run check:boundaries`, full `npm run check`, and `npm run package:pack -- tui-kit` tarball inspection.
- Published behavior receives an independent Changeset. Verify with `npm run changeset:status`.
- README changes retain the required reusable-library sections and document only implemented interfaces. Verify with implementation/test review, the repository README heading audit through `npm run check`, and `npm test`.
- Changed behavior has deterministic tests, then both repository gates run separately. Verify with the complete Kit suite, `npm run check`, and `npm test`.

## Architecture

- Focused package subpaths forward only to their authoritative interaction modules and remain additive to root exports.
- `runDocumentReview()` owns interaction lifecycle and mode adaptation, but delegates TUI rendering/search/width/mouse behavior and RPC document pagination to the existing review component and formatting helpers.
- `runMultiSelect()` owns only an interaction-local selected-ID set and completion/cancellation result; it delegates TUI filtering/toggles/keyboard/mouse behavior to the existing multi-select component and uses deterministic RPC dialogs. Consumers retain domain state and persistence.
- Neither API exposes internal component factories or rendering-preparation helpers.

## Non-Goals

- Do not migrate consumers, publish packages, expose low-level screen factories, or duplicate PR #1315's Markdown transformer.
- Do not add persistence, settings, domain callbacks, or specialized bulk-action policy to the standalone multi-select API.

## Risks

- PR #1315 changed nearby exports, docs, tests, and benchmarks; the final diff must preserve all version-19 Mermaid APIs while adding this work as API version 20.
- Focused imports can regress if static imports reach the root runtime or unrelated document/component graphs; cold-process benchmark graph evidence must cover every added subpath.

## Plan

- [x] Add focused subpath manifests and forwarders for task, custom interaction, live choice, confirmation, questionnaire, selectors, document review, and multi-select; built runtime/type import tests and root compatibility passed.
- [x] Make focused cold imports avoid the package root, menu runtime, unrelated review/multi-select graphs, syntax highlighter, and Mermaid renderer; the one-run cold-process benchmark reported no unrelated heavy graphs for every focused scenario.
- [x] Implement `runDocumentReview()` with existing review formatting, search, optional confirmation, exact-width TUI rendering, RPC pages, lifecycle-safe Mermaid preparation, and typed lifecycle results; focused tests passed.
- [x] Implement `runMultiSelect()` with disabled items, optional TUI fuzzy search, completion, keyboard/mouse behavior, RPC adaptation, interaction-local state, and typed lifecycle results; focused tests passed.
- [x] Update root exports, README, API reference, API version, and a minor Changeset without consumer changes; implementation review and the fenced-code-aware heading audit preserve required README sections.
- [ ] Run semantic lifecycle and touched-area audits, the full Kit test suite, benchmark, `npm run check`, `npm test`, Changesets status, and package pack inspection; the 37-file, 426-test Kit suite and every other gate passed, while the latest `npm test` attempt timed out at 300 seconds after 42 unrelated failures in Pi Sync (31), Pi LSP (6), Pi Subagents (2), Pi GitHub PR (1), Pi Fleet (1), and Pi Starship (1).

## Completion Checklist

- [x] Existing root exports remain available and every new subpath resolves both JavaScript and declarations.
- [x] Cancellation, disposal, stale ownership, RPC/non-TUI behavior, custom keybindings, mouse routing, exact width, and package exports have focused evidence where applicable.
- [x] Final diff does not expose low-level component factories, change consumers, duplicate PR #1315, or publish anything.
- [ ] Required checks and smokes pass, or each external/timeout failure is recorded precisely; the root test timeout and suites must remain in the final handoff.
- [ ] Completed plan is deleted and the final handoff names guides, audits, checks, PR #1315 sequencing, deviations, and unverified paths.
