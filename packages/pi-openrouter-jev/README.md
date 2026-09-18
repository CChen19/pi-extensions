# 🧭 pi-openrouter-jev — Typed Jev Decisions for Pi

[![npm](https://img.shields.io/npm/v/@narumitw/pi-openrouter-jev)](https://www.npmjs.com/package/@narumitw/pi-openrouter-jev) [![Pi extension](https://img.shields.io/badge/Pi-extension-blue)](https://pi.dev) [![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](./LICENSE)

Give Pi a `jev_decide` tool for narrow, structured decisions through OpenRouter's TypeSafe Jev Decisions API.
Jev returns probabilities instead of prose, while Pi or your application remains responsible for the workflow.

## ✨ Features

- Asks multiple typed questions about one string, object, or array state in a single request.
- Supports `noul` yes probabilities, fixed-option `choice` distributions, and ordered `score` distributions.
- Uses the moving `~typesafe/jev-latest` model alias through OpenRouter's Decisions API.
- Reuses Pi's resolved OpenRouter authentication without storing another credential.
- Validates request semantics and response distributions before exposing answers to the model.
- Bundles a `typesafe-ai` skill that checks current TypeSafe guidance before designing or troubleshooting Jev judgments.
- Honors tool cancellation and bounds model-visible output to Pi's 50 KB or 2,000-line limits.

## 📦 Install

Install the extension permanently:

```bash
pi install npm:@narumitw/pi-openrouter-jev
```

Try it without installing permanently:

```bash
pi -e npm:@narumitw/pi-openrouter-jev
```

Try this package locally from the repository root:

```bash
pi -e ./packages/pi-openrouter-jev
```

Pi extensions run with the Pi process's user permissions, so install only trusted packages.
This extension sends tool-provided state and questions to OpenRouter and TypeSafe for inference.

## 🚀 Quick start

Configure OpenRouter through Pi:

```text
/login openrouter
```

Pi's existing `OPENROUTER_API_KEY` provider authentication also works:

```bash
export OPENROUTER_API_KEY=sk-or-v1-...
pi
```

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

The extension fixes the endpoint and model to `https://openrouter.ai/api/alpha/decisions` and `~typesafe/jev-latest`.
It does not retry failed requests automatically or act on returned decisions.

## 🧠 Skills

The package bundles the `typesafe-ai` skill for building or directly using TypeSafe, Jev, and `jev_decide` judgments.
Pi discovers it with the package and loads it when a task matches; use `/skill:typesafe-ai` to load it explicitly.
The skill requires reading the relevant live TypeSafe primitive documentation before composing a request and distinguishes schema validation from model or provider failures.

## 🔒 Security and privacy

The extension resolves the `openrouter` credential through Pi's provider authentication and sends only its Bearer authorization plus JSON content to the official OpenRouter endpoint.
It refuses credentials associated with a custom or proxy OpenRouter base URL rather than forwarding them to `openrouter.ai`.
Credential values are not included in tool results, logs, or API error messages.

Every tool call sends its complete `state`, instructions, and criteria to OpenRouter and the selected TypeSafe provider.
Do not include secrets or regulated data unless that transfer is appropriate for your OpenRouter and TypeSafe account policies.
Requests use paid OpenRouter inference according to the active account and model pricing.

## 🚧 Limitations

- OpenRouter labels the Decisions endpoint `alpha`, so upstream request or response behavior can change.
- `~typesafe/jev-latest` is a moving alias; decision behavior can change when TypeSafe publishes a new Jev version.
- The extension validates response shape and probability ranges, not whether a decision is factually correct.
- Large result sets are truncated in model-visible output; ask fewer questions or use fewer choice options when this occurs.
- Pi must have official OpenRouter provider authentication even when the active chat model uses another provider.

## 🗂️ Package layout

```text
packages/pi-openrouter-jev/
├── src/
│   ├── index.ts        # Thin Pi entrypoint
│   ├── jev.ts          # Tool registration and public exports
│   ├── client.ts       # OpenRouter authentication, request, and bounded output
│   ├── validation.ts   # Request and response semantic validation
│   └── types.ts        # Typed Jev questions and answers
├── skills/
│   └── typesafe-ai/    # TypeSafe and Jev design and troubleshooting guidance
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
