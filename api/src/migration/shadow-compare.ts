/**
 * Non-blocking shadow-read diffing, canonicalization, PII/secret redaction, and OTel metrics.
 *
 * Guarantees:
 *   - Zero latency impact on primary reads (shadow execution is detached behind a semaphore).
 *   - Bounded concurrency (`maxInflight`, default 16); excess comparisons drop cleanly with a metric.
 *   - Strict redaction of credentials, password/token hashes, encrypted blobs, and message bodies:
 *     logs contain only field paths and SHA-256 digests, never plaintext secrets or PII.
 */
import { createHash } from "node:crypto";
import { metrics } from "@opentelemetry/api";
import { loggers } from "../logging";
import type { ShadowCompareOptions } from "./types";

const diffLogger = loggers.db("migration-diff");

const meter = metrics.getMeter("mako.migration");
const shadowCounter = meter.createCounter("mako_migration_shadow_total", {
  description: "Shadow-compare outcomes (match, mismatch, error, dropped)",
});
const shadowDroppedCounter = meter.createCounter(
  "mako_migration_shadow_dropped_total",
  {
    description: "Shadow-compare reads dropped due to concurrency cap",
  },
);
const writeErrorCounter = meter.createCounter(
  "mako_migration_write_error_total",
  {
    description: "Dual-write secondary store failures and timeouts",
  },
);
const readLatencyHistogram = meter.createHistogram("mako_migration_read_ms", {
  description: "Read latency per migration domain and backing store",
  unit: "ms",
});

/** Sensitive keys whose raw values must NEVER be emitted into shadow-diff logs. */
export const DEFAULT_REDACTED_KEYS: ReadonlySet<string> = new Set([
  "hashedPassword",
  "hashed_password",
  "password",
  "passwordHash",
  "password_hash",
  "passwordEncrypted",
  "password_encrypted",
  "keyHash",
  "key_hash",
  "tokenHash",
  "token_hash",
  "accessToken",
  "access_token",
  "accessTokenHash",
  "access_token_hash",
  "refreshToken",
  "refresh_token",
  "refreshTokenHash",
  "refresh_token_hash",
  "code",
  "codeHash",
  "code_hash",
  "challenge",
  "codeChallenge",
  "code_challenge",
  "codeVerifier",
  "code_verifier",
  "hatchetToken",
  "hatchet_token",
  "privateKey",
  "private_key",
  "valueEncrypted",
  "value_encrypted",
  "urlEncrypted",
  "url_encrypted",
  "signingSecretEncrypted",
  "signing_secret_encrypted",
  "webhookUrlEncrypted",
  "webhook_url_encrypted",
  "secret",
  "token",
  "webhooks",
  "messages",
  "parts",
  "content",
  "turnCheckpoint",
  "turn_checkpoint",
  "systemPrompt",
  "system_prompt",
  "workspacePrompt",
  "workspace_prompt",
  "config",
  "connection",
  "headers",
  "oauthTokens",
  "oauth_tokens",
  "clientInformation",
  "client_information",
  "rawPayload",
  "raw_payload",
  "email",
]);

export interface ShadowFieldDiff {
  path: string;
  primaryHash: string;
  shadowHash: string;
  redacted: boolean;
}

export interface DiffResult {
  equal: boolean;
  diffs: ShadowFieldDiff[];
  primaryHash: string;
  shadowHash: string;
}

export interface ShadowCompareEvent {
  domain: string;
  operation: string;
  entityId?: string;
  workspaceId?: string;
  result: "match" | "mismatch" | "error" | "dropped";
  diffs: ShadowFieldDiff[];
  primaryDurationMs?: number;
  shadowDurationMs?: number;
  errorMessage?: string;
}

export function recordReadLatency(
  domain: string,
  store: "mongo" | "pg",
  durationMs: number,
): void {
  readLatencyHistogram.record(durationMs, { domain, store });
}

export function recordWriteError(
  domain: string,
  store: "mongo" | "pg",
  operation: string,
): void {
  writeErrorCounter.add(1, { domain, store, operation });
}

function isObjectIdLike(value: unknown): value is { toHexString(): string } {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { toHexString?: unknown }).toHexString === "function"
  );
}

/**
 * Recursively normalize a value into deterministic JSON-compatible structure so
 * benign storage differences (key order, Date vs ISO string, ObjectId vs hex,
 * omitted vs null fields) do not produce false-positive parity alerts.
 */
export function canonicalizeForDiff(
  value: unknown,
  options: Pick<ShadowCompareOptions, "treatNullAsUndefined"> = {},
): unknown {
  const treatNullAsUndefined = options.treatNullAsUndefined ?? true;

  if (value === undefined) {
    return treatNullAsUndefined ? null : undefined;
  }
  if (value === null) {
    return null;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "bigint") {
    return value.toString();
  }
  if (value instanceof Uint8Array || Buffer.isBuffer(value)) {
    return Buffer.from(value).toString("base64");
  }
  if (isObjectIdLike(value)) {
    return value.toHexString().toLowerCase();
  }
  if (Array.isArray(value)) {
    return value.map(item => canonicalizeForDiff(item, options));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    const keys = Object.keys(value as Record<string, unknown>).sort();
    for (const key of keys) {
      const raw = (value as Record<string, unknown>)[key];
      if (raw === undefined) continue;
      const normalized = canonicalizeForDiff(raw, options);
      if (treatNullAsUndefined && normalized === null) continue;
      out[key] = normalized;
    }
    return out;
  }
  return value;
}

export function canonicalHash(
  value: unknown,
  options?: Pick<ShadowCompareOptions, "treatNullAsUndefined">,
): string {
  const canonical = canonicalizeForDiff(value, options);
  const serialized = JSON.stringify(canonical) ?? "null";
  return createHash("sha256").update(serialized).digest("hex");
}

function hashCanonicalAlready(value: unknown): string {
  const serialized = JSON.stringify(value) ?? "null";
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numbersEqualWithinEpsilon(
  a: number,
  b: number,
  epsilon: number,
): boolean {
  if (Number.isNaN(a) && Number.isNaN(b)) return true;
  if (a === b) return true;
  return Math.abs(a - b) <= epsilon;
}

function isPathRedacted(
  dottedPath: string,
  redactedKeys: ReadonlySet<string>,
): boolean {
  const segments = dottedPath.split(/[.[\]]+/).filter(Boolean);
  return segments.some(seg => redactedKeys.has(seg));
}

/**
 * Compare two records after canonicalization and return field-level diff paths
 * with SHA-256 digests (zero plaintext values leaked).
 */
export function computeDiffPaths(
  primaryValue: unknown,
  shadowValue: unknown,
  options: ShadowCompareOptions = {},
): DiffResult {
  const floatEpsilon = options.floatEpsilon ?? 1e-8;
  const maxDiffs = options.maxDiffs ?? 25;
  const redactedKeys = options.redactKeys
    ? new Set<string>([...DEFAULT_REDACTED_KEYS, ...options.redactKeys])
    : DEFAULT_REDACTED_KEYS;

  const left = canonicalizeForDiff(primaryValue, options);
  const right = canonicalizeForDiff(shadowValue, options);
  const diffs: ShadowFieldDiff[] = [];

  function valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    if (
      typeof a === "number" &&
      typeof b === "number" &&
      numbersEqualWithinEpsilon(a, b, floatEpsilon)
    ) {
      return true;
    }
    if (Array.isArray(a) && Array.isArray(b)) {
      if (a.length !== b.length) return false;
      for (let i = 0; i < a.length; i++) {
        if (!valuesEqual(a[i], b[i])) return false;
      }
      return true;
    }
    if (isPlainObject(a) && isPlainObject(b)) {
      const aKeys = Object.keys(a);
      const bKeys = Object.keys(b);
      if (aKeys.length !== bKeys.length) return false;
      for (const key of aKeys) {
        if (!(key in b) || !valuesEqual(a[key], b[key])) return false;
      }
      return true;
    }
    return false;
  }

  function walk(a: unknown, b: unknown, currentPath: string): void {
    if (diffs.length >= maxDiffs) return;

    if (a === b) return;
    if (
      typeof a === "number" &&
      typeof b === "number" &&
      numbersEqualWithinEpsilon(a, b, floatEpsilon)
    ) {
      return;
    }

    // Collapse redacted subtrees at the first redacted path segment so nested
    // map key names (e.g. headers.*, webhooks.*) never leak into diffs[].path
    // and multi-element redacted payloads cannot exhaust maxDiffs.
    if (currentPath && isPathRedacted(currentPath, redactedKeys)) {
      if (!valuesEqual(a, b)) {
        diffs.push({
          path: currentPath,
          primaryHash: hashCanonicalAlready(a),
          shadowHash: hashCanonicalAlready(b),
          redacted: true,
        });
      }
      return;
    }

    if (Array.isArray(a) && Array.isArray(b)) {
      const len = Math.max(a.length, b.length);
      for (let i = 0; i < len; i++) {
        if (diffs.length >= maxDiffs) return;
        walk(a[i], b[i], `${currentPath}[${i}]`);
      }
      return;
    }

    if (isPlainObject(a) && isPlainObject(b)) {
      const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
      for (const key of [...keys].sort()) {
        if (diffs.length >= maxDiffs) return;
        const nextPath = currentPath ? `${currentPath}.${key}` : key;
        walk(a[key], b[key], nextPath);
      }
      return;
    }

    const pathLabel = currentPath || "$";
    diffs.push({
      path: pathLabel,
      primaryHash: hashCanonicalAlready(a),
      shadowHash: hashCanonicalAlready(b),
      redacted: isPathRedacted(pathLabel, redactedKeys),
    });
  }

  walk(left, right, "");

  return {
    equal: diffs.length === 0,
    diffs,
    primaryHash: createHash("sha256")
      .update(JSON.stringify(left) ?? "null")
      .digest("hex"),
    shadowHash: createHash("sha256")
      .update(JSON.stringify(right) ?? "null")
      .digest("hex"),
  };
}

export interface ShadowScheduleInput<T> {
  domain: string;
  operation: string;
  entityId?: string;
  workspaceId?: string;
  primaryStore: "mongo" | "pg";
  primaryResult: T;
  primaryDurationMs?: number;
  readShadow: () => Promise<T>;
  canonicalize?: (value: T) => unknown;
  options?: ShadowCompareOptions;
}

export interface ShadowCompareRunnerConfig {
  maxInflight?: number;
  onEvent?: (event: ShadowCompareEvent) => void;
}

/**
 * Executes shadow reads off the user request's critical path with a hard
 * concurrency cap so slow shadow storage can never exhaust memory or DB pools.
 */
export class ShadowCompareRunner {
  private readonly maxInflight: number;
  private readonly onEvent?: (event: ShadowCompareEvent) => void;
  private inflight = 0;
  private readonly activeTasks = new Set<Promise<void>>();

  constructor(config: ShadowCompareRunnerConfig = {}) {
    this.maxInflight = config.maxInflight ?? 16;
    this.onEvent = config.onEvent;
  }

  get inflightCount(): number {
    return this.inflight;
  }

  private emitEvent(event: ShadowCompareEvent): void {
    if (!this.onEvent) return;
    try {
      this.onEvent(event);
    } catch (callbackError) {
      diffLogger.warn("Shadow-compare onEvent callback threw", {
        domain: event.domain,
        operation: event.operation,
        error:
          callbackError instanceof Error
            ? callbackError.message
            : String(callbackError),
      });
    }
  }

  /**
   * Schedule a background shadow comparison. Returns `false` if dropped due to
   * concurrency saturation, `true` if accepted.
   */
  schedule<T>(input: ShadowScheduleInput<T>): boolean {
    if (this.inflight >= this.maxInflight) {
      shadowDroppedCounter.add(1, {
        domain: input.domain,
        operation: input.operation,
      });
      shadowCounter.add(1, {
        domain: input.domain,
        operation: input.operation,
        result: "dropped",
      });
      this.emitEvent({
        domain: input.domain,
        operation: input.operation,
        entityId: input.entityId,
        workspaceId: input.workspaceId,
        result: "dropped",
        diffs: [],
      });
      return false;
    }

    this.inflight += 1;
    const shadowStore = input.primaryStore === "mongo" ? "pg" : "mongo";

    const task = (async () => {
      const start = performance.now();
      try {
        const shadowResult = await input.readShadow();
        const shadowDurationMs = performance.now() - start;
        recordReadLatency(input.domain, shadowStore, shadowDurationMs);

        const primaryComparable = input.canonicalize
          ? input.canonicalize(input.primaryResult)
          : input.primaryResult;
        const shadowComparable = input.canonicalize
          ? input.canonicalize(shadowResult)
          : shadowResult;

        const diff = computeDiffPaths(
          primaryComparable,
          shadowComparable,
          input.options,
        );

        const resultKind = diff.equal ? "match" : "mismatch";
        shadowCounter.add(1, {
          domain: input.domain,
          operation: input.operation,
          result: resultKind,
        });

        if (!diff.equal) {
          diffLogger.warn("Shadow-read parity mismatch", {
            domain: input.domain,
            operation: input.operation,
            entityId: input.entityId,
            workspaceId: input.workspaceId,
            primaryStore: input.primaryStore,
            shadowStore,
            diffCount: diff.diffs.length,
            diffs: diff.diffs,
            primaryDurationMs: input.primaryDurationMs,
            shadowDurationMs,
          });
        }

        this.emitEvent({
          domain: input.domain,
          operation: input.operation,
          entityId: input.entityId,
          workspaceId: input.workspaceId,
          result: resultKind,
          diffs: diff.diffs,
          primaryDurationMs: input.primaryDurationMs,
          shadowDurationMs,
        });
      } catch (error) {
        const shadowDurationMs = performance.now() - start;
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        shadowCounter.add(1, {
          domain: input.domain,
          operation: input.operation,
          result: "error",
        });
        diffLogger.warn("Shadow-read failed", {
          domain: input.domain,
          operation: input.operation,
          entityId: input.entityId,
          workspaceId: input.workspaceId,
          shadowStore,
          errorMessage,
          shadowDurationMs,
        });
        this.emitEvent({
          domain: input.domain,
          operation: input.operation,
          entityId: input.entityId,
          workspaceId: input.workspaceId,
          result: "error",
          diffs: [],
          primaryDurationMs: input.primaryDurationMs,
          shadowDurationMs,
          errorMessage,
        });
      } finally {
        this.inflight -= 1;
      }
    })();

    this.activeTasks.add(task);
    void task
      .catch(() => undefined)
      .finally(() => {
        this.activeTasks.delete(task);
      });
    return true;
  }

  /** Wait for all currently in-flight background shadow comparisons to settle (used in tests/shutdown). */
  async flush(): Promise<void> {
    while (this.activeTasks.size > 0) {
      await Promise.allSettled([...this.activeTasks]);
    }
  }
}

export const shadowCompareRunner = new ShadowCompareRunner();
