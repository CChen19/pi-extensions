import type { Api, Model } from "@earendil-works/pi-ai";
import type { CodexCompactSettings } from "./settings.js";

export const RESPONSES_COMPACTION_APIS = [
  "openai-codex-responses",
  "openai-responses",
  "azure-openai-responses",
] as const;

export type BuiltInResponsesCompactionApi = (typeof RESPONSES_COMPACTION_APIS)[number];
export type ResponsesCompactionApi = BuiltInResponsesCompactionApi;
export type ResponsesCompactionProfile = "codex-responses-v1" | "openai-responses-v1";
export type RemoteCompactionProtocol = "remote-v2" | "responses-compact";
export type RemoteCompactionProtocolSetting = "auto" | RemoteCompactionProtocol;

export type CompactionRoute =
  | { kind: "remote"; protocol: RemoteCompactionProtocol; api: Api; profile: ResponsesCompactionProfile }
  | { kind: "native"; reason: string };

function resolveResponsesCompactionProfile(
  api: Api | undefined,
  apiProfiles: Readonly<Record<string, "codex-responses-v1">> = {},
): ResponsesCompactionProfile | undefined {
  if (api === "openai-codex-responses") return "codex-responses-v1";
  if (api === "openai-responses" || api === "azure-openai-responses") return "openai-responses-v1";
  return api && Object.hasOwn(apiProfiles, api) && apiProfiles[api] === "codex-responses-v1"
    ? "codex-responses-v1"
    : undefined;
}

export function resolveCompactionRouteForApi(
  api: Api | undefined,
  options: Pick<CodexCompactSettings, "enabled" | "protocol"> & {
    apiProfiles?: Readonly<Record<string, "codex-responses-v1">>;
  },
): CompactionRoute {
  if (!options.enabled) return { kind: "native", reason: "remote compaction is disabled" };
  if (!api) return { kind: "native", reason: "no active model" };
  const profile = resolveResponsesCompactionProfile(api, options.apiProfiles);
  if (!profile) {
    return { kind: "native", reason: `API ${api} does not support Responses compaction` };
  }
  const protocol =
    options.protocol === "auto"
      ? profile === "codex-responses-v1"
        ? "remote-v2"
        : "responses-compact"
      : options.protocol;
  return { kind: "remote", protocol, api, profile };
}

export function resolveCompactionRoute(
  model: Model<Api> | undefined,
  options: Pick<CodexCompactSettings, "enabled" | "protocol"> & {
    apiProfiles?: Readonly<Record<string, "codex-responses-v1">>;
  },
): CompactionRoute {
  return resolveCompactionRouteForApi(model?.api, options);
}
