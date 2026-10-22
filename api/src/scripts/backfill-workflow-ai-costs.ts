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
import { Workspace } from "../database/workspace-schema";
import {
  matchCallsToSteps,
  readStepWindows,
  readUnattributedCalls,
  saveMatches,
} from "../workflows/cost-backfill";
import { tenantOfToken } from "../workflows/hatchet";

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
  const since = new Date(Date.now() - args.days * 864e5);
  const workspaces = await Workspace.find({
    "workflows.hatchetToken": { $exists: true },
    ...(args.workspaceId ? { _id: args.workspaceId } : {}),
  })
    .select("name workflows.hatchetToken")
    .lean();
  console.log(
    `${args.dryRun ? "Dry run: " : ""}${workspaces.length} workspace(s), calls since ${since.toISOString()}`,
  );
  for (const workspace of workspaces) {
    const workspaceId = String(workspace._id);
    const calls = await readUnattributedCalls(workspaceId, since);
    if (calls.length === 0) continue;
    const tenant = tenantOfToken(workspace.workflows?.hatchetToken);
    if (!tenant) continue;
    let steps;
    try {
      steps = await readStepWindows(tenant, since);
    } catch (error) {
      console.log(
        `${workspace.name}: Hatchet did not answer (${String(error)})`,
      );
      continue;
    }
    const { matched, ambiguous, unmatched } = matchCallsToSteps(calls, steps);
    const cost = (ids: Set<string>) =>
      calls
        .filter(call => ids.has(call.id))
        .reduce((sum, call) => sum + call.costUsd, 0);
    const matchedIds = new Set(matched.map(m => m.call.id));
    const saved = args.dryRun ? 0 : await saveMatches(matched);
    console.log(
      [
        `${workspace.name} (${workspaceId}): ${calls.length} calls, ${steps.length} steps`,
        `  matched   ${matched.length} (${usd(cost(matchedIds))})${args.dryRun ? "" : `, saved ${saved}`}`,
        `  ambiguous ${ambiguous.length} (${usd(cost(new Set(ambiguous.map(c => c.id))))}): overlapping runs, left as they are`,
        `  unmatched ${unmatched.length} (${usd(cost(new Set(unmatched.map(c => c.id))))}): in no run's step`,
      ].join("\n"),
    );
  }
  await mongoose.disconnect();
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
