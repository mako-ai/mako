import type { ContentfulStatusCode } from "hono/utils/http-status";

/**
 * A refusal a flow service raises for its route to answer as-is: the status
 * and the `{ success: false, error, ...extra }` body. Services stay free of
 * Hono; the route maps this with `flowFailure` (routes/flows/shared.ts).
 */
export class FlowRequestError extends Error {
  constructor(
    readonly status: ContentfulStatusCode,
    message: string,
    readonly extra?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "FlowRequestError";
  }
}
