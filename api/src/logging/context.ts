import { AsyncLocalStorage } from "node:async_hooks";
import { getLogger, withContext } from "@logtape/logtape";
import type { Context, Next } from "hono";

/**
 * Request context that gets attached to all logs within a request
 */
export interface RequestContext {
  /** Trace ID from X-Cloud-Trace-Context header */
  traceId?: string;
  /** Span ID for distributed tracing */
  spanId?: string;
  /** Request ID (generated or from header) */
  requestId: string;
  /** User ID if authenticated */
  userId?: string;
  /** Workspace ID if in workspace context */
  workspaceId?: string;
  /** HTTP method */
  method: string;
  /** Request path */
  path: string;
  /** Request start time */
  startTime: number;
}

/**
 * Storage for request context (used by LogTape's contextLocalStorage)
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Extracts trace ID from X-Cloud-Trace-Context header
 * Format: TRACE_ID/SPAN_ID;o=TRACE_TRUE
 */
function parseCloudTraceContext(header: string | undefined): { traceId?: string; spanId?: string } {
  if (!header) return {};

  const parts = header.split("/");
  const traceId = parts[0];

  let spanId: string | undefined;
  if (parts[1]) {
    const spanParts = parts[1].split(";");
    spanId = spanParts[0];
  }

  return { traceId, spanId };
}

/**
 * Generates a random request ID
 */
function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Hono middleware that sets up request context for logging
 * This enables all logs within a request to automatically include:
 * - Trace ID (for Cloud Run log correlation)
 * - Request ID
 * - User/Workspace context (when available)
 * - Request timing
 */
export function loggingMiddleware() {
  const logger = getLogger(["http"]);

  return async (c: Context, next: Next) => {
    const startTime = Date.now();

    // Parse trace context from Cloud Run
    const cloudTraceHeader = c.req.header("x-cloud-trace-context");
    const { traceId, spanId } = parseCloudTraceContext(cloudTraceHeader);

    // Get or generate request ID
    const requestId = c.req.header("x-request-id") || generateRequestId();

    // Build initial request context
    const context: RequestContext = {
      traceId,
      spanId,
      requestId,
      method: c.req.method,
      path: c.req.path,
      startTime,
    };

    // Set response header for request tracking
    c.header("x-request-id", requestId);

    // Run the request within the logging context
    return withContext({ ...context }, async () => {
      // Store context for other middleware to enrich
      requestContextStorage.enterWith(context);

      // Log request start
      logger.info("Request started", {
        traceId,
        spanId,
        requestId,
        httpRequest: {
          requestMethod: c.req.method,
          requestUrl: c.req.url,
          userAgent: c.req.header("user-agent"),
          remoteIp: c.req.header("x-forwarded-for") || c.req.header("cf-connecting-ip"),
        },
      });

      try {
        await next();

        const duration = Date.now() - startTime;
        const status = c.res.status;

        // Log request completion
        const logLevel = status >= 500 ? "error" : status >= 400 ? "warning" : "info";
        logger[logLevel]("Request completed", {
          traceId,
          spanId,
          requestId,
          userId: context.userId,
          workspaceId: context.workspaceId,
          httpRequest: {
            requestMethod: c.req.method,
            requestUrl: c.req.url,
            status,
            latency: `${duration / 1000}s`,
          },
          duration,
        });
      } catch (error) {
        const duration = Date.now() - startTime;

        logger.error("Request failed", {
          traceId,
          spanId,
          requestId,
          userId: context.userId,
          workspaceId: context.workspaceId,
          error,
          httpRequest: {
            requestMethod: c.req.method,
            requestUrl: c.req.url,
          },
          duration,
        });

        throw error;
      }
    });
  };
}

/**
 * Updates the current request context with user information
 * Call this after authentication middleware has identified the user
 */
export function enrichContextWithUser(userId: string): void {
  const context = requestContextStorage.getStore();
  if (context) {
    context.userId = userId;
  }
}

/**
 * Updates the current request context with workspace information
 * Call this after workspace middleware has identified the workspace
 */
export function enrichContextWithWorkspace(workspaceId: string): void {
  const context = requestContextStorage.getStore();
  if (context) {
    context.workspaceId = workspaceId;
  }
}

/**
 * Gets the current request context
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}
