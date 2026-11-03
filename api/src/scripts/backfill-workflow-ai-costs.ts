/* eslint-disable no-console, no-process-exit */
/**
 * Backfill workflow AI costs: model calls recorded before Mako kept the run
 * and step they came from are matched to them by time (workflows/
 * cost-backfill.ts). Calls in two overlapping runs are left as they are.
 *
 * Usage:
 *   pnpm --filter api exec tsx src/scripts/backfill-workflow-ai-costs.ts \
 *     [--workspace-id=X] [--days=30] [--dry-run]
 *
 * Requires DATABASE_URL (and ENCRYPTION_KEY to read the Hatchet tokens).
 */
import * as dotenv from "dotenv";
dotenv.config({ quiet: true });

import mongoose from "mongoose";
import { backfillWorkflowCosts } from "../workflows/cost-backfill";

function parseArgs() {
  const args = {
    workspaceId: undefined as string | undefined,
    days: 30,
    dryRun: false,
  };
  for (const arg of process.argv.slice(2)) {
    if (arg === "--dry-run") args.dryRun = true;
    else if (arg.startsWith("--workspace-id="))
      args.workspaceId = arg.split("=")[1];
    else if (arg.startsWith("--days=")) args.days = Number(arg.split("=")[1]);
    else throw new Error(`Unknown argument ${arg}`);
  }
  if (!Number.isFinite(args.days) || args.days < 1)
    throw new Error("--days must be ≥ 1");
  return args;
}

const usd = (n: number) => `$${n.toFixed(2)}`;

async function main() {
  const args = parseArgs();
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  await mongoose.connect(process.env.DATABASE_URL);
  const reports = await backfillWorkflowCosts(args);
  console.log(
    `${args.dryRun ? "Dry run: " : ""}${reports.length} workspace(s)`,
  );
  for (const r of reports) {
    console.log(
      [
        `${r.workspace} (${r.workspaceId}): ${r.calls} calls, ${r.steps} steps`,
        ...(r.error ? [`  ${r.error}`] : []),
        `  matched   ${r.matched.calls} (${usd(r.matched.costUsd)})${args.dryRun ? "" : `, saved ${r.saved}`}`,
        `  ambiguous ${r.ambiguous.calls} (${usd(r.ambiguous.costUsd)}): overlapping runs, left as they are`,
        `  unmatched ${r.unmatched.calls} (${usd(r.unmatched.costUsd)}): in no run's step`,
      ].join("\n"),
    );
  }
  await mongoose.disconnect();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
