/* eslint-disable no-console */
import type { Sink, LogRecord } from "@logtape/logtape";

/**
 * Standard severity levels for structured logging
 * Compatible with most log aggregators (CloudWatch, Datadog, ELK, Splunk, GCP, etc.)
 */
const severityMap: Record<string, string> = {
  debug: "DEBUG",
  info: "INFO",
  warning: "WARNING",
  error: "ERROR",
  fatal: "CRITICAL",
};

/**
 * Checks if a value is an error-like object (has message, optionally stack/name)
 */
function isErrorLike(
  value: unknown,
): value is { message: string; name?: string; stack?: string; code?: string } {
  if (typeof value !== "object" || value === null) return false;
  const obj = value as Record<string, unknown>;
  if (typeof obj.message !== "string") return false;
  // Must have at least one error-specific property or be a minimal object
  return (
    obj.stack !== undefined ||
    obj.name !== undefined ||
    (Object.keys(obj).length <= 4 &&
      Object.keys(obj).every(k =>
        ["message", "stack", "name", "code"].includes(k),
      ))
  );
}

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

  // Handle error-like objects (serialized errors, errors from different contexts)
  if (isErrorLike(value)) {
    return {
      name: value.name || "Error",
      message: value.message,
      stack: value.stack,
      ...(value.code ? { code: value.code } : {}),
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
function serializeObject(
  obj: Record<string, unknown>,
): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(obj)) {
    if (value === undefined) continue;

    if (
      value !== null &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      !(value instanceof Error) &&
      !(value instanceof Date)
    ) {
      result[key] = serializeObject(value as Record<string, unknown>);
    } else if (Array.isArray(value)) {
      result[key] = value.map(v =>
        v !== null && typeof v === "object"
          ? serializeObject(v as Record<string, unknown>)
          : serializeValue(v),
      );
    } else {
      result[key] = serializeValue(value);
    }
  }

  return result;
}

export interface JsonSinkOptions {
  /**
   * Project ID for trace correlation (used by GCP, optional for other platforms)
   */
  projectId?: string;

  /**
   * Service name for log identification
   * Defaults to K_SERVICE (Cloud Run), SERVICE_NAME, or "unknown"
   */
  serviceName?: string;

  /**
   * Service revision/version for log identification
   * Defaults to K_REVISION (Cloud Run), SERVICE_VERSION, or "unknown"
   */
  serviceRevision?: string;
}

/**
 * Structured JSON logging sink for production environments
 *
 * Outputs single-line JSON logs compatible with most log aggregators:
 * - AWS CloudWatch
 * - Google Cloud Logging
 * - Datadog
 * - Elasticsearch/ELK
 * - Splunk
 * - Azure Monitor
 * - Any JSON-compatible log system
 *
 * When running on GCP (detected via env vars), adds Google-specific fields
 * for enhanced trace correlation. Otherwise outputs standard JSON.
 */
export function getJsonSink(options: JsonSinkOptions = {}): Sink {
  const projectId =
    options.projectId ||
    process.env.GCP_PROJECT_ID ||
    process.env.GOOGLE_CLOUD_PROJECT;
  const serviceName =
    options.serviceName ||
    process.env.K_SERVICE ||
    process.env.SERVICE_NAME ||
    "mako-api";
  const serviceRevision =
    options.serviceRevision ||
    process.env.K_REVISION ||
    process.env.SERVICE_VERSION ||
    "dev";
  const environment = process.env.NODE_ENV || "development";

  // Detect if we're running on GCP (add Google-specific fields)
  const isGCP = !!(process.env.K_SERVICE || process.env.GOOGLE_CLOUD_PROJECT);

  return (record: LogRecord) => {
    const severity = severityMap[record.level] || "DEFAULT";
    const message = record.message.join(" ");
    const timestamp = new Date(record.timestamp).toISOString();

    // Build the structured log entry (platform-agnostic base)
    const logEntry: Record<string, unknown> = {
      severity,
      message,
      timestamp,
      service: serviceName,
      version: serviceRevision,
      env: environment,
      category: record.category.join("."),
    };

    // Add trace context if available (from request context)
    const traceId = record.properties?.traceId as string | undefined;
    const spanId = record.properties?.spanId as string | undefined;

    if (traceId) {
      logEntry.traceId = traceId;
      // Add GCP-specific trace format when on Google Cloud
      if (isGCP && projectId) {
        logEntry["logging.googleapis.com/trace"] =
          `projects/${projectId}/traces/${traceId}`;
      }
    }

    if (spanId) {
      logEntry.spanId = spanId;
      if (isGCP) {
        logEntry["logging.googleapis.com/spanId"] = spanId;
      }
    }

    // Add GCP-specific labels when on Google Cloud
    if (isGCP) {
      logEntry["logging.googleapis.com/labels"] = {
        service: serviceName,
        revision: serviceRevision,
        category: record.category.join("."),
      };
    }

    // Add HTTP request info if available
    const httpRequest = record.properties?.httpRequest as
      | Record<string, unknown>
      | undefined;
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

    // Add error details if present (handles both Error instances and error-like objects)
    const errorProp = record.properties?.error;
    if (errorProp instanceof Error || isErrorLike(errorProp)) {
      const err = errorProp as {
        name?: string;
        message: string;
        stack?: string;
      };
      // GCP-specific error reporting type
      if (isGCP) {
        logEntry["@type"] =
          "type.googleapis.com/google.devtools.clouderrorreporting.v1beta1.ReportedErrorEvent";
      }
      if (err.stack) {
        logEntry.stack_trace = err.stack;
      }
      logEntry.error = {
        name: err.name || "Error",
        message: err.message,
      };
    }

    // Output as single-line JSON (works with all log aggregators)
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
