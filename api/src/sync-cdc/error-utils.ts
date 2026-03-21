export interface CdcErrorInfo {
  code: string;
  message: string;
}

export function toCdcErrorInfo(
  error: unknown,
  fallbackCode = "CDC_RUNTIME_ERROR",
): CdcErrorInfo {
  if (error instanceof Error) {
    return {
      code: fallbackCode,
      message: error.message,
    };
  }
  return {
    code: fallbackCode,
    message: typeof error === "string" ? error : "Unknown CDC error",
  };
}
