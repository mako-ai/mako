import { AsyncLocalStorage } from "node:async_hooks";
import { getLogger, withContext } from "@logtape/logtape";
import type { Context, Next } from "hono";

/**
 * Request context that gets attached to all logs within a request
 */
export interface RequestContext {
  /** Trace ID from distributed tracing headers (X-Cloud-Trace-Context, X-Trace-Id, etc.) */
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
 * Options for HTTP logging middleware
 */
export interface HttpLoggingOptions {
  /**
   * Routes to skip logging for successful (2xx/3xx) requests in development.
   * Errors (4xx/5xx) and slow requests are always logged.
   * @example ["/api/inngest", "/health"]
   */
  skipSuccessInDev?: string[];

  /**
   * Threshold in milliseconds for slow request logging.
   * Requests exceeding this duration are always logged, even for skipped routes.
   * @default 1000 (1 second)
   */
  slowRequestThresholdMs?: number;
}

/**
 * Detects if running in production mode
 */
function isProduction(): boolean {
  return process.env.NODE_ENV === "production";
}

/**
 * Storage for request context (used by LogTape's contextLocalStorage)
 */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * Extracts trace ID from distributed tracing headers
 * Supports X-Cloud-Trace-Context format: TRACE_ID/SPAN_ID;o=TRACE_TRUE
 * Also checks X-Trace-Id and X-Request-Id as fallbacks
 */
function parseTraceContext(
  cloudTraceHeader: string | undefined,
  traceIdHeader: string | undefined,
): { traceId?: string; spanId?: string } {
  // Try X-Cloud-Trace-Context first (GCP format)
  if (cloudTraceHeader) {
    const parts = cloudTraceHeader.split("/");
    const traceId = parts[0];
    let spanId: string | undefined;
    if (parts[1]) {
      const spanParts = parts[1].split(";");
      spanId = spanParts[0];
    }
    return { traceId, spanId };
  }

  // Fall back to X-Trace-Id (common header)
  if (traceIdHeader) {
    return { traceId: traceIdHeader };
  }

  return {};
}

/**
 * Generates a random request ID
 */
function generateRequestId(): string {
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 11)}`;
}

/**
 * Checks if a path should skip logging for successful requests
 */
function shouldSkipLogging(
  path: string,
  status: number,
  duration: number,
  options: HttpLoggingOptions,
): boolean {
  const slowThreshold = options.slowRequestThresholdMs ?? 1000;

  // Always log errors (4xx/5xx)
  if (status >= 400) {
    return false;
  }

  // Always log slow requests
  if (duration >= slowThreshold) {
    return false;
  }

  // In production, log everything
  if (isProduction()) {
    return false;
  }

  // In development, skip specified routes for successful fast requests
  const skipRoutes = options.skipSuccessInDev || [];
  return skipRoutes.some(route => path.startsWith(route));
}

/**
 * Hono middleware that sets up request context for logging.
 *
 * Uses the "canonical log line" approach: emits a single, comprehensive log
 * at request completion instead of separate start/end logs.
 *
 * Features:
 * - Single log per request with format: "METHOD /path STATUS DURATIONms"
 * - Automatic trace correlation (X-Cloud-Trace-Context, X-Trace-Id)
 * - Request ID generation/tracking
 * - User/Workspace context enrichment
 * - Environment-aware filtering for noisy routes in development
 *
 * @param options - Configuration options for logging behavior
 */
export function loggingMiddleware(options: HttpLoggingOptions = {}) {
  // Logger is created lazily on first request to ensure it's created
  // after LogTape has been configured (initialization starts automatically
  // when the logging module is imported)
  let logger: ReturnType<typeof getLogger> | null = null;

  const getHttpLogger = () => {
    if (!logger) {
      logger = getLogger(["http"]);
    }
    return logger;
  };

  return async (c: Context, next: Next) => {
    const startTime = Date.now();

    // Parse trace context from distributed tracing headers
    const { traceId, spanId } = parseTraceContext(
      c.req.header("x-cloud-trace-context"),
      c.req.header("x-trace-id"),
    );

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
    // IMPORTANT: Pass the same context object reference to both withContext and
    // requestContextStorage so that enrichContextWithUser/enrichContextWithWorkspace
    // mutations are visible to LogTape's implicit context
    return withContext(
      context as unknown as Record<string, unknown>,
      async () => {
        // Store context for other middleware to enrich (same object reference)
        requestContextStorage.enterWith(context);

        try {
          await next();

          const duration = Date.now() - startTime;
          const status = c.res.status;
          const { method, path } = context;
          const slowThreshold = options.slowRequestThresholdMs ?? 1000;

          // Skip logging for noisy routes in dev (successful fast requests only)
          if (shouldSkipLogging(path, status, duration, options)) {
            return;
          }

          // Canonical log line: "METHOD /path STATUS DURATIONms"
          // Add [SLOW] tag for requests exceeding threshold
          const isSlow = duration >= slowThreshold;
          const slowTag = isSlow ? " [SLOW]" : "";
          const logLevel =
            status >= 500
              ? "error"
              : status >= 400
                ? "warn"
                : isSlow
                  ? "warn"
                  : "info";

          getHttpLogger()[logLevel](
            `${method} ${path} ${status} ${duration}ms${slowTag}`,
            {
              requestId,
              traceId,
              spanId,
              userId: context.userId,
              workspaceId: context.workspaceId,
              httpRequest: {
                requestMethod: method,
                requestUrl: c.req.url,
                status,
                userAgent: c.req.header("user-agent"),
                remoteIp:
                  c.req.header("x-forwarded-for") ||
                  c.req.header("cf-connecting-ip"),
              },
              duration,
              slow: isSlow || undefined,
            },
          );
        } catch (error) {
          const duration = Date.now() - startTime;
          const { method, path } = context;

          // Always log errors with full context
          getHttpLogger().error(`${method} ${path} ERROR ${duration}ms`, {
            requestId,
            traceId,
            spanId,
            userId: context.userId,
            workspaceId: context.workspaceId,
            error,
            httpRequest: {
              requestMethod: method,
              requestUrl: c.req.url,
              userAgent: c.req.header("user-agent"),
              remoteIp:
                c.req.header("x-forwarded-for") ||
                c.req.header("cf-connecting-ip"),
            },
            duration,
          });

          throw error;
        }
      },
    );
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
