/* eslint-disable no-console, no-process-exit */
/**
 * Stripe Orphan Customer Cleanup
 *
 * Deletes Stripe Customers that were created but never used — these are
 * leftovers from the old behavior where opening the billing portal would
 * create a Customer even if the user never paid.
 *
 * A Customer is considered an orphan if ALL of the following are true:
 *   - no subscriptions (active, canceled, or past-due)
 *   - no default payment method and no sources
 *   - no invoices (list returns empty)
 *   - no payment methods attached
 *   - created more than 1 hour ago (don't race an in-flight checkout)
 *   - NOT currently referenced by any workspace.billing.stripeCustomerId
 *     (unless --skip-db-check is passed)
 *
 * Usage:
 *   pnpm exec tsx api/src/scripts/stripe-cleanup-orphans.ts            (dry-run against STRIPE_SECRET_KEY)
 *   pnpm exec tsx api/src/scripts/stripe-cleanup-orphans.ts --apply    (actually delete)
 *   pnpm exec tsx api/src/scripts/stripe-cleanup-orphans.ts --api-key=sk_live_xxx --apply
 *
 * Flags:
 *   --dry-run          (default) list orphans, do not delete
 *   --apply            actually delete orphans
 *   --api-key=<key>    override the Stripe secret key (otherwise STRIPE_SECRET_KEY env var)
 *   --min-age-hours=N  only consider customers older than N hours (default 1)
 *   --limit=N          stop after processing N customers (useful for sanity checks)
 *   --skip-db-check    skip the DATABASE_URL safety check (NOT recommended)
 */

import * as dotenv from "dotenv";
import * as path from "path";
// Load .env from the api package and the monorepo root (in that order of precedence).
dotenv.config();
dotenv.config({ path: path.resolve(__dirname, "../../../.env") });

import mongoose from "mongoose";
import Stripe from "stripe";
import { Workspace } from "../database/workspace-schema";

interface Args {
  apply: boolean;
  apiKey: string;
  minAgeHours: number;
  limit: number | null;
  skipDbCheck: boolean;
}

function parseArgs(): Args {
  const args: Args = {
    apply: false,
    apiKey: process.env.STRIPE_SECRET_KEY || "",
    minAgeHours: 1,
    limit: null,
    skipDbCheck: false,
  };

  for (const arg of process.argv.slice(2)) {
    if (arg === "--apply") {
      args.apply = true;
    } else if (arg === "--dry-run") {
      args.apply = false;
    } else if (arg === "--skip-db-check") {
      args.skipDbCheck = true;
    } else if (arg.startsWith("--api-key=")) {
      args.apiKey = arg.split("=")[1] || "";
    } else if (arg.startsWith("--min-age-hours=")) {
      args.minAgeHours = parseInt(arg.split("=")[1], 10);
      if (!Number.isFinite(args.minAgeHours) || args.minAgeHours < 0) {
        console.error("Invalid --min-age-hours");
        process.exit(1);
      }
    } else if (arg.startsWith("--limit=")) {
      const n = parseInt(arg.split("=")[1], 10);
      args.limit = Number.isFinite(n) && n > 0 ? n : null;
    } else {
      console.error(`Unknown argument: ${arg}`);
      process.exit(1);
    }
  }

  if (!args.apiKey) {
    console.error(
      "ERROR: No Stripe secret key. Set STRIPE_SECRET_KEY or pass --api-key=sk_...",
    );
    process.exit(1);
  }

  return args;
}

function keyMode(key: string): "test" | "live" | "unknown" {
  if (key.startsWith("sk_test_") || key.startsWith("rk_test_")) return "test";
  if (key.startsWith("sk_live_") || key.startsWith("rk_live_")) return "live";
  return "unknown";
}

interface OrphanDecision {
  isOrphan: boolean;
  reason: string;
}

async function evaluateCustomer(
  stripe: Stripe,
  customer: Stripe.Customer | Stripe.DeletedCustomer,
  minCreatedBefore: number,
  checkDb: boolean,
): Promise<OrphanDecision> {
  if (customer.deleted) {
    return { isOrphan: false, reason: "already deleted" };
  }

  const c = customer as Stripe.Customer;

  if (c.created > minCreatedBefore) {
    return { isOrphan: false, reason: "too recent (min age)" };
  }

  const subs = await stripe.subscriptions.list({
    customer: c.id,
    status: "all",
    limit: 1,
  });
  if (subs.data.length > 0) {
    return { isOrphan: false, reason: "has subscription(s)" };
  }

  const defaultPm = c.invoice_settings?.default_payment_method;
  if (defaultPm) {
    return { isOrphan: false, reason: "has default payment method" };
  }

  if (c.default_source) {
    return { isOrphan: false, reason: "has default source" };
  }

  const invoices = await stripe.invoices.list({ customer: c.id, limit: 1 });
  if (invoices.data.length > 0) {
    return { isOrphan: false, reason: "has invoice history" };
  }

  const paymentMethods = await stripe.paymentMethods.list({
    customer: c.id,
    limit: 1,
  });
  if (paymentMethods.data.length > 0) {
    return { isOrphan: false, reason: "has payment method attached" };
  }

  if (checkDb) {
    const ws = await Workspace.findOne({
      "billing.stripeCustomerId": c.id,
    }).select("_id");
    if (ws) {
      return {
        isOrphan: false,
        reason: `referenced by workspace ${ws._id.toString()}`,
      };
    }
  }

  return { isOrphan: true, reason: "no subs, no payment method, no invoices" };
}

async function main() {
  const args = parseArgs();
  const mode = keyMode(args.apiKey);

  console.log("=== Stripe Orphan Customer Cleanup ===");
  console.log(`  Mode:          ${mode}`);
  console.log(
    `  Apply:         ${args.apply ? "YES (will delete)" : "no (dry-run)"}`,
  );
  console.log(`  Min age hours: ${args.minAgeHours}`);
  console.log(`  DB check:      ${args.skipDbCheck ? "SKIPPED" : "enabled"}`);
  if (args.limit !== null) console.log(`  Limit:         ${args.limit}`);

  if (mode === "unknown") {
    console.error(
      "ERROR: API key does not look like a Stripe secret/restricted key.",
    );
    process.exit(1);
  }

  if (mode === "live" && args.apply) {
    console.log(
      "\n!! Running in LIVE mode with --apply. Deletions are permanent.",
    );
    console.log("!! Waiting 5 seconds — Ctrl+C to abort...");
    await new Promise(r => setTimeout(r, 5000));
  }

  if (!args.skipDbCheck) {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) {
      console.error(
        "ERROR: DATABASE_URL not set and --skip-db-check not passed. Refusing to run without the DB safety check.",
      );
      process.exit(1);
    }
    await mongoose.connect(databaseUrl);
    console.log("  Connected to MongoDB for DB-reference safety check");
  }

  const stripe = new Stripe(args.apiKey);

  const minCreatedBefore =
    Math.floor(Date.now() / 1000) - args.minAgeHours * 3600;

  let scanned = 0;
  let orphans = 0;
  let deleted = 0;
  let errors = 0;
  let skipped = 0;

  const pageSize = 100;
  let startingAfter: string | undefined;
  let done = false;

  while (!done) {
    const page = await stripe.customers.list({
      limit: pageSize,
      ...(startingAfter ? { starting_after: startingAfter } : {}),
    });

    for (const customer of page.data) {
      scanned++;

      if (args.limit !== null && scanned > args.limit) {
        done = true;
        break;
      }

      let decision: OrphanDecision;
      try {
        decision = await evaluateCustomer(
          stripe,
          customer,
          minCreatedBefore,
          !args.skipDbCheck,
        );
      } catch (err) {
        errors++;
        console.error(
          `  ERROR evaluating ${customer.id}:`,
          err instanceof Error ? err.message : err,
        );
        continue;
      }

      if (!decision.isOrphan) {
        skipped++;
        continue;
      }

      orphans++;
      const email = (customer as Stripe.Customer).email ?? "(no email)";
      const wsId =
        (customer as Stripe.Customer).metadata?.workspaceId ??
        "(no workspaceId)";
      const ageHours = ((Date.now() / 1000 - customer.created) / 3600).toFixed(
        1,
      );

      if (args.apply) {
        try {
          await stripe.customers.del(customer.id);
          deleted++;
          console.log(
            `  DELETED ${customer.id}  email=${email}  workspace=${wsId}  age=${ageHours}h`,
          );
        } catch (err) {
          errors++;
          console.error(
            `  ERROR deleting ${customer.id}:`,
            err instanceof Error ? err.message : err,
          );
        }
      } else {
        console.log(
          `  [DRY] would delete ${customer.id}  email=${email}  workspace=${wsId}  age=${ageHours}h`,
        );
      }
    }

    if (!done) {
      if (!page.has_more || page.data.length === 0) {
        done = true;
      } else {
        startingAfter = page.data[page.data.length - 1].id;
      }
    }
  }

  console.log("\n=== Summary ===");
  console.log(`  Scanned:  ${scanned}`);
  console.log(`  Orphans:  ${orphans}`);
  console.log(`  Deleted:  ${deleted}`);
  console.log(`  Kept:     ${skipped}`);
  console.log(`  Errors:   ${errors}`);
  if (!args.apply && orphans > 0) {
    console.log("\nRe-run with --apply to actually delete.");
  }

  if (mongoose.connection.readyState !== 0) {
    await mongoose.disconnect();
  }

  process.exit(errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error("Fatal error:", err);
  process.exit(1);
});
