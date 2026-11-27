/**
 * What the UI needs to know about a workspace's connectors.
 *
 * Kept apart from the resolver because these answers are for humans picking a
 * connector, not for the engine running one: they must be cheap, they must
 * never boot a sandbox, and they must be honest about a connector that is not
 * usable yet rather than hiding it.
 */
import {
  listConnectorDefinitions,
  loadConnectorDefinition,
  retryingMessage,
} from "./resolver";
import { specToForm, type FormSchema } from "./spec-translation";
import { connectionsRepo } from "../../repositories/connections";
import {
  WORKSPACE_TYPE_PREFIX,
  slugFromType,
  isWorkspaceConnectorType,
} from "./SandboxedConnector";

export interface WorkspaceConnectorSummary {
  type: string;
  name: string;
  version: string;
  description: string;
  supportedEntities: string[];
  /** False while the connector is blocked, so the picker can grey it out. */
  usable: boolean;
  status: "indexed" | "verified" | "blocked" | "retrying";
  blockedReason?: string;
  /** While `retrying`: when indexing runs spec again. */
  nextRetryAt?: string;
  /** While `retrying`: platform failures in a row for this source. */
  retryAttempts?: number;
  /** Why the last connection test failed. A bad key, not a broken connector. */
  lastCheckError?: string;
  /**
   * The last bundle build, next to `status`, for a folder with dependencies
   * (CONNECTOR_BUNDLES_ENABLED). A failed build at push also blocks the
   * connector; a failed build at run time is reported here and retried.
   */
  build?: {
    status: "built" | "failed";
    hash: string;
    error?: string;
    bytes?: number;
    builtAt?: string;
  };
  /**
   * For a folder installed by reference (`source:` in connector.yaml,
   * CONNECTOR_REGISTRY_ENABLED): the reference, the version it resolved to,
   * the newest published one, and a newer major outside the range.
   */
  registry?: {
    ref: string;
    version: string;
    latest: string;
    upgradeAvailable?: string;
  };
  hasIcon: boolean;
  source: "workspace";
  /**
   * The incremental mode every query entity shares, from the indexed spec
   * (`mako.queryEntities.incremental`). It holds before any query exists,
   * which is when the flow form asks (GraphQL's queries live on the flow).
   */
  queryEntitiesIncremental?: "native" | "client-filter" | "created-anchor";
}

const INCREMENTAL_MODES = new Set([
  "native",
  "client-filter",
  "created-anchor",
]);

/** Every connector this workspace ships, for the catalog the picker renders. */
export async function listWorkspaceConnectors(
  workspaceId: string,
): Promise<WorkspaceConnectorSummary[]> {
  const rows = await connectionsRepo.listConnectorDefinitions(workspaceId);
  return rows.map(row => {
    const mako = (row.spec as any)?.mako ?? {};
    return {
      type: `${WORKSPACE_TYPE_PREFIX}${row.slug}`,
      name: mako.name ?? row.slug,
      version: mako.version ?? "0.0.0",
      description:
        row.status === "blocked"
          ? `Blocked: ${row.blockedReason ?? "this connector failed its last check"}`
          : row.status === "retrying"
            ? retryingMessage(row.slug, row)
            : row.registry
              ? `${row.slug} — ${row.registry.ref}, version ${row.registry.version}`
              : `${row.slug} — from this workspace's repository`,
      supportedEntities: row.entities ?? [],
      usable: row.status !== "blocked" && row.status !== "retrying",
      status: row.status,
      blockedReason: row.blockedReason,
      ...(row.status === "retrying" && row.nextIndexRetryAt
        ? {
            nextRetryAt: new Date(row.nextIndexRetryAt).toISOString(),
            retryAttempts: row.indexRetryAttempts ?? 1,
          }
        : {}),
      lastCheckError: row.lastCheckError,
      ...(row.build
        ? {
            build: {
              status: row.build.status,
              hash: row.build.hash,
              ...(row.build.error ? { error: row.build.error } : {}),
              ...(row.build.bytes !== undefined
                ? { bytes: row.build.bytes }
                : {}),
              ...(row.build.builtAt
                ? { builtAt: new Date(row.build.builtAt).toISOString() }
                : {}),
            },
          }
        : {}),
      ...(row.registry
        ? {
            registry: {
              ref: row.registry.ref,
              version: row.registry.version,
              latest: row.registry.latest,
              ...(row.registry.upgradeAvailable
                ? { upgradeAvailable: row.registry.upgradeAvailable }
                : {}),
            },
          }
        : {}),
      hasIcon: row.hasIcon === true,
      source: "workspace" as const,
      ...(INCREMENTAL_MODES.has(mako.queryEntities?.incremental)
        ? { queryEntitiesIncremental: mako.queryEntities.incremental }
        : {}),
    };
  });
}

/**
 * The credential form for one workspace connector.
 *
 * Derived from the spec captured at push time, so rendering a form is a Mongo
 * read: no sandbox, no git, nothing that could make opening a form slow or
 * make it fail when a box is cold.
 */
export async function workspaceConnectorForm(
  workspaceId: string,
  type: string,
): Promise<FormSchema> {
  const definition = await loadConnectorDefinition(
    workspaceId,
    slugFromType(type),
  );
  return specToForm(definition.spec as any);
}

/**
 * May a data source be created with this type?
 *
 * The global registry deliberately cannot answer for `ws:` types, because the
 * answer depends on the workspace. A blocked connector is refused here rather
 * than at first sync: creating a data source against a connector that cannot
 * run produces a broken flow and a confusing failure much later.
 */
export async function connectorTypeExists(
  type: string,
  workspaceId: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!isWorkspaceConnectorType(type)) return { ok: true };
  const slug = slugFromType(type);
  const row = await connectionsRepo.findConnectorDefinition(workspaceId, slug);
  if (!row) {
    return {
      ok: false,
      reason: `This workspace has no connector "${slug}". Push a folder at connectors/${slug}/ to main.`,
    };
  }
  if (row.status === "blocked") {
    return {
      ok: false,
      reason: `The connector "${slug}" is blocked: ${row.blockedReason ?? "it failed its last check"}`,
    };
  }
  if (row.status === "retrying") {
    return { ok: false, reason: retryingMessage(slug, row) };
  }
  return { ok: true };
}

export { listConnectorDefinitions };
