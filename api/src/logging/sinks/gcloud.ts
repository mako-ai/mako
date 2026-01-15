import type { Sink, LogRecord } from "@logtape/logtape";

/**
 * Google Cloud Logging severity levels
 * https://cloud.google.com/logging/docs/reference/v2/rest/v2/LogEntry#LogSeverity
 */
const severityMap: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO",
  warning: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

/**
 * Serializes a value for JSON output, handling special types
 */
function serializeValue(value: unknown): unknown {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Map) {
    return Object.fromEntries(value);
  }

  if (value instanceof Set) {
    return Array.from(value);
  }

  if (ArrayBuffer.isView(value)) {
    return `[Binary: ${value.byteLength} bytes]`;
  }

  return value;
}

/**
 * Recursively serializes an object for JSON output
 */
function serializeObject(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Error) && !(value instanceof Date)) {
      result[key] = serializeObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        v !== null && typeof v === "object" ? serializeObject(v as Record<string, unknown>) : serializeValue(v)
      );
    } else {
      result[key] = serializeValue(value);
    }
  }

  return result;
}

export interface GCloudSinkOptions {
  /**
   * GCP project ID for trace correlation
   */
  projectId?: string;

  /**
   * Service name (defaults to K_SERVICE env var)
   */
  serviceName?: string;

  /**
   * Service revision (defaults to K_REVISION env var)
   */
  serviceRevision?: string;
}

/**
 * Google Cloud Logging sink
 * Outputs structured JSON logs that Cloud Run automatically ingests
 *
 * Format follows Google Cloud Logging special fields:
 * - severity: Log level
 * - message: Human-readable message
 * - logging.googleapis.com/trace: Trace ID for request correlation
 * - logging.googleapis.com/spanId: Span ID for distributed tracing
 * - logging.googleapis.com/sourceLocation: Source file location
 *
 * @see https://cloud.google.com/logging/docs/structured-logging
 */
export function getGCloudSink(options: GCloudSinkOptions = {}): Sink {
  const projectId = options.projectId || process.env.GCP_PROJECT_ID || process.env.GOOGLE_CLOUD_PROJECT;
  const serviceName = options.serviceName || process.env.K_SERVICE || "unknown";
  const serviceRevision = options.serviceRevision || process.env.K_REVISION || "unknown";

  return (record: LogRecord) => {
    const severity = severityMap[record.level] || "DEFAULT";
    const message = record.message.join(" ");
    const timestamp = new Date(record.timestamp).toISOString();

    // Build the structured log entry
    const logEntry: Record<string, unknown> = {
      severity,
      message,
      timestamp,
      "logging.googleapis.com/labels": {
        service: serviceName,
        revision: serviceRevision,
        category: record.category.join("."),
      },
    };

    // Add trace context if available (from request context)
    const traceId = record.properties?.traceId as string | undefined;
    const spanId = record.properties?.spanId as string | undefined;

    if (traceId && projectId) {
      logEntry["logging.googleapis.com/trace"] = `projects/${projectId}/traces/${traceId}`;
    }

    if (spanId) {
      logEntry["logging.googleapis.com/spanId"] = spanId;
    }

    // Add HTTP request info if available
    const httpRequest = record.properties?.httpRequest as Record<string, unknown> | undefined;
    if (httpRequest) {
      logEntry.httpRequest = httpRequest;
    }

    // Add all other properties as custom fields
    const customProps = { ...record.properties };
    delete customProps.traceId;
    delete customProps.spanId;
    delete customProps.httpRequest;

    if (Object.keys(customProps).length > 0) {
      Object.assign(logEntry, serializeObject(customProps));
    }

    // Add error details if present
    if (record.properties?.error instanceof Error) {
      const err = record.properties.error;
      logEntry["@type"] = "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";
      logEntry.stack_trace = err.stack;
    }

    // Output as single-line JSON (required by Cloud Logging)
    const output = JSON.stringify(logEntry);

    if (record.level === "error" || record.level === "fatal") {
      console.error(output);
    } else if (record.level === "warning") {
      console.warn(output);
    } else {
      console.log(output);
    }
  };
}
