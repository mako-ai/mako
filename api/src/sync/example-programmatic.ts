#!/usr/bin/env ts-node
/* eslint-disable no-console */

/**
 * Example: Programmatic usage of the sync functionality
 *
 * This example shows how to integrate the sync functionality
 * into your own scripts or automation workflows.
 */

import { spawn } from "child_process";
import * as path from "path";

// Configuration for different sync scenarios
const syncScenarios = [
  {
    name: "Daily Customer Sync",
    source: "stripe-prod",
    destination: "analytics-db",
    entity: "customers",
    incremental: true,
  },
  {
    name: "Weekly Full Product Sync",
    source: "stripe-prod",
    destination: "analytics-db",
    entity: "products",
    incremental: false,
  },
  {
    name: "Hourly Leads Update",
    source: "close-crm",
    destination: "reporting-db",
    entity: "leads",
    incremental: true,
  },
];

/**
 * Execute a sync command
 */
async function executeSync(scenario: (typeof syncScenarios)[0]): Promise<void> {
  console.log(`\n🔄 Starting ${scenario.name}...`);
  console.log(`   Source: ${scenario.source}`);
  console.log(`   Destination: ${scenario.destination}`);
  console.log(`   Entity: ${scenario.entity}`);
  console.log(`   Mode: ${scenario.incremental ? "Incremental" : "Full"}`);

  return new Promise((resolve, reject) => {
    const args = [
      "run",
      "sync",
      "--",
      scenario.source,
      scenario.destination,
      scenario.entity,
    ];

    if (scenario.incremental) {
      args.push("--incremental");
    }

    const syncProcess = spawn("pnpm", args, {
      cwd: path.resolve(__dirname, ".."),
      stdio: "inherit", // This will show the sync output in real-time
    });

    syncProcess.on("close", code => {
      if (code === 0) {
        console.log(`✅ ${scenario.name} completed successfully`);
        resolve();
      } else {
        console.error(`❌ ${scenario.name} failed with exit code ${code}`);
        reject(new Error(`Sync failed with exit code ${code}`));
      }
    });

    syncProcess.on("error", error => {
      console.error(`❌ Failed to start sync process: ${error.message}`);
      reject(error);
    });
  });
}

/**
 * Execute multiple syncs with error handling
 */
async function runSyncWorkflow() {
  console.log("🚀 Starting automated sync workflow\n");

  for (const scenario of syncScenarios) {
    try {
      await executeSync(scenario);
      // Add delay between syncs to avoid overwhelming the sources
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (error) {
      console.error(`Failed to execute ${scenario.name}:`, error);
      // Continue with other syncs even if one fails
    }
  }

  console.log("\n✅ Sync workflow completed");
}

/**
 * Example: Schedule syncs using cron-like functionality
 */
function scheduleSyncs() {
  console.log("📅 Sync Scheduler Example (not actually running)\n");

  console.log("Example cron configurations:");
  console.log("  - Customer sync: Every day at 2 AM");
  console.log(
    "    0 2 * * * pnpm run sync stripe-prod analytics-db customers --incremental",
  );
  console.log("");
  console.log("  - Full product sync: Every Sunday at 3 AM");
  console.log("    0 3 * * 0 pnpm run sync stripe-prod analytics-db products");
  console.log("");
  console.log("  - Leads sync: Every hour");
  console.log(
    "    0 * * * * pnpm run sync close-crm reporting-db leads --incremental",
  );
  console.log("");
  console.log(
    "Use these with your system's cron or a Node.js scheduler like node-cron",
  );
}

/**
 * Example: Error handling and notifications
 */
async function syncWithNotifications() {
  console.log("\n🔔 Sync with notifications example\n");

  try {
    // Simulate a sync
    console.log("Starting sync...");

    // In a real scenario, you would:
    // 1. Execute the sync
    // 2. Capture the output
    // 3. Parse for errors or warnings
    // 4. Send notifications (email, Slack, etc.)

    console.log("Example notification points:");
    console.log("  - On sync start: Send 'Sync started' notification");
    console.log("  - On sync success: Send summary with record counts");
    console.log("  - On sync failure: Send error details and logs");
    console.log("  - On warnings: Send warning summary");
  } catch (error) {
    console.error("Sync failed:", error);
    // Send failure notification
  }
}

// Main execution
if (require.main === module) {
  console.log("🎯 Programmatic Sync Examples\n");
  console.log(
    "This script demonstrates various ways to use the sync tool programmatically.",
  );
  console.log(
    "Note: These are examples only and won't actually run syncs without proper setup.\n",
  );

  // Show scheduling example
  scheduleSyncs();

  // Show notification example
  void syncWithNotifications();

  console.log("\n💡 To run actual syncs programmatically:");
  console.log("1. Ensure DATABASE_URL and ENCRYPTION_KEY are set");
  console.log("2. Configure data sources in your application");
  console.log("3. Uncomment the runSyncWorkflow() call below");
  console.log("4. Run: ts-node sync/example-programmatic.ts");

  // Uncomment to run actual syncs:
  // runSyncWorkflow().catch(console.error);
}

export { executeSync, runSyncWorkflow };
