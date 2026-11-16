/* eslint-disable no-console, no-process-exit */
/**
 * Give ownerless app rows their real owner (apps/app-row-owners.ts has the
 * rules). Run BEFORE turning APPS_ROW_OWNER_PERSON_IDS on.
 *
 *   pnpm --filter api exec tsx src/scripts/backfill-app-row-owners.ts            # dry run
 *   pnpm --filter api exec tsx src/scripts/backfill-app-row-owners.ts --apply    # write
 *   --workspace <id>   only that workspace
 *
 * Environment (process only; no .env file is loaded):
 *   DATABASE_URL                            Mongo.
 *   GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY   to clone each workspace repo (rule b).
 *   APPS_GIT_ROOT                           an empty scratch dir for those clones.
 *
 * The dry run writes nothing to Mongo. Both modes clone workspace repos into
 * APPS_GIT_ROOT. Output: counts per rule, then one line per row with app id,
 * path, the owner's first 6 id characters and the rule. No emails.
 */
import mongoose from "mongoose";

interface Args {
  apply: boolean;
  workspace?: string;
}

export function parseBackfillArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--workspace") args.workspace = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (args.workspace !== undefined && !/^[0-9a-f]{24}$/i.test(args.workspace)) {
    throw new Error("--workspace needs a 24-hex workspace id");
  }
  return args;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const args = parseBackfillArgs(process.argv.slice(2));
  requireEnv("APPS_GIT_ROOT");
  await mongoose.connect(requireEnv("DATABASE_URL"));
  const {
    applyOwnerProposals,
    findOwnerlessRows,
    formatOwnerReport,
    proposeOwner,
    workspaceOwnerSources,
  } = await import("../apps/app-row-owners");
  const { boundRepoDirIfExists } =
    await import("../apps/workspace-repo-required");

  const rows = await findOwnerlessRows(args.workspace);
  const byWorkspace = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byWorkspace.get(row.workspaceId) ?? [];
    list.push(row);
    byWorkspace.set(row.workspaceId, list);
  }
  const proposals = [];
  for (const [workspaceId, list] of byWorkspace) {
    let repoDir: string | null = null;
    try {
      repoDir = await boundRepoDirIfExists(workspaceId);
    } catch (error) {
      console.error(
        `workspace ${workspaceId}: repo unavailable (${(error as Error).message.slice(0, 200)})`,
      );
    }
    const sources = await workspaceOwnerSources(workspaceId, repoDir);
    for (const row of list) proposals.push(await proposeOwner(row, sources));
  }

  console.log(args.apply ? "MODE: apply" : "MODE: dry run (no writes)");
  console.log(formatOwnerReport(proposals));
  if (args.apply) {
    const changed = await applyOwnerProposals(proposals);
    console.log(`\nrows updated: ${changed}`);
  }
  await mongoose.disconnect();
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
