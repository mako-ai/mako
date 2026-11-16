/* eslint-disable no-console, no-process-exit */
/**
 * Kill the Mako session boxes left in the OLD E2B account (runbook step 12).
 * See apps/box-drain.ts for the guards.
 *
 *   pnpm --filter api exec tsx src/scripts/e2b-drain-old-boxes.ts \
 *     --expect-key-sha256 "$OLD_KEY_SHA256" --swap-time "$SWAP_TIME"          # dry run
 *   ... --apply                                                               # kill
 *   --ignore-foreign-from presave-dry.jsonl   skip sessions the pre-save dry
 *                                             run classed foreign-origin
 *
 * Environment (process only; no .env file is loaded):
 *   E2B_API_KEY         the OLD account's key.
 *   APPS_E2B_TEMPLATE   the session template there (default mako-apps).
 *
 * Exit 0: done (or nothing to do). Exit 2: a guard aborted, nothing killed.
 * The dry run doubles as the runbook's drain gate: it prints how many Mako
 * boxes started after the swap, which must be 0.
 */
import { Sandbox } from "e2b";
import fs from "node:fs";
import {
  drainOldBoxes,
  foreignOriginSessionKeys,
  type DrainBox,
} from "../apps/box-drain";

interface Args {
  apply: boolean;
  expectKeySha256?: string;
  swapTime?: string;
  ignoreFrom?: string;
}

export function parseDrainArgs(argv: string[]): Args {
  const args: Args = { apply: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--expect-key-sha256") args.expectKeySha256 = argv[++i];
    else if (arg === "--swap-time") args.swapTime = argv[++i];
    else if (arg === "--ignore-foreign-from") args.ignoreFrom = argv[++i];
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!args.expectKeySha256) throw new Error("--expect-key-sha256 is required");
  if (!args.swapTime) throw new Error("--swap-time is required");
  return args;
}

async function main(): Promise<void> {
  const args = parseDrainArgs(process.argv.slice(2));
  const apiKey = process.env.E2B_API_KEY?.trim();
  if (!apiKey) throw new Error("E2B_API_KEY is not set");
  const template = process.env.APPS_E2B_TEMPLATE?.trim() || "mako-apps";

  const report = await drainOldBoxes(
    {
      async listBoxes() {
        const boxes: DrainBox[] = [];
        const paginator = Sandbox.list({
          apiKey,
          query: { template, state: ["running", "paused"] },
          limit: 100,
        });
        while (paginator.hasNext) {
          for (const info of await paginator.nextItems()) {
            boxes.push({
              sandboxId: info.sandboxId,
              state: info.state,
              startedAt: new Date(info.startedAt),
              sessionKey: info.metadata?.makoAppsSessionKey,
            });
          }
        }
        return boxes;
      },
      async kill(sandboxId) {
        await Sandbox.kill(sandboxId, { apiKey });
      },
    },
    {
      apiKey,
      expectKeySha256: args.expectKeySha256 ?? "",
      swapTime: new Date(args.swapTime ?? ""),
      apply: args.apply,
      ignoreSessionKeys: args.ignoreFrom
        ? foreignOriginSessionKeys(fs.readFileSync(args.ignoreFrom, "utf8"))
        : undefined,
    },
  );
  console.log(
    JSON.stringify({
      mode: args.apply ? "apply" : "dry-run",
      template,
      ...report,
    }),
  );
  if (report.aborted) process.exitCode = 2;
  else if (report.failed.length > 0) process.exitCode = 1;
}

if (require.main === module) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
