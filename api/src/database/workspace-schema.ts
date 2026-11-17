/**
 * Barrel for the workspace-scoped Mongoose models.
 *
 * Each domain lives in its own module under `./models/` (interfaces, schema,
 * indexes, hooks and the `mongoose.model(...)` call together). Hundreds of
 * files import from this path, so it stays the public entry point; import a
 * model from here, not from `./models/*`.
 *
 * The modules never import each other's models at runtime — cross-model
 * links are `ref: "<ModelName>"` strings — so there are no import cycles.
 * Only `./models/shared` (encryption helpers and sub-schemas reused across
 * domains) is imported by other modules.
 *
 * Skills are files in the workspace repo (apps.md §27); they have no model.
 */
export {
  encrypt,
  decrypt,
  type IConnectionWriter,
  type ResourceShareRole,
  type IResourceShareEntry,
  type IPublicShare,
} from "./models/shared";
export * from "./models/workspace";
export * from "./models/members";
export * from "./models/database-connections";
export * from "./models/source-connections";
export * from "./models/consoles";
export * from "./models/query-runs";
export * from "./models/notifications";
export * from "./models/chats";
export * from "./models/flows";
export * from "./models/webhooks";
export * from "./models/flow-parity";
export * from "./models/cdc";
export * from "./models/notebooks";
export * from "./models/realtime-presence";
export * from "./models/dbt";
export * from "./models/mcp";
export * from "./models/apps";
export * from "./models/app-index";
export * from "./models/usage-analytics";
export * from "./models/favourites";
