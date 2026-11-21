const KIND = "mako:boxed-read-failure";

export interface BoxedReadFailure {
  entity: string;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Project only the catalog identifier. The boxed TRACE has no typed HTTP or Graph codes. */
export function boxedReadFailure(value: unknown): BoxedReadFailure | undefined {
  const entity = record(value)?.entity;
  return typeof entity === "string" &&
    /^[a-zA-Z0-9_][a-zA-Z0-9_.:-]{0,127}$/.test(entity)
    ? { entity }
    : undefined;
}

/** Keep the existing retry message. Inngest preserves cause across steps. */
export function boxedReadError(
  message: string,
  entity: string,
  catalog: readonly string[],
): Error {
  const detail = catalog.includes(entity) && boxedReadFailure({ entity });
  return detail
    ? new Error(message, { cause: { kind: KIND, ...detail } })
    : new Error(message);
}

/** Recover only the runner's marker. Never extract metadata from message text. */
export function readBoxedReadFailure(
  error: unknown,
): BoxedReadFailure | undefined {
  let node = record(error)?.cause;
  for (let depth = 0; depth < 5; depth++) {
    const cause = record(node);
    if (!cause) return;
    if (cause.kind === KIND) return boxedReadFailure(cause);
    node = cause.cause;
  }
  return undefined;
}
