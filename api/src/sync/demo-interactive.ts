/* eslint-disable no-console */
import inquirer from "inquirer";

async function demoInteractiveSync() {
  console.log("🚀 Interactive Data Sync Tool - DEMO MODE\n");
  console.log(
    "This is a demonstration of the interactive sync functionality.\n",
  );

  // Simulate data sources
  const dataSources = [
    { id: "stripe-prod", name: "Stripe Production", type: "stripe" },
    { id: "close-sales", name: "Close CRM Sales", type: "close" },
    { id: "graphql-api", name: "GraphQL Analytics API", type: "graphql" },
  ];

  // Simulate destinations
  const destinations = [
    { id: "analytics-db", name: "Analytics Database" },
    { id: "reporting-db", name: "Reporting Database" },
    { id: "warehouse", name: "Data Warehouse" },
  ];

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

  const selectedSource = dataSources.find(s => s.id === dataSourceId);
  if (!selectedSource) return;

  // Prompt for destination
  const destChoices = destinations.map(d => ({
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

  // Get entities based on source type
  let availableEntities: string[] = [];
  switch (selectedSource.type) {
    case "stripe":
      availableEntities = [
        "customers",
        "subscriptions",
        "charges",
        "invoices",
        "products",
        "plans",
      ];
      break;
    case "close":
      availableEntities = [
        "leads",
        "opportunities",
        "activities",
        "contacts",
        "users",
        "custom_fields",
      ];
      break;
    case "graphql":
      availableEntities = ["custom_query_1", "custom_query_2"];
      break;
  }

  // Prompt for entity selection
  const entityChoices = [
    { name: "All entities", value: null },
    ...availableEntities.map(e => ({ name: e, value: e })),
  ];

  const { entity } = await inquirer.prompt([
    {
      type: "list",
      name: "entity",
      message: "Select entity to sync:",
      choices: entityChoices,
    },
  ]);

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
  const selectedDest = destinations.find(d => d.id === destinationId);
  console.log("\n📋 Sync Configuration:");
  console.log(`   Source: ${selectedSource.name} (${selectedSource.type})`);
  console.log(`   Destination: ${selectedDest?.name}`);
  console.log(`   Entity: ${entity || "All entities"}`);
  console.log(
    `   Mode: ${syncMode === "incremental" ? "Incremental" : "Full"}`,
  );

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
    return;
  }

  // Simulate sync process
  console.log("\n🔄 Starting sync... (DEMO MODE - no actual sync performed)");
  console.log("In production, this would:");
  console.log("  1. Connect to the source system");
  console.log("  2. Fetch data based on your selections");
  console.log("  3. Transform and load data into the destination");
  console.log("  4. Show progress with a real-time progress bar");
  console.log("\n✅ Demo completed!");
}

// Run the demo
demoInteractiveSync().catch(console.error);
