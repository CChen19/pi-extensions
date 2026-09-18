import { StringEnum } from "@earendil-works/pi-ai";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  defineTool,
  type ExtensionAPI,
  formatSize,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatJevResult, formatJevToolError, requestJevDecision, resolveOpenRouterAuthorization } from "./client.js";
import { normalizeJevInput } from "./validation.js";

export interface JevExtensionOptions {
  fetch?: typeof fetch;
}

const structuredValueDescription = "A string, JSON object, or JSON array.";
const questionSchema = Type.Object(
  {
    type: StringEnum(["noul", "choice", "score"] as const, {
      description: "noul returns yes probability; choice selects an option; score rates ordered levels.",
    }),
    instructions: Type.Any({
      description: `The complete narrow question. ${structuredValueDescription}`,
    }),
    criteria: Type.Optional(
      Type.Any({
        description:
          "noul: optional {true, false} descriptions; choice: 2-255 option descriptions; score: 2-10 ordered level descriptions.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const jevToolParameters = Type.Object(
  {
    state: Type.Any({
      description: `Shared content to evaluate. ${structuredValueDescription}`,
    }),
    questions: Type.Record(Type.String({ minLength: 1 }), questionSchema, {
      minProperties: 1,
      description: "Named typed questions. Answers use the same names.",
    }),
  },
  { additionalProperties: false },
);

export function createJevTool(options: JevExtensionOptions = {}) {
  return defineTool({
    name: "jev_decide",
    label: "Jev: Decide",
    description: `Ask TypeSafe Jev narrow typed questions about shared state through OpenRouter. Supports noul, choice, and score questions in one request. Returns validated JSON and never performs workflow actions. Output is limited to ${DEFAULT_MAX_LINES} lines or ${formatSize(DEFAULT_MAX_BYTES)}.`,
    promptSnippet: "Make fast typed noul, choice, or score decisions with TypeSafe Jev through OpenRouter",
    promptGuidelines: [
      "Use jev_decide for narrow routing, classification, scoring, or verification decisions when calibrated probabilities are useful; keep workflow actions in code or other tools.",
    ],
    parameters: jevToolParameters,
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      try {
        const input = normalizeJevInput(params);
        const auth = await resolveOpenRouterAuthorization(ctx);
        const response = await requestJevDecision(input, auth, signal, options.fetch);
        return formatJevResult(response);
      } catch (error) {
        if (signal?.aborted || (error instanceof Error && error.name === "AbortError")) throw error;
        throw formatJevToolError(error);
      }
    },
  });
}

export default function jevExtension(pi: ExtensionAPI, options: JevExtensionOptions = {}): void {
  pi.registerTool(createJevTool(options));
}

export { formatJevResult, requestJevDecision, resolveOpenRouterAuthorization } from "./client.js";
export type {
  ChoiceAnswer,
  ChoiceQuestion,
  JevAnswer,
  JevDecisionInput,
  JevDecisionResponse,
  JevQuestion,
  JevUsage,
  JsonValue,
  NoulAnswer,
  NoulQuestion,
  ScoreAnswer,
  ScoreQuestion,
  StructuredValue,
} from "./types.js";
export { normalizeJevInput, normalizeJevResponse } from "./validation.js";
