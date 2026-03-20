import { SourceMapConsumer, type RawSourceMap } from "source-map";
import { loggers } from "../logging";

const logger = loggers.connector("error-mapper");

export interface MappedError {
  message: string;
  originalLine?: number;
  originalColumn?: number;
  originalSource?: string;
  stack?: string;
}

/**
 * Parse esbuild error output to extract line/column/message tuples.
 */
export function parseBuildErrors(errorOutput: string): Array<{
  line?: number;
  column?: number;
  message: string;
  severity: "error" | "warning";
}> {
  const errors: Array<{
    line?: number;
    column?: number;
    message: string;
    severity: "error" | "warning";
  }> = [];

  const lineRegex = /connector\.ts:(\d+):(\d+):\s*(error|warning):\s*(.*)/g;
  let match: RegExpExecArray | null;
  while ((match = lineRegex.exec(errorOutput)) !== null) {
    errors.push({
      line: parseInt(match[1], 10),
      column: parseInt(match[2], 10),
      message: match[4],
      severity: match[3] as "error" | "warning",
    });
  }

  // If no structured errors found, treat the whole output as a single error
  if (errors.length === 0 && errorOutput.trim()) {
    errors.push({
      message: errorOutput.trim(),
      severity: "error",
    });
  }

  return errors;
}

/**
 * Map a runtime error stack trace from the bundled code back to original source
 * using the stored source map.
 */
export async function mapRuntimeError(
  errorMessage: string,
  stackTrace: string | undefined,
  sourceMapJson: string | undefined,
): Promise<MappedError> {
  if (!sourceMapJson || !stackTrace) {
    return { message: errorMessage, stack: stackTrace };
  }

  try {
    const rawSourceMap: RawSourceMap = JSON.parse(sourceMapJson);
    const consumer = await new SourceMapConsumer(rawSourceMap);

    try {
      // Extract line numbers from the stack trace
      // Format: "at Object.<anonymous> (bundle.js:LINE:COL)"
      // or "at bundle.js:LINE:COL"
      const bundleLineRegex = /bundle\.js:(\d+):(\d+)/g;
      let mappedStack = stackTrace;
      let firstMappedLine: number | undefined;
      let firstMappedColumn: number | undefined;
      let firstMappedSource: string | undefined;

      let stackMatch: RegExpExecArray | null;
      while ((stackMatch = bundleLineRegex.exec(stackTrace)) !== null) {
        const bundleLine = parseInt(stackMatch[1], 10);
        const bundleColumn = parseInt(stackMatch[2], 10);

        const original = consumer.originalPositionFor({
          line: bundleLine,
          column: bundleColumn,
        });

        if (original.line !== null) {
          const source = original.source || "connector.ts";
          const mapped = `${source}:${original.line}:${original.column || 0}`;
          mappedStack = mappedStack.replace(stackMatch[0], mapped);

          if (firstMappedLine === undefined) {
            firstMappedLine = original.line;
            firstMappedColumn = original.column || undefined;
            firstMappedSource = source;
          }
        }
      }

      return {
        message: errorMessage,
        originalLine: firstMappedLine,
        originalColumn: firstMappedColumn,
        originalSource: firstMappedSource,
        stack: mappedStack,
      };
    } finally {
      consumer.destroy();
    }
  } catch (err) {
    logger.warn("Failed to map runtime error via source map", { error: err });
    return { message: errorMessage, stack: stackTrace };
  }
}
