/* eslint-disable no-console */
import type { Sink, LogRecord } from "@logtape/logtape";

/**
 * ANSI color codes for terminal output
 */
const colors = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
  green: "\x1b[32m",
  blue: "\x1b[34m",
  white: "\x1b[37m",
} as const;

const levelColors: Record<string, string> = {
  debug: colors.dim,
  info: colors.cyan,
  warning: colors.yellow,
  error: colors.red,
  fatal: colors.magenta,
};

const levelIcons: Record<string, string> = {
  debug: "○",
  info: "●",
  warning: "▲",
  error: "✖",
  fatal: "☠",
};

/**
 * Formats a value for pretty printing with proper indentation
 */
function formatValue(value: unknown, indent: number = 0): string {
  const pad = "  ".repeat(indent);

  if (value === null) return `${colors.dim}null${colors.reset}`;
  if (value === undefined) return `${colors.dim}undefined${colors.reset}`;

  if (typeof value === "string") {
    // Truncate long strings
    if (value.length > 200) {
      return `${colors.green}"${value.slice(0, 200)}..."${colors.reset}`;
    }
    return `${colors.green}"${value}"${colors.reset}`;
  }

  if (typeof value === "number") {
    return `${colors.yellow}${value}${colors.reset}`;
  }

  if (typeof value === "boolean") {
    return `${colors.magenta}${value}${colors.reset}`;
  }

  if (value instanceof Date) {
    return `${colors.cyan}${value.toISOString()}${colors.reset}`;
  }

  if (value instanceof Error) {
    const lines = [`${colors.red}Error: ${value.message}${colors.reset}`];
    if (value.stack) {
      const stackLines = value.stack.split("\n").slice(1, 6);
      lines.push(
        ...stackLines.map(
          l => `${pad}  ${colors.dim}${l.trim()}${colors.reset}`,
        ),
      );
    }
    return lines.join("\n");
  }

  // Handle error-like objects (e.g., serialized errors, errors from different contexts)
  if (
    typeof value === "object" &&
    value !== null &&
    "message" in value &&
    typeof (value as Record<string, unknown>).message === "string"
  ) {
    const errorLike = value as Record<string, unknown>;
    // Check if this looks like an error (has message and optionally stack/name)
    if (
      errorLike.stack !== undefined ||
      errorLike.name !== undefined ||
      (Object.keys(errorLike).length <= 3 &&
        Object.keys(errorLike).every(k =>
          ["message", "stack", "name", "code"].includes(k),
        ))
    ) {
      const lines = [
        `${colors.red}${errorLike.name || "Error"}: ${errorLike.message}${colors.reset}`,
      ];
      if (typeof errorLike.stack === "string") {
        const stackLines = errorLike.stack.split("\n").slice(1, 6);
        lines.push(
          ...stackLines.map(
            l => `${pad}  ${colors.dim}${l.trim()}${colors.reset}`,
          ),
        );
      }
      return lines.join("\n");
    }
  }

  if (Array.isArray(value)) {
    if (value.length === 0) return "[]";
    if (value.length > 10) {
      const items = value.slice(0, 10).map(v => formatValue(v, indent + 1));
      return `[\n${pad}  ${items.join(`,\n${pad}  `)}\n${pad}  ${colors.dim}... ${value.length - 10} more${colors.reset}\n${pad}]`;
    }
    const items = value.map(v => formatValue(v, indent + 1));
    if (items.join(", ").length < 80) {
      return `[${items.join(", ")}]`;
    }
    return `[\n${pad}  ${items.join(`,\n${pad}  `)}\n${pad}]`;
  }

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 0) return "{}";

    const formatted = entries
      .slice(0, 20)
      .map(
        ([k, v]) =>
          `${pad}  ${colors.blue}${k}${colors.reset}: ${formatValue(v, indent + 1)}`,
      );

    if (entries.length > 20) {
      formatted.push(
        `${pad}  ${colors.dim}... ${entries.length - 20} more fields${colors.reset}`,
      );
    }

    return `{\n${formatted.join(",\n")}\n${pad}}`;
  }

  return String(value);
}

/**
 * HTTP-only context fields that should be filtered from non-HTTP logs
 * Note: Correlation fields (requestId, traceId, spanId) are kept on all logs
 * to enable trace correlation across services and log aggregation
 */
const httpOnlyFields = new Set([
  "method", // HTTP method (GET, POST, etc.)
  "path", // Request path
  "startTime", // Request start timestamp
  "httpRequest", // Full HTTP request object
]);

/**
 * Filters properties based on log category
 * - HTTP logs: show all properties
 * - Non-HTTP logs: filter out HTTP context fields that bleed from request context
 */
function filterProperties(
  props: Record<string, unknown>,
  category: readonly string[],
): Record<string, unknown> {
  const isHttpCategory = category[0] === "http";

  if (isHttpCategory) {
    return props;
  }

  // For non-HTTP categories, filter out HTTP-only fields (keep requestId, traceId, spanId for correlation)
  const filtered: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(props)) {
    if (!httpOnlyFields.has(key) && value !== undefined && value !== null) {
      filtered[key] = value;
    }
  }
  return filtered;
}

/**
 * Pretty console sink for local development
 * Outputs colorized, human-readable logs with structured data
 */
export function getPrettyConsoleSink(): Sink {
  return (record: LogRecord) => {
    const timestamp = new Date(record.timestamp);
    const timeStr = timestamp.toLocaleTimeString("en-US", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    const msStr = timestamp.getMilliseconds().toString().padStart(3, "0");

    const level = record.level;
    const levelColor = levelColors[level] || colors.white;
    const levelIcon = levelIcons[level] || "•";
    const levelStr = level.toUpperCase().padEnd(5);

    const category = record.category.join(".");
    const message = record.message.join(" ");

    // Build the main log line
    const logLine = [
      `${colors.dim}${timeStr}.${msStr}${colors.reset}`,
      `${levelColor}${levelIcon} ${levelStr}${colors.reset}`,
      `${colors.dim}[${category}]${colors.reset}`,
      message,
    ].join(" ");

    // Output main line
    if (level === "error" || level === "fatal") {
      console.error(logLine);
    } else if (level === "warning") {
      console.warn(logLine);
    } else {
      console.log(logLine);
    }

    // Output properties if present (excluding internal fields and HTTP context for non-HTTP logs)
    const props = filterProperties({ ...record.properties }, record.category);

    if (Object.keys(props).length > 0) {
      const formatted = formatValue(props, 1);
      console.log(`  ${colors.dim}→${colors.reset} ${formatted}`);
    }
  };
}
