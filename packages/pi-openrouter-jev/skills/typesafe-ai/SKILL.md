---
name: typesafe-ai
license: MIT
description: Use TypeSafe, Jev, or pi-openrouter-jev's jev_decide tool for typed semantic judgments and probabilities. Use when calling, integrating, designing, or troubleshooting Jev decisions for routing, ranking, extraction, verification, scoring, or other programmable common-sense tasks. Read the live TypeSafe docs before composing requests.
---

# Use TypeSafe and Jev

Keep workflow, policy, exact calculations, and side effects in code.
Use TypeSafe only where semantic judgment helps.

## Read the Live Contract

Treat the live TypeSafe documentation as the source of truth.

- Start with the [documentation index](https://docs.typesafe.ai/llms.txt), then read only the pages relevant to the task.
- Before composing a question, read its current primitive page: [Choice](https://docs.typesafe.ai/primitives/choice.md), [Noul](https://docs.typesafe.ai/primitives/noul.md), or [Score](https://docs.typesafe.ai/primitives/score.md).
- Before writing an integration, also read the current [HTTP API](https://docs.typesafe.ai/api.md), [Python SDK](https://docs.typesafe.ai/sdk/python.md), or [JavaScript SDK](https://docs.typesafe.ai/sdk/javascript.md) page that matches the implementation.
- For a new workflow, inspect the closest cookbook from the documentation index before designing a generic classifier.
- If live access fails, use the active tool schema, package README, or installed SDK types, state the limitation, and do not invent version-dependent fields.

## Choose the Primitive

- Use `choice` for one option from a defined set.
- Use `noul` for the probability that one yes-or-no condition holds.
- Use `score` for a degree along one ordered dimension with concrete descriptive levels.
- Use one Noul per independently applicable label instead of forcing several labels into one Choice.

## Build a Valid Request

Check the current primitive page and the active tool or SDK schema before the first call.
Do not infer one primitive's `criteria` shape from another primitive.
At the current contract, Choice uses an option map, Score uses an ordered array of 2–10 levels, and Noul optionally uses `true` and `false` descriptions.
Treat this shape summary as a reminder rather than a substitute for the live contract.

Give each question enough relevant state to answer.
Put the complete judgment in `instructions` because question IDs are not sent to the model.
Make each Score level a concrete situation that stands on its own.
Include a no-match Choice option when the available options may not cover the input.
Ask independent questions over the same state together because they run in parallel and cannot see one another's answers.
Use a second request only when an earlier answer is needed to obtain evidence or define later options.

## Handle Results and Failures

Keep thresholds, weights, permissions, and actions in code.
Treat Choice and Score confidence as distribution concentration rather than proof that the answer is correct.
Treat a Noul near 0.5 as similar probability for yes and no, not medium intensity.

When request validation fails, identify the exact rejected field, reread that primitive's contract, and change only the invalid field.
Do not rewrite already-valid sibling questions or substitute a different primitive merely to bypass validation.
Separate local schema validation, model judgment errors, missing evidence, and provider or billing failures before deciding whether to retry.
Stop after a clear non-transient provider failure unless the user asks to retry.

Test representative inputs and resulting application behavior.
Inspect the exact state, questions, candidates, answers, and composition when results are wrong.
Keep API credentials server-side in web applications.
