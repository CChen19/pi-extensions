# 🧭 pi-typesafe — Typed Jev Decisions for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-typesafe)](https://www.npmjs.com/package/@narumitw/pi-typesafe) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give Pi a `jev_decide` tool for narrow, structured decisions through TypeSafe's official Jev API, with OpenRouter as a fallback.
Jev returns probabilities instead of prose, while Pi or your application remains responsible for the workflow.

## ✨ Features

- Asks multiple typed questions about one string, object, or array state in a single request.
- Supports `noul` yes probabilities, fixed-option `choice` distributions, and ordered `score` distributions.
- Uses TypeSafe's official API and `jev-latest` model when `TYPESAFE_API_KEY` is set.
- Falls back to OpenRouter's Decisions API and `~typesafe/jev-latest` only when a TypeSafe key is absent.
- Reuses Pi's resolved OpenRouter authentication for the fallback without storing another credential.
- Validates request semantics and response distributions before exposing answers to the model.
- Bundles a `typesafe-ai` skill with TypeSafe concepts, question design, API and SDK references, composition patterns, and practical cookbooks.
- Honors tool cancellation and bounds model-visible output to Pi's 50 KB or 2,000-line limits.

## 📦 Install

Install the extension permanently:

```bash
pi install npm:@narumitw/pi-typesafe
```

Try it without installing permanently:

```bash
pi -e npm:@narumitw/pi-typesafe
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-typesafe
```

Pi extensions run with the Pi process's user permissions, so install only trusted packages.
This extension sends tool-provided state and questions to TypeSafe directly, or to OpenRouter and TypeSafe when using the fallback.

## 🚀 Quick start

Create a TypeSafe API key, then expose it to Pi:

```bash
export TYPESAFE_API_KEY=...
pi
```

Without `TYPESAFE_API_KEY`, the extension can use Pi's OpenRouter authentication as a fallback:

```text
/login openrouter
```

Pi's existing `OPENROUTER_API_KEY` provider authentication also works for that fallback.

Then ask Pi to use Jev for a typed decision:

```text
Use jev_decide to decide whether this ticket is urgent, which team owns it,
and how frustrated the customer is: "Help! My payouts have been failing for 3 days."
```

The tool returns validated JSON under the same question names supplied in the request.

## 🛠️ Tools

### `jev_decide`

The tool accepts one shared `state` and a non-empty `questions` map:

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent": {
      "type": "noul",
      "instructions": "Does this message convey urgency?",
      "criteria": {
        "true": "Explicitly time-sensitive",
        "false": "No urgency expressed"
      }
    },
    "department": {
      "type": "choice",
      "instructions": "Which team should handle this?",
      "criteria": {
        "billing": "Payments, invoicing, refunds",
        "technical": "Bugs, outages, integrations",
        "sales": "Pricing, upgrades, new accounts"
      }
    },
    "frustration": {
      "type": "score",
      "instructions": "How frustrated is the customer?",
      "criteria": ["Calm", "Frustrated", "Very angry"]
    }
  }
}
```

- `noul` returns `noul` from 0 for no to 1 for yes. Its `criteria` is optional; when present, both `true` and `false` descriptions are required.
- `choice` requires 2–255 named options and returns `choice`, `probabilities`, and `confidence`.
- `score` requires 2–10 ordered levels and returns a probability-weighted `score`, `legend`, `probabilities`, and `confidence`.
- `state`, instructions, choice descriptions, and score levels may use structured JSON when a string is insufficient.

With `TYPESAFE_API_KEY`, the extension calls `https://api.typesafe.ai/v1/systemone` with `jev-latest`.
When that key is absent, it falls back to `https://openrouter.ai/api/alpha/decisions` with `~typesafe/jev-latest`.
It does not switch providers after a request failure, retry failed requests automatically, or act on returned decisions.

## 🧠 Skills

The package bundles the `typesafe-ai` skill for designing, implementing, evaluating, and troubleshooting TypeSafe, Jev, and `jev_decide` workflows.
Pi discovers it with the package and loads it when a task matches; use `/skill:typesafe-ai` to load it explicitly.
Its [reference index](./skills/typesafe-ai/references/index.md) links concise local snapshots for concepts, question design, composition, HTTP and SDK integration, migration, and applied cookbooks.
The skill treats live TypeSafe documentation and installed SDK types as authoritative when freshness matters.

## 🔒 Security and privacy

The preferred path reads `TYPESAFE_API_KEY` from the environment and sends its Bearer authorization plus JSON content only to the official TypeSafe endpoint.
When that key is absent, the extension resolves the `openrouter` credential through Pi's provider authentication and sends the request to the official OpenRouter endpoint.
It refuses OpenRouter credentials associated with a custom or proxy base URL rather than forwarding them to `openrouter.ai`.
Credential values are not included in tool results, logs, or API error messages.

Every tool call sends its complete `state`, instructions, and criteria to TypeSafe, either directly or through OpenRouter.
Do not include secrets or regulated data unless that transfer is appropriate for the applicable TypeSafe and OpenRouter account policies.
Requests may incur charges according to the selected provider's account and model pricing.

## 🚧 Limitations

- OpenRouter labels its fallback Decisions endpoint `alpha`, so that route's request or response behavior can change.
- `jev-latest` and `~typesafe/jev-latest` are moving aliases; decision behavior can change when TypeSafe publishes a new Jev version.
- The extension validates response shape and probability ranges, not whether a decision is factually correct.
- Large result sets are truncated in model-visible output; ask fewer questions or use fewer choice options when this occurs.
- The OpenRouter fallback requires official OpenRouter provider authentication even when the active chat model uses another provider.

## 🗂️ Package layout

```text
packages/pi-typesafe/
├── src/
│   ├── index.ts        # Thin Pi entrypoint
│   ├── jev.ts          # Tool registration and public exports
│   ├── client.ts       # TypeSafe-first provider selection, requests, and bounded output
│   ├── validation.ts   # Request and response semantic validation
│   └── types.ts        # Typed Jev questions and answers
├── skills/
│   └── typesafe-ai/
│       ├── SKILL.md    # TypeSafe and Jev workflow guidance
│       └── references/ # Concepts, APIs, SDKs, patterns, and cookbooks
├── test/               # Tool, authentication, validation, and output coverage
├── package.json
├── README.md
└── LICENSE
```

The package publishes its TypeScript source entrypoint for Pi's Jiti runtime and needs no build step.

## 🔎 Keywords

Pi extension, Pi coding agent, OpenRouter, TypeSafe, Jev, System One, structured decisions, classification, routing, probability scoring.

## 📄 License

MIT. See [`LICENSE`](./LICENSE).
