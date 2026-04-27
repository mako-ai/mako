/* eslint-disable no-console */
import { type ProfilerOnRenderCallback, useEffect, useRef } from "react";

type DebugMetadata = Record<string, unknown>;

const DEBUG_PREFIX = "[render-debug]";
const MAX_CHANGED_KEYS_TO_LOG = 12;

export const renderDebugEnabled =
  import.meta.env.DEV && import.meta.env.VITE_RENDER_DEBUG === "true";

function summarizeDebugValue(value: unknown): unknown {
  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "function") {
    return `[function ${(value as { name?: string }).name || "anonymous"}]`;
  }

  if (Array.isArray(value)) {
    return `Array(${value.length})`;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    const previewKeys = ["id", "_id", "title", "kind", "role", "type", "name"];
    const preview = previewKeys.reduce<Record<string, unknown>>((acc, key) => {
      if (key in record) {
        acc[key] = record[key];
      }
      return acc;
    }, {});
    const constructorName = value.constructor?.name ?? "Object";

    return Object.keys(preview).length > 0
      ? `[${constructorName} ${JSON.stringify(preview)}]`
      : `[${constructorName}]`;
  }

  return String(value);
}

function summarizeDebugMetadata(metadata?: DebugMetadata): DebugMetadata {
  if (!metadata) return {};

  return Object.entries(metadata).reduce<DebugMetadata>((acc, [key, value]) => {
    if (
      key === "changes" &&
      value &&
      typeof value === "object" &&
      !Array.isArray(value)
    ) {
      acc[key] = Object.entries(
        value as Record<string, DebugMetadata>,
      ).reduce<DebugMetadata>((changeAcc, [changeKey, change]) => {
        changeAcc[changeKey] = {
          previous: summarizeDebugValue(change.previous),
          next: summarizeDebugValue(change.next),
        };
        return changeAcc;
      }, {});
      return acc;
    }

    acc[key] = summarizeDebugValue(value);
    return acc;
  }, {});
}

export function logRenderDebug(label: string, metadata?: DebugMetadata): void {
  if (!renderDebugEnabled) return;

  const summary = summarizeDebugMetadata(metadata);
  console.debug(`${DEBUG_PREFIX} ${label} ${JSON.stringify(summary)}`);
}

function useRenderCountEnabled(
  componentName: string,
  metadata?: DebugMetadata,
): void {
  const renderCountRef = useRef(0);
  renderCountRef.current += 1;

  useEffect(() => {
    logRenderDebug(`${componentName} render`, {
      count: renderCountRef.current,
      ...metadata,
    });
  });
}

function useRenderCountDisabled(): void {
  return;
}

export const useRenderCount: (
  componentName: string,
  metadata?: DebugMetadata,
) => void = renderDebugEnabled ? useRenderCountEnabled : useRenderCountDisabled;

function useWhyChangedEnabled(
  componentName: string,
  values: DebugMetadata,
): void {
  const previousValuesRef = useRef<DebugMetadata | undefined>();

  useEffect(() => {
    const previousValues = previousValuesRef.current;
    previousValuesRef.current = values;

    if (!previousValues) {
      logRenderDebug(`${componentName} mounted`, values);
      return;
    }

    const changedKeys = Object.keys(values).filter(
      key => !Object.is(previousValues[key], values[key]),
    );

    if (changedKeys.length === 0) return;

    const changes = changedKeys
      .slice(0, MAX_CHANGED_KEYS_TO_LOG)
      .reduce<
        Record<string, { previous: unknown; next: unknown }>
      >((acc, key) => {
        acc[key] = {
          previous: previousValues[key],
          next: values[key],
        };
        return acc;
      }, {});

    logRenderDebug(`${componentName} changed`, {
      changedKeys,
      changes,
      truncated: changedKeys.length > MAX_CHANGED_KEYS_TO_LOG,
    });
  });
}

function useWhyChangedDisabled(): void {
  return;
}

export const useWhyChanged: (
  componentName: string,
  values: DebugMetadata,
) => void = renderDebugEnabled ? useWhyChangedEnabled : useWhyChangedDisabled;

const handleProfilerRenderDebug: ProfilerOnRenderCallback = (
  id,
  phase,
  actualDuration,
  baseDuration,
  startTime,
  commitTime,
) => {
  logRenderDebug(`profiler ${id}`, {
    phase,
    actualDuration: Number(actualDuration.toFixed(2)),
    baseDuration: Number(baseDuration.toFixed(2)),
    startTime: Number(startTime.toFixed(2)),
    commitTime: Number(commitTime.toFixed(2)),
  });
};

const noopProfilerRenderDebug: ProfilerOnRenderCallback = () => {
  return;
};

export const onRenderDebug: ProfilerOnRenderCallback = renderDebugEnabled
  ? handleProfilerRenderDebug
  : noopProfilerRenderDebug;
