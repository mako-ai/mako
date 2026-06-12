/**
 * Starter scaffold seeded into dbt_files when a project is created.
 * The dbt_project.yml lives in dbt_files like any other file so the agent
 * and the IDE edit it through the same path.
 */

export const DBT_PROJECT_FILE = "dbt_project.yml";

export function buildStarterScaffold(
  projectName: string,
): Array<{ path: string; content: string }> {
  const safeName = projectName
    .toLowerCase()
    .replace(/[^a-z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/^(\d)/, "p$1");
  const dbtName = safeName || "mako_project";

  return [
    {
      path: DBT_PROJECT_FILE,
      content: `name: "${dbtName}"
version: "1.0.0"
profile: "mako"

model-paths: ["models"]
seed-paths: ["seeds"]
test-paths: ["tests"]
macro-paths: ["macros"]
snapshot-paths: ["snapshots"]

target-path: "target"
clean-targets:
  - "target"
  - "dbt_packages"

models:
  ${dbtName}:
    staging:
      +materialized: view
    marts:
      +materialized: table
`,
    },
    {
      path: "models/staging/.gitkeep",
      content: "",
    },
    {
      path: "models/marts/.gitkeep",
      content: "",
    },
    {
      path: "models/staging/schema.yml",
      content: `version: 2

# Declare sources here, then reference them in staging models with
# {{ source('source_name', 'table_name') }}.
#
# sources:
#   - name: raw
#     schema: public
#     tables:
#       - name: orders
#
# models:
#   - name: stg_orders
#     columns:
#       - name: order_id
#         data_tests:
#           - unique
#           - not_null
`,
    },
    {
      path: "README.md",
      content: `# ${projectName}

A dbt project managed in Mako.

- \`models/staging/\` — 1:1 source cleanup models (views)
- \`models/marts/\` — business-facing models (tables)

Use the dbt agent in chat to scaffold models, or edit files directly and
use Compile / Run model from the editor.
`,
    },
  ];
}
