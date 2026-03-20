import { SourceMapConsumer, type RawSourceMap } from "source-map";

export interface MappedRuntimeError {
  message: string;
  originalLine?: number;
  originalColumn?: number;
  originalSource?: string;
  stack?: string;
}

function extractBundlePositions(
  text: string,
): Array<{ line: number; column: number }> {
  const matches = text.matchAll(/bundle\.js:(\d+):(\d+)/g);
  return Array.from(matches, match => ({
    line: Number.parseInt(match[1], 10),
    column: Number.parseInt(match[2], 10),
  }));
}

export async function mapRuntimeError(
  errorMessage: string,
  sourceMapJson?: string,
): Promise<MappedRuntimeError> {
  if (!sourceMapJson) {
    return { message: errorMessage, stack: errorMessage };
  }

  const positions = extractBundlePositions(errorMessage);
  if (positions.length === 0) {
    return { message: errorMessage, stack: errorMessage };
  }

  const rawSourceMap = JSON.parse(sourceMapJson) as RawSourceMap;
  const consumer = await new SourceMapConsumer(rawSourceMap);

  try {
    let mappedStack = errorMessage;
    let firstMapped:
      | {
          line?: number;
          column?: number;
          source?: string;
        }
      | undefined;

    for (const position of positions) {
      const original = consumer.originalPositionFor(position);
      if (original.line == null) {
        continue;
      }

      const mappedLocation = `${original.source || "index.ts"}:${original.line}:${original.column || 0}`;
      mappedStack = mappedStack.replace(
        `bundle.js:${position.line}:${position.column}`,
        mappedLocation,
      );

      if (!firstMapped) {
        firstMapped = {
          line: original.line,
          column: original.column ?? undefined,
          source: original.source ?? "index.ts",
        };
      }
    }

    return {
      message: errorMessage,
      originalLine: firstMapped?.line,
      originalColumn: firstMapped?.column,
      originalSource: firstMapped?.source,
      stack: mappedStack,
    };
  } finally {
    consumer.destroy();
  }
}
