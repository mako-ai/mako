const TOOL_ERROR_MESSAGE_LIMIT = 2_000;

export interface ToolFailureSummary {
  message: string;
  code?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

export function sanitizeToolFailureMessage(value: unknown): string {
  const message =
    value instanceof Error
      ? value.message
      : typeof value === "string"
        ? value
        : "Tool execution failed";
  return message
    .replace(
      /\b[a-z][a-z0-9+.-]*:\/\/[^\s"':@/]+:[^\s"'@/]+@[^\s"']+/gi,
      "***REDACTED_CONNECTION_STRING***",
    )
    .replace(/Bearer\s+[A-Za-z0-9._-]{8,}/g, "Bearer ***REDACTED***")
    .replace(/\b(?:sk|pk|rk)-[A-Za-z0-9._-]{12,}/g, "***REDACTED_API_KEY***")
    .replace(/\bvck_[A-Za-z0-9]{12,}/g, "***REDACTED_API_KEY***")
    .replace(/\bSG\.[A-Za-z0-9._-]{12,}/g, "***REDACTED_API_KEY***")
    .slice(0, TOOL_ERROR_MESSAGE_LIMIT);
}

/**
 * Tools often return a successful JavaScript promise whose domain result is
 * `{ success: false, error }`. The AI SDK treats that as a successful tool
 * execution, so observability must classify the result itself.
 */
export function toolFailureFromOutput(
  output: unknown,
): ToolFailureSummary | null {
  const result = asRecord(output);
  if (!result || result.success !== false) return null;

  return {
    message: sanitizeToolFailureMessage(result.error ?? result.message),
    ...(typeof result.code === "string" ? { code: result.code } : {}),
  };
}

export function toolFailureFromThrown(error: unknown): ToolFailureSummary {
  const value = asRecord(error);
  return {
    message: sanitizeToolFailureMessage(error),
    ...(typeof value?.code === "string" ? { code: value.code } : {}),
  };
}
