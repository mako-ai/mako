/**
 * Offline chunked batch parity verifier (+ optional `--repair` healer).
 *
 * Promotion gate before advancing a domain/workspace from Stage 3
 * (`dual_write_shadow_compare`) to Stage 4 (`dual_write_pg_read`):
 * verifies existence parity and canonical field-level SHA-256 hash parity
 * across every record in MongoDB vs Postgres.
 */
import { getPgDirectDb, type MakoPgDb } from "../database/pg/client";
import { normalizeEntityId } from "../database/pg/id-codec";
import { loggers } from "../logging";
import { findTombstonedEntityIds } from "./backfill";
import { computeDiffPaths, type ShadowFieldDiff } from "./shadow-compare";
import type { MigrationDomain, ShadowCompareOptions } from "./types";

const logger = loggers.migration();

export interface VerifierMongoRecord {
  cursor: string;
  /** Canonical Postgres entity ID (lowercase UUID string or text PK). */
  entityId: string;
  /** Canonicalizable representation of the Mongo document. */
  record: unknown;
}

export interface VerifierDomainHandler {
  domain: MigrationDomain;
  targetTable: string;
  fetchMongoBatch(params: {
    afterCursor: string | null;
    limit: number;
    workspaceId: string | null;
  }): Promise<VerifierMongoRecord[]>;
  /** Fetch corresponding Postgres records keyed by canonical lowercase `entityId`. */
  fetchPgByIds(
    entityIds: string[],
    db: MakoPgDb,
  ): Promise<Map<string, unknown>>;
  /** Optional reverse check: return PG entity IDs present in Postgres that were not seen in Mongo. */
  findExtraPgIds?: (params: {
    workspaceId: string | null;
    seenEntityIds: ReadonlySet<string>;
    db: MakoPgDb;
  }) => Promise<string[]>;
  /** Optional idempotent repair handler invoked when `repair: true`. Returns count repaired. */
  repair?: (params: {
    entityIds: string[];
    workspaceId: string | null;
    db: MakoPgDb;
  }) => Promise<number>;
  compareOptions?: ShadowCompareOptions;
}

const verifierRegistry = new Map<string, VerifierDomainHandler>();

export function registerVerifierDomain(handler: VerifierDomainHandler): void {
  verifierRegistry.set(handler.domain, handler);
}

export function getVerifierDomain(
  domain: MigrationDomain,
): VerifierDomainHandler | undefined {
  return verifierRegistry.get(domain);
}

export function listVerifierDomains(): string[] {
  return [...verifierRegistry.keys()].sort();
}

export function clearVerifierRegistryForTests(): void {
  verifierRegistry.clear();
}

export interface ParityMismatchSample {
  entityId: string;
  kind: "missing_in_pg" | "mismatch" | "extra_in_pg";
  diffs?: ShadowFieldDiff[];
}

export interface ParityReport {
  domain: string;
  workspaceId: string | null;
  ok: boolean;
  checked: number;
  matched: number;
  skippedTombstone: number;
  missingInPg: number;
  mismatched: number;
  extraInPg: number;
  repaired: number;
  samples: ParityMismatchSample[];
  durationMs: number;
}

export interface RunParityVerificationOptions {
  domain: MigrationDomain;
  workspaceId?: string | null;
  batchSize?: number;
  repair?: boolean;
  maxSamples?: number;
  db?: MakoPgDb;
  handler?: VerifierDomainHandler;
}

export async function runParityVerification(
  options: RunParityVerificationOptions,
): Promise<ParityReport> {
  const handler = options.handler ?? getVerifierDomain(options.domain);
  if (!handler) {
    throw new Error(
      `No parity verifier registered for domain "${options.domain}". ` +
        `Registered domains: ${listVerifierDomains().join(", ") || "(none)"}`,
    );
  }

  const db = options.db ?? getPgDirectDb();
  const batchSize = Math.max(1, options.batchSize ?? 1000);
  const maxSamples = options.maxSamples ?? 50;
  const doRepair = options.repair ?? false;
  const workspaceId = options.workspaceId ?? null;

  const start = Date.now();
  let afterCursor: string | null = null;
  let checked = 0;
  let matched = 0;
  let skippedTombstone = 0;
  let missingInPg = 0;
  let mismatched = 0;
  let repaired = 0;
  const samples: ParityMismatchSample[] = [];
  const seenEntityIds = new Set<string>();

  while (true) {
    const batch = await handler.fetchMongoBatch({
      afterCursor,
      limit: batchSize,
      workspaceId,
    });
    if (batch.length === 0) break;

    const entityIds = batch.map(item => normalizeEntityId(item.entityId));
    const [tombstoned, pgMap] = await Promise.all([
      findTombstonedEntityIds(db, handler.targetTable, entityIds),
      handler.fetchPgByIds(entityIds, db),
    ]);

    const toRepair: string[] = [];

    for (const item of batch) {
      const normalizedId = normalizeEntityId(item.entityId);
      seenEntityIds.add(normalizedId);

      if (tombstoned.has(normalizedId)) {
        skippedTombstone += 1;
        continue;
      }

      checked += 1;
      if (!pgMap.has(normalizedId)) {
        missingInPg += 1;
        toRepair.push(normalizedId);
        if (samples.length < maxSamples) {
          samples.push({ entityId: normalizedId, kind: "missing_in_pg" });
        }
        continue;
      }

      const pgRecord = pgMap.get(normalizedId);
      const diff = computeDiffPaths(
        item.record,
        pgRecord,
        handler.compareOptions,
      );
      if (diff.equal) {
        matched += 1;
      } else {
        mismatched += 1;
        toRepair.push(normalizedId);
        if (samples.length < maxSamples) {
          samples.push({
            entityId: normalizedId,
            kind: "mismatch",
            diffs: diff.diffs,
          });
        }
      }
    }

    if (doRepair && toRepair.length > 0 && handler.repair) {
      repaired += await handler.repair({
        entityIds: toRepair,
        workspaceId,
        db,
      });
    }

    afterCursor = batch[batch.length - 1].cursor;
    if (batch.length < batchSize) break;
  }

  let extraInPg = 0;
  if (handler.findExtraPgIds) {
    const extras = await handler.findExtraPgIds({
      workspaceId,
      seenEntityIds,
      db,
    });
    extraInPg = extras.length;
    for (const extraId of extras) {
      if (samples.length >= maxSamples) break;
      samples.push({ entityId: extraId, kind: "extra_in_pg" });
    }
  }

  const durationMs = Date.now() - start;
  const ok = missingInPg === 0 && mismatched === 0 && extraInPg === 0;

  logger.info("Parity verification completed", {
    domain: options.domain,
    workspaceId,
    ok,
    checked,
    matched,
    skippedTombstone,
    missingInPg,
    mismatched,
    extraInPg,
    repaired,
    durationMs,
  });

  return {
    domain: options.domain,
    workspaceId,
    ok,
    checked,
    matched,
    skippedTombstone,
    missingInPg,
    mismatched,
    extraInPg,
    repaired,
    samples,
    durationMs,
  };
}
