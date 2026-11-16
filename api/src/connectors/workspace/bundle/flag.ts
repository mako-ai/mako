/**
 * The switch for connector bundles (RFC connector-runtime §5, iteration 1).
 *
 * Off by default. Off means exactly the behaviour before bundles existed: a
 * connector folder is copied into the sync box and its TypeScript entry runs
 * as it stands, and a `package.json` in the folder is just another file. On, a
 * folder carrying `package.json` plus `package-lock.json` is built into one
 * `.mjs` per source hash.
 *
 * The `node_modules/` guard is not behind this flag: the push reconciler
 * refuses a folder that commits `node_modules/` either way.
 */
export const CONNECTOR_BUNDLES_FLAG = "CONNECTOR_BUNDLES_ENABLED";

export function connectorBundlesEnabled(): boolean {
  const raw = process.env[CONNECTOR_BUNDLES_FLAG]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}
