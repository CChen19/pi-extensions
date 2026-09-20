// Fixed messages for StepFun platform responses. Provider text is never interpolated:
// error messages and their template parameters can contain credentials or terminal controls.
const CODE_MESSAGES: Readonly<Record<string, string>> = {
  unauthenticated: "StepFun platform session is not authenticated. Obtain a new platform Oasis-Token.",
  permission_denied: "StepFun platform denied the session. Obtain a new platform Oasis-Token.",
  invalid_argument: "StepFun platform rejected the request. Try again later.",
  internal: "StepFun platform internal error. Try again later.",
  unavailable: "StepFun platform is unavailable. Try again later.",
  rate_limited: "StepFun platform request rate limit reached. Try again later.",
};

const HTTP_MESSAGES: Readonly<Record<number, string>> = {
  400: "StepFun platform rejected the request. Try again later.",
  401: "StepFun platform session expired. Obtain a new platform Oasis-Token.",
  403: "StepFun platform denied the session. Obtain a new platform Oasis-Token.",
  429: "StepFun platform request rate limit reached. Try again later.",
  500: "StepFun platform internal error. Try again later.",
  502: "StepFun platform is unavailable. Try again later.",
  503: "StepFun platform is unavailable. Try again later.",
};

const AUTH_FAILURE = Symbol("stepfun-auth-failure");

export function stepfunAuthError(message: string): Error {
  return Object.assign(new Error(message), { [AUTH_FAILURE]: true });
}

export function isStepFunAuthError(error: unknown): boolean {
  return error instanceof Error && AUTH_FAILURE in error;
}

export function stepfunHttpErrorMessage(status: number): string {
  return `StepFun HTTP ${status}: ${HTTP_MESSAGES[status] ?? "API request failed."}`;
}

export function stepfunPayloadError(payload: unknown): string | undefined {
  const object = asObject(payload);
  if (!object) return undefined;
  const code = typeof object.code === "string" && object.code.trim() ? object.code.trim() : undefined;
  if (code) return `StepFun ${code}: ${CODE_MESSAGES[code] ?? "API request failed."}`;
  // A numeric status of 1 marks success; any other value is a platform-side rejection.
  if (typeof object.status === "number" && object.status !== 1) return "StepFun: API request failed.";
  return undefined;
}

export function stepfunResponseError(status: number, text: string): string | Error | undefined {
  let payload: unknown;
  try {
    payload = JSON.parse(text) as unknown;
  } catch {
    // Do not expose JSON parser excerpts, response bodies, or statusText.
    if (status >= 200 && status < 300) return "StepFun: Invalid JSON response.";
  }
  const payloadError = stepfunPayloadError(payload);
  if (payloadError) return classifyAuthFailure(status, payload, payloadError);
  if (status < 200 || status >= 300) {
    return classifyAuthFailure(status, payload, stepfunHttpErrorMessage(status));
  }
  return undefined;
}

// Expired or rejected sessions are recoverable: the adapter refreshes the Oasis-Token and retries
// once before surfacing the coded error. A 401, or a 200-wrapped "unauthenticated"/failure status,
// marks an expired session; permission and transport failures are not recoverable that way.
function classifyAuthFailure(status: number, payload: unknown, message: string): string | Error {
  if (status < 200 || status >= 300) return status === 401 ? stepfunAuthError(message) : message;
  const object = asObject(payload);
  const code = typeof object?.code === "string" ? object.code : undefined;
  const rejectedStatus = typeof object?.status === "number" && object.status === 0;
  if (code === "unauthenticated" || rejectedStatus) return stepfunAuthError(message);
  return message;
}

function asObject(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
