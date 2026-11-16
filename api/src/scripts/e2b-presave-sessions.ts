/* eslint-disable no-console, no-process-exit */
/**
 * Pre-save every Mako session box in ONE E2B account onto rescue refs. See
 * apps/box-presave.ts for what it writes and never writes, and
 * docs/runbooks/e2b-workspace-migration.md for when to run it (the dry run
 * before the swap, --apply only after the old revision has drained).
 *
 *   pnpm --filter api exec tsx src/scripts/e2b-presave-sessions.ts            # dry run
 *   pnpm --filter api exec tsx src/scripts/e2b-presave-sessions.ts --include-running --apply
 *
 * Flags:
 *   --apply             push rescue refs. Without it nothing is written.
 *   --include-running   also visit running boxes.
 *   --only <key>        one session key (`<workspaceId>:<userId>`); repeatable.
 *   --limit <n>         stop after n visited boxes.
 *
 * Environment (read from the process only; no .env file is loaded):
 *   E2B_API_KEY           key of the account whose boxes are visited.
 *   APPS_E2B_TEMPLATE     template the session boxes run (default mako-apps).
 *   APPS_GIT_ORIGIN_URL   https://app.mako.ai. Required with --apply; a box
 *                         whose origin is not under it is never touched.
 * With --apply, also:
 *   DATABASE_URL          Mako's Mongo, read to resolve each user's identity.
 *   SESSION_SECRET        signs the box's fresh git token; must match production.
 *
 * A dry run still resumes each paused box for a few seconds to read its git
 * status, then pauses it again. Nothing it prints is a secret.
 */
import fs from "node:fs";
import path from "node:path";
import mongoose from "mongoose";
import { Sandbox } from "e2b";
import {
  presaveSessions,
  dryRunInspect,
  rescueBox,
  scrub,
  type ListedBox,
  type PresaveOps,
} from "../apps/box-presave";
import type { BoxRun } from "../apps/box/rescue-commit";
import {
  e2bSandboxProvider,
  pinE2bSession,
  useE2bPinnedSessionsOnly,
} from "../apps/sandbox/e2b-provider";

export const PRODUCTION_ORIGIN = "https://app.mako.ai";

interface Args {
  apply: boolean;
  includeRunning: boolean;
  only: string[];
  limit?: number;
}

export function parseArgs(argv: string[]): Args {
  const args: Args = { apply: false, includeRunning: false, only: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") args.apply = true;
    else if (arg === "--include-running") args.includeRunning = true;
    else if (arg === "--only") {
      const value = argv[++i];
      if (!value) throw new Error("--only needs a session key");
      args.only.push(value);
    } else if (arg === "--limit") {
      const value = Number(argv[++i]);
      if (!Number.isInteger(value) || value < 1) {
        throw new Error("--limit needs a positive integer");
      }
      args.limit = value;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return args;
}

/**
 * The git origin --apply may push to, or why it must not run.
 *
 * appsGitOriginBase() falls back to a dev tunnel URL from `../.env.tunnel`
 * outside production, so a laptop with `pnpm dev` running could otherwise
 * re-point production boxes at the tunnel. Require the production origin
 * explicitly, confirm the resolver agrees, and refuse while a tunnel file
 * exists at all.
 */
export function checkApplyOrigin(input: {
  env: NodeJS.ProcessEnv;
  resolvedBase: () => string;
  tunnelFiles: string[];
  exists: (file: string) => boolean;
}): string {
  const wanted = input.env.APPS_GIT_ORIGIN_URL?.trim().replace(/\/+$/, "");
  if (wanted !== PRODUCTION_ORIGIN) {
    throw new Error(
      `--apply needs APPS_GIT_ORIGIN_URL=${PRODUCTION_ORIGIN} exported explicitly`,
    );
  }
  for (const file of input.tunnelFiles) {
    if (input.exists(file)) {
      throw new Error(
        `Refusing --apply while a dev tunnel file exists (${file}); remove it or run from a clean checkout`,
      );
    }
  }
  const resolved = input.resolvedBase();
  if (resolved !== PRODUCTION_ORIGIN) {
    throw new Error(
      `The git origin resolves to ${resolved}, not ${PRODUCTION_ORIGIN}`,
    );
  }
  return resolved;
}

function requireEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if ((process.env.APPS_SANDBOX_PROVIDER ?? "e2b") !== "e2b") {
    throw new Error("APPS_SANDBOX_PROVIDER must be e2b (or unset)");
  }
  const apiKey = requireEnv("E2B_API_KEY");
  const template = process.env.APPS_E2B_TEMPLATE?.trim() || "mako-apps";
  let originBase =
    process.env.APPS_GIT_ORIGIN_URL?.trim().replace(/\/+$/, "") ||
    PRODUCTION_ORIGIN;
  if (args.apply) {
    const { appsGitOriginBase } = await import("../apps/config");
    originBase = checkApplyOrigin({
      env: process.env,
      resolvedBase: appsGitOriginBase,
      tunnelFiles: [
        path.join(process.cwd(), "..", ".env.tunnel"),
        path.resolve(__dirname, "../../../.env.tunnel"),
      ],
      exists: file => fs.existsSync(file),
    });
    requireEnv("SESSION_SECRET");
    await mongoose.connect(requireEnv("DATABASE_URL"), {
      serverSelectionTimeoutMS: 15_000,
    });
  }

  // Never list-and-repair, never create, never kill: each session reaches
  // only the box this script pinned for it.
  useE2bPinnedSessionsOnly();

  // Loaded after the provider is pinned: these pull in the rest of apps/.
  const { configureBoxRemote } = await import("../apps/box");
  const { resolveActorIdentity } = await import("../apps/worktree.service");

  const ctxFor = (box: ListedBox) => ({ sessionKey: box.sessionKey });
  // box/rescue-commit.ts runs shell through a BoxRun; this one reaches the
  // pinned box only (pinned-only mode above).
  const runIn =
    (box: ListedBox): BoxRun =>
    async (command, options) =>
      e2bSandboxProvider.exec(ctxFor(box), command, {
        timeoutMs: options?.timeoutMs ?? 120_000,
      });

  const ops: PresaveOps = {
    async listBoxes() {
      const boxes: ListedBox[] = [];
      const paginator = Sandbox.list({
        apiKey,
        query: {
          template,
          state: args.includeRunning ? ["running", "paused"] : ["paused"],
        },
        limit: 100,
      });
      while (paginator.hasNext) {
        for (const info of await paginator.nextItems()) {
          const sessionKey = info.metadata?.makoAppsSessionKey;
          if (!sessionKey) continue;
          boxes.push({
            sandboxId: info.sandboxId,
            sessionKey,
            state: info.state,
          });
        }
      }
      return boxes;
    },
    async open(box) {
      pinE2bSession(box.sessionKey, box.sandboxId);
      const probe = await e2bSandboxProvider.exec(ctxFor(box), "true", {
        timeoutMs: 30_000,
      });
      if (probe.exitCode !== 0) throw new Error("the box did not answer");
    },
    async inspect(box) {
      const ctx = ctxFor(box);
      return dryRunInspect(runIn(box), e2bSandboxProvider.root(ctx));
    },
    async rescue(box, plan) {
      const ctx = ctxFor(box);
      const author = await resolveActorIdentity(plan.userId);
      return rescueBox(runIn(box), {
        root: e2bSandboxProvider.root(ctx),
        userId: plan.userId,
        now: plan.now,
        author,
        expectedOrigin: plan.expectedOrigin,
        message: `Save uncommitted work before the E2B workspace move (${plan.now.toISOString().slice(0, 10)})`,
        // A paused box's git token is long expired (12h); mint a fresh one,
        // exactly as ensureBox does for a box that wakes up. rescueBox calls
        // this only after the origin was checked to be the production URL,
        // so it rewrites the same URL and only refreshes the credential.
        prepareRemote: () =>
          configureBoxRemote({
            ctx,
            workspaceId: plan.workspaceId,
            userId: plan.userId,
            author,
          }),
      });
    },
    async pause(box) {
      await Sandbox.pause(box.sandboxId, { apiKey });
    },
  };

  console.log(
    JSON.stringify({
      mode: args.apply ? "apply" : "dry-run",
      template,
      originBase,
      includeRunning: args.includeRunning,
    }),
  );
  const { totals } = await presaveSessions(ops, {
    apply: args.apply,
    originBase,
    includeRunning: args.includeRunning,
    only: args.only,
    limit: args.limit,
    onRow: row => console.log(JSON.stringify(row)),
  });
  console.log(JSON.stringify({ totals }));
  if (args.apply) await mongoose.disconnect();
  if (totals.error > 0 || totals.manual > 0) process.exitCode = 2;
}

if (require.main === module) {
  void main().catch(error => {
    // The message only: a stack or an error object could carry a request
    // with credentials in it.
    console.error(
      scrub(error instanceof Error ? error.message : String(error)),
    );
    process.exit(1);
  });
}
