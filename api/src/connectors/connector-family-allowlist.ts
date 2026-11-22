/**
 * Connector families that code outside their own folder may still import.
 *
 * THIS LIST MUST ONLY SHRINK. Each family's removal PR deletes its line here
 * in the same commit that deletes `api/src/connectors/<family>/`. Never add a
 * family. A new connector is a workspace connector (`connectors/<slug>/` in
 * the repo) and has no folder under api/src/connectors.
 *
 * Enforced by connector-family-boundary.test.ts (run by test:tsx).
 */
export const ALLOWED_FAMILIES_IMPORTED_FROM_OUTSIDE: readonly string[] = [];

/**
 * Shared modules and folders directly under api/src/connectors that are not
 * families. Importing them from anywhere is always allowed.
 *
 *   base/                              the connector contract
 *   workspace/                         the workspace connector adapter and runtime
 *   registry.ts                        built-in connector registry
 *   rate-gate.ts                       shared rate limiting
 *   probe.service.ts                   connection probe
 *   connection-key-request.service.ts  key request flow
 *   source-connection-create.service.ts connection creation
 *
 * Any other top-level .ts file (tests, helpers) is also shared. Any other
 * folder is treated as a family.
 */
export const SHARED_DIRECTORIES: readonly string[] = ["base", "workspace"];
