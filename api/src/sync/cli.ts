/* eslint-disable no-process-exit */
import { Command } from "commander";
import inquirer from "inquirer";
import { getDestinationManager } from "./destination-manager";
import { performSync } from "./sync-orchestrator";
import { databaseDataSourceManager } from "./database-data-source-manager";
import { syncConnectorRegistry } from "./connector-registry";
import { SyncLogger } from "../connectors/base/BaseConnector";

// Create a console logger adapter that implements the SyncLogger interface
const consoleLogger: SyncLogger = {
  log: (level: string, message: string, ...args: any[]) => {
    const prefix = `[${level.toUpperCase()}]`;
    switch (level) {
      case "debug":
        console.debug(prefix, message, ...args);
        break;
      case "info":
        console.info(message, ...args);
        break;
      case "warn":
        console.warn(prefix, message, ...args);
        break;
      case "error":
        console.error(prefix, message, ...args);
        break;
      default:
        console.log(prefix, message, ...args);
    }
  },
};

async function runSync(
  sourceId: string,
  destinationId: string,
  destinationDatabaseName: string | undefined,
  entities: string[] | undefined,
  isIncremental: boolean = false,
) {
  try {
    console.log(`[DEBUG] runSync called with isIncremental: ${isIncremental}`);
    console.log(
      `[DEBUG] runSync called with entities: ${entities?.join(", ") || "all"}`,
    );

    // Using proper logger adapter for CLI tool
    await performSync(
      sourceId,
      destinationId,
      destinationDatabaseName,
      entities,
      isIncremental,
      consoleLogger,
    );

    // Give a moment for cleanup and explicitly exit
    console.log("🎉 Sync completed successfully!");
    setTimeout(() => {
      process.exit(0);
    }, 1000);
  } catch (error) {
    console.error("\n❌ Sync failed:", error);
    process.exit(1);
  }
}

// Interactive mode functions
async function interactiveMode() {
  console.log("🚀 Welcome to the Interactive Data Sync Tool\n");

  try {
    // Get available workspaces
    process.stdout.write("⏳ Fetching workspaces...");
    const workspaces = await getDestinationManager().listWorkspaces();
    process.stdout.write("\r" + " ".repeat(50) + "\r");
    if (workspaces.length === 0) {
      console.error("❌ No workspaces found!");
      console.log("Please create a workspace in your application first.");
      process.exit(1);
    }

    // Prompt for workspace
    const workspaceChoices = workspaces.map(w => ({
      name: w.name,
      value: w.id,
      short: w.name,
    }));

    const { workspaceId } = await inquirer.prompt([
      {
        type: "list",
        name: "workspaceId",
        message: "Select a workspace:",
        choices: workspaceChoices,
      },
    ]);

    // Get available data sources for the selected workspace
    process.stdout.write("⏳ Fetching data sources...");
    const dataSources =
      await databaseDataSourceManager.getActiveDataSources(workspaceId);
    process.stdout.write("\r" + " ".repeat(50) + "\r");
    if (dataSources.length === 0) {
      console.error("❌ No active data sources found for this workspace!");
      console.log("Please create data sources in your application first.");
      process.exit(1);
    }

    // Get available destinations for the selected workspace
    process.stdout.write("⏳ Fetching destinations...");
    const destinations =
      await getDestinationManager().listDestinations(workspaceId);
    process.stdout.write("\r" + " ".repeat(50) + "\r");
    if (destinations.length === 0) {
      console.error("❌ No destination databases found for this workspace!");
      console.log(
        "Please create destination databases in your application first.",
      );
      process.exit(1);
    }

    // Prompt for data source
    const sourceChoices = dataSources.map(s => ({
      name: `${s.name} (${s.type})`,
      value: s.id,
      short: s.name,
    }));

    const { dataSourceId } = await inquirer.prompt([
      {
        type: "list",
        name: "dataSourceId",
        message: "Select a data source:",
        choices: sourceChoices,
      },
    ]);

    // Get selected data source details
    const selectedSource = dataSources.find(s => s.id === dataSourceId);
    if (!selectedSource) {
      throw new Error("Selected data source not found");
    }

    // Prompt for destination
    const destChoices = destinations.map((d: { name: string; id: string }) => ({
      name: d.name,
      value: d.id,
      short: d.name,
    }));

    const { destinationId } = await inquirer.prompt([
      {
        type: "list",
        name: "destinationId",
        message: "Select a destination database:",
        choices: destChoices,
      },
    ]);

    // Get available entities for the selected source
    const connector = await syncConnectorRegistry.getConnector(selectedSource);
    if (!connector) {
      throw new Error(
        `Failed to create connector for type: ${selectedSource.type}`,
      );
    }

    const availableEntities = connector.getAvailableEntities();

    const { destinationDatabaseName } = await inquirer.prompt([
      {
        type: "input",
        name: "destinationDatabaseName",
        message:
          "Destination database name (leave blank to use the connection default):",
        default: "",
      },
    ]);

    // Prompt for entity selection (multi-select with checkbox)
    const { entities } = await inquirer.prompt([
      {
        type: "checkbox",
        name: "entities",
        message: "Select entities to sync (space to select, enter to confirm):",
        choices: [
          { name: "All entities", value: "ALL", checked: false },
          new inquirer.Separator(),
          ...availableEntities.map((e: string) => ({
            name: e,
            value: e,
            checked: false,
          })),
        ],
        validate: answer => {
          if (answer.length === 0) {
            return "You must select at least one entity";
          }
          return true;
        },
      },
    ]);

    // Handle "All entities" selection
    let selectedEntities: string[] | undefined;
    if (entities.includes("ALL")) {
      selectedEntities = undefined; // undefined means all entities
    } else {
      selectedEntities = entities;
    }

    // Prompt for sync mode
    const { syncMode } = await inquirer.prompt([
      {
        type: "list",
        name: "syncMode",
        message: "Select sync mode:",
        choices: [
          {
            name: "Full sync (replace all data)",
            value: "full",
            short: "Full",
          },
          {
            name: "Incremental sync (update changed data only)",
            value: "incremental",
            short: "Incremental",
          },
        ],
      },
    ]);

    // Confirm before proceeding
    console.log("\n📋 Sync Configuration:");
    console.log(
      `   Workspace: ${workspaces.find(w => w.id === workspaceId)?.name}`,
    );
    console.log(`   Source: ${selectedSource.name} (${selectedSource.type})`);
    console.log(
      `   Destination: ${destinations.find((d: { id: string }) => d.id === destinationId)?.name}`,
    );
    if (destinationDatabaseName?.trim()) {
      console.log(`   Destination Database Name: ${destinationDatabaseName.trim()}`);
    }
    console.log(
      `   Entities: ${selectedEntities ? selectedEntities.join(", ") : "All entities"}`,
    );
    console.log(
      `   Mode: ${syncMode === "incremental" ? "Incremental" : "Full"}`,
    );

    // Show equivalent command
    let command = `pnpm run sync -s ${dataSourceId} -d ${destinationId}`;
    if (destinationDatabaseName?.trim()) {
      command += ` --destination-db-name ${destinationDatabaseName.trim()}`;
    }
    if (selectedEntities) {
      selectedEntities.forEach(entity => {
        command += ` -e ${entity}`;
      });
    }
    if (syncMode === "incremental") {
      command += " --incremental";
    }
    console.log(`\nEquivalent command:\n  $ ${command}\n`);

    const { confirm } = await inquirer.prompt([
      {
        type: "confirm",
        name: "confirm",
        message: "Do you want to proceed with this sync?",
        default: true,
      },
    ]);

    if (!confirm) {
      console.log("❌ Sync cancelled by user");
      process.exit(0);
    }

    // Perform the sync
    await runSync(
      dataSourceId,
      destinationId,
      destinationDatabaseName?.trim()
        ? destinationDatabaseName.trim()
        : undefined,
      selectedEntities,
      syncMode === "incremental",
    );
  } catch (error) {
    console.error("❌ Interactive mode error:", error);
    process.exit(1);
  }
}

// Create commander program
const program = new Command();

program
  .name("sync")
  .description("Sync data from various sources to destination databases")
  .version("1.0.0")
  .helpOption("-h, --help", "display help for command")
  .option("-s, --source <sourceId>", "ID of the data source to sync from")
  .option("-d, --destination <destinationId>", "ID of the destination database")
  .option(
    "-e, --entity <entity>",
    "Specific entity to sync (can be used multiple times)",
    (value, previous: string[] = []) => {
      return previous.concat([value]);
    },
  )
  .option(
    "--entities <entities...>",
    "Alternative way to specify multiple entities",
  )
  .option(
    "--incremental",
    "Perform incremental sync (only sync new/updated records)",
  )
  .option(
    "--destination-db-name <name>",
    "Logical database name when the destination connection serves multiple databases",
  )
  .option("-i, --interactive", "Run in interactive mode")
  .action(async options => {
    // If interactive mode or no required options provided
    if (options.interactive || (!options.source && !options.destination)) {
      await interactiveMode();
    } else if (!options.source || !options.destination) {
      console.error(
        "❌ Both source (-s) and destination (-d) IDs are required in non-interactive mode",
      );
      console.log("Use --interactive or -i flag to run in interactive mode.\n");
      program.help();
      process.exit(1);
    } else {
      // Combine entities from both options
      let allEntities: string[] = [];

      // Add entities from -e flag(s)
      if (options.entity && Array.isArray(options.entity)) {
        allEntities = [...allEntities, ...options.entity];
      }

      // Add entities from --entities flag
      if (options.entities && options.entities.length > 0) {
        allEntities = [...allEntities, ...options.entities];
      }

      // Remove duplicates and convert to undefined if empty (meaning sync all)
      const uniqueEntities =
        allEntities.length > 0 ? [...new Set(allEntities)] : undefined;

      console.log("[DEBUG] CLI options:", options);
      console.log(
        `[DEBUG] Selected entities: ${uniqueEntities?.join(", ") || "all"}`,
      );
      console.log(`[DEBUG] Using incremental: ${options.incremental}`);

      await runSync(
        options.source,
        options.destination,
        options.destinationDbName
          ? String(options.destinationDbName).trim()
          : undefined,
        uniqueEntities,
        options.incremental,
      );
    }
  })
  .addHelpText(
    "after",
    `
Examples:
  $ pnpm run sync                                      # Interactive mode
  $ pnpm run sync --interactive                        # Force interactive mode
  $ pnpm run sync -s <source_id> -d <dest_id>         # Sync all entities
  $ pnpm run sync -s <source_id> -d <dest_id> -e customers    # Sync single entity
  $ pnpm run sync -s <source_id> -d <dest_id> -e customers -e orders  # Multiple entities
  $ pnpm run sync -s <source_id> -d <dest_id> --entities customers orders leads
  $ pnpm run sync -s <source_id> -d <dest_id> -e leads --incremental
  
Notes:
  - Use -e multiple times to sync specific entities: -e entity1 -e entity2
  - Or use --entities to list them all at once: --entities entity1 entity2 entity3
  - When run without arguments, the tool will guide you through an interactive
    selection process for all options.
  `,
  );

// Parse command line arguments
try {
  program.parse(process.argv);
} catch (error) {
  // Commander throws on help, which is expected
  if (error && (error as any).code === "commander.help") {
    process.exit(0);
  }
  throw error;
}
