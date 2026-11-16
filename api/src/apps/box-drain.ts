/**
 * Drain: kill the Mako session boxes left in the OLD E2B account at the end
 * of the workspace move (docs/runbooks/e2b-workspace-migration.md).
 *
 * Killing is the one irreversible step, so two guards decide which account
 * this is before anything dies:
 * 1. The key's sha256 must equal the hash recorded for the old key in the
 *    runbook's step 2. A wrong key (the new project's) aborts.
 * 2. No Mako session box in the listed account may have started after the
 *    swap. One that did means either this is the account Mako now uses, or
 *    traffic still reaches the old one; both abort.
 * Only boxes of the Mako template that carry `makoAppsSessionKey` are ever
 * touched, so Aura's boxes in the same account are not candidates and do
 * not count against guard 2 (they keep starting after the swap by design).
 *
 * Box operations come in as a parameter so the guards are tested without E2B;
 * scripts/e2b-drain-old-boxes.ts wires the real ones.
 */
import { createHash } from "node:crypto";

export interface DrainBox {
  sandboxId: string;
  state: "running" | "paused";
  startedAt: Date;
  sessionKey?: string;
}

export interface DrainOps {
  /** The template's boxes in the key's account, every state. */
  listBoxes(): Promise<DrainBox[]>;
  kill(sandboxId: string): Promise<void>;
}

export interface DrainOptions {
  apiKey: string;
  expectKeySha256: string;
  swapTime: Date;
  apply: boolean;
  /**
   * Session keys the pre-save dry run classed `foreign-origin` (preview and
   * laptop boxes). Neither counted by the swap-time guard nor killed.
   */
  ignoreSessionKeys?: Set<string>;
}

export interface DrainReport {
  aborted?: string;
  candidates: number;
  /** Boxes skipped because their session was classed foreign-origin. */
  ignored: number;
  startedAfterSwap: string[];
  killed: string[];
  failed: Array<{ sandboxId: string; error: string }>;
}

/**
 * Session keys of `foreign-origin` rows in a pre-save dry run's JSON lines.
 * Unparseable lines are skipped: the report also holds a header and totals.
 */
export function foreignOriginSessionKeys(jsonl: string): Set<string> {
  const keys = new Set<string>();
  for (const line of jsonl.split("\n")) {
    try {
      const row = JSON.parse(line) as { action?: string; sessionKey?: string };
      if (row.action === "foreign-origin" && row.sessionKey) {
        keys.add(row.sessionKey);
      }
    } catch {
      // not a row
    }
  }
  return keys;
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function drainOldBoxes(
  ops: DrainOps,
  options: DrainOptions,
): Promise<DrainReport> {
  const report: DrainReport = {
    candidates: 0,
    ignored: 0,
    startedAfterSwap: [],
    killed: [],
    failed: [],
  };
  const expected = options.expectKeySha256.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return { ...report, aborted: "expected key hash is not a sha256 hex" };
  }
  if (sha256Hex(options.apiKey.trim()) !== expected) {
    return {
      ...report,
      aborted: "E2B_API_KEY does not match the recorded old-key hash",
    };
  }
  if (Number.isNaN(options.swapTime.getTime())) {
    return { ...report, aborted: "swap time is not a valid date" };
  }

  const ignore = options.ignoreSessionKeys ?? new Set<string>();
  const listed = (await ops.listBoxes()).filter(b => b.sessionKey);
  const boxes = listed.filter(b => !ignore.has(b.sessionKey ?? ""));
  report.ignored = listed.length - boxes.length;
  report.candidates = boxes.length;
  report.startedAfterSwap = boxes
    .filter(b => b.startedAt.getTime() > options.swapTime.getTime())
    .map(b => b.sandboxId);
  if (report.startedAfterSwap.length > 0) {
    return {
      ...report,
      aborted: `${report.startedAfterSwap.length} Mako box(es) started after the swap`,
    };
  }
  if (!options.apply) return report;

  for (const box of boxes) {
    try {
      await ops.kill(box.sandboxId);
      report.killed.push(box.sandboxId);
    } catch (error) {
      report.failed.push({
        sandboxId: box.sandboxId,
        error: (error instanceof Error ? error.message : String(error)).slice(
          0,
          200,
        ),
      });
    }
  }
  return report;
}
