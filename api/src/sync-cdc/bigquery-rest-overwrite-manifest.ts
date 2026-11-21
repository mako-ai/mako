import { createHash } from "node:crypto";
import type { ClientSession, Connection } from "mongoose";
import type { FetchState } from "../connectors/base/BaseConnector";
import {
  markRestBigQueryTruncateSettled,
  readRestBigQueryTruncateReceipt,
} from "./bigquery-rest-overwrite-intent";
import { hasCapturedRestBigQueryInput } from "./bigquery-rest-overwrite-snapshot";
import {
  readBigQueryRestOverwriteWrites,
  stagedWriteFingerprint,
} from "./bigquery-staged-intent";
import { stableStringify } from "./normalization";
import {
  readVerifiedRestEntityOverwrite,
  recordVerifiedRestEntityOverwrite,
  releaseVerifiedRestEntityOverwrite,
  type RestEntityOverwriteReservation,
} from "./rest-entity-admission";

interface RestOverwriteManifest {
  reservation: RestEntityOverwriteReservation;
  sourceRows: number;
  replacementFingerprints: string[];
  fetchState?: FetchState;
}

const settlementTransaction = {
  readConcern: { level: "snapshot" as const },
  writeConcern: { w: "majority" as const },
};

/** Verify the warehouse receipts against a complete, sealed source manifest. */
export async function verifyRestBigQueryOverwriteManifest(
  connection: Connection,
  { reservation, sourceRows, replacementFingerprints }: RestOverwriteManifest,
  session?: ClientSession,
): Promise<boolean> {
  const expected = new Set(replacementFingerprints);
  if (
    expected.size !== replacementFingerprints.length ||
    !Number.isSafeInteger(sourceRows) ||
    sourceRows < 0
  ) {
    return false;
  }
  const truncate = await readRestBigQueryTruncateReceipt(
    connection,
    reservation,
    session,
  );
  if (!truncate) return false;
  const replacements = await readBigQueryRestOverwriteWrites(
    reservation,
    session,
  );
  if (replacements.length !== expected.size) return false;

  const overwrite = stableStringify(reservation.overwrite);
  const batches: { start: number; end: number }[] = [];
  for (const { intent, fingerprint, terminal } of replacements) {
    const binding = intent.restOverwrite;
    if (
      !binding ||
      stableStringify(binding.overwrite) !== overwrite ||
      !expected.delete(fingerprint) ||
      fingerprint !== stagedWriteFingerprint(intent) ||
      intent.destination.project !== truncate.target.projectId ||
      intent.destination.dataset !== truncate.target.dataset ||
      intent.destination.table !== truncate.target.table ||
      intent.job.location !== truncate.target.location ||
      !terminal ||
      !("fingerprint" in terminal) ||
      terminal.fingerprint !== fingerprint ||
      terminal.state !== "DONE" ||
      terminal.outcome !== "succeeded" ||
      terminal.affectedRows !== binding.expectedRows ||
      !Number.isSafeInteger(binding.expectedRows) ||
      binding.expectedRows <= 0 ||
      !Number.isSafeInteger(binding.sourceRowsBefore) ||
      binding.sourceRowsBefore < 0
    ) {
      return false;
    }
    if (
      !(await hasCapturedRestBigQueryInput(
        connection,
        reservation,
        {
          input: intent.input,
          sourceRowsBefore: binding.sourceRowsBefore,
          expectedRows: binding.expectedRows,
        },
        session,
      ))
    ) {
      return false;
    }
    batches.push({
      start: binding.sourceRowsBefore,
      end: binding.sourceRowsBefore + binding.expectedRows,
    });
  }

  // A retried range can match the total while leaving another range missing.
  let written = 0;
  for (const { start, end } of batches.sort((a, b) => a.start - b.start)) {
    if (start !== written || end > sourceRows) return false;
    written = end;
  }
  return expected.size === 0 && written === sourceRows;
}

function manifestHash({
  sourceRows,
  replacementFingerprints,
}: RestOverwriteManifest) {
  return createHash("sha256")
    .update(stableStringify([sourceRows, [...replacementFingerprints].sort()]))
    .digest("hex");
}

/** Freeze replacement registration after verifying the manifest and receipts. */
export function sealRestBigQueryOverwriteManifest(
  connection: Connection,
  manifest: RestOverwriteManifest,
): Promise<boolean> {
  const { reservation, sourceRows, fetchState } = manifest;
  if (
    fetchState &&
    (fetchState.hasMore || fetchState.totalProcessed !== sourceRows)
  ) {
    return Promise.resolve(false);
  }
  const snapshot = {
    reservation,
    sourceRows,
    replacementFingerprints: [...manifest.replacementFingerprints],
  };
  const fingerprint = manifestHash(snapshot);
  return connection.transaction(async session => {
    const valid = await verifyRestBigQueryOverwriteManifest(
      connection,
      snapshot,
      session,
    );
    return (
      valid &&
      (await recordVerifiedRestEntityOverwrite(
        connection,
        reservation,
        fingerprint,
        session,
        fetchState,
      ))
    );
  }, settlementTransaction);
}

/** Release only the overwrite whose exact manifest was durably verified. */
export function settleRestBigQueryOverwriteManifest(
  connection: Connection,
  manifest: RestOverwriteManifest,
  completeCheckpoint?: (session: ClientSession) => Promise<void>,
): Promise<boolean> {
  const { reservation } = manifest;
  const fingerprint = manifestHash(manifest);
  return connection.transaction(async session => {
    const result = await releaseVerifiedRestEntityOverwrite(
      connection,
      reservation,
      fingerprint,
      session,
    );
    if (!result) return false;
    if (result === "released") await completeCheckpoint?.(session);
    await markRestBigQueryTruncateSettled(connection, reservation, session);
    return true;
  }, settlementTransaction);
}

/** Read sealed completion without releasing the reservation. */
export async function readVerifiedRestBigQueryOverwriteManifest(
  connection: Connection,
  reservation: RestEntityOverwriteReservation,
): Promise<RestOverwriteManifest | undefined> {
  if (!(await readRestBigQueryTruncateReceipt(connection, reservation))) {
    return undefined;
  }
  const writes = await readBigQueryRestOverwriteWrites(reservation);
  let sourceRows = 0;
  for (const { intent, terminal, fingerprint } of writes) {
    if (
      !terminal ||
      !("fingerprint" in terminal) ||
      terminal.fingerprint !== fingerprint ||
      terminal.state !== "DONE" ||
      terminal.outcome !== "succeeded" ||
      !intent.restOverwrite ||
      terminal.affectedRows !== intent.restOverwrite.expectedRows ||
      !Number.isSafeInteger(terminal.affectedRows) ||
      terminal.affectedRows <= 0
    ) {
      return undefined;
    }
    sourceRows += terminal.affectedRows;
  }
  if (!Number.isSafeInteger(sourceRows)) return undefined;
  const manifest = {
    reservation,
    sourceRows,
    replacementFingerprints: writes.map(write => write.fingerprint),
  };
  const verified = await readVerifiedRestEntityOverwrite(
    connection,
    reservation,
    manifestHash(manifest),
  );
  if (!verified) return undefined;
  return verified.fetchState
    ? { ...manifest, fetchState: verified.fetchState }
    : manifest;
}
