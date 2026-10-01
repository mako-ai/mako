/**
 * What the UI needs to know about a workspace's connectors.
 *
 * Kept apart from the resolver because these answers are for humans picking a
 * connector, not for the engine running one: they must be cheap, they must
 * never boot a sandbox, and they must be honest about a connector that is not
 * usable yet rather than hiding it.
 */
import { listConnectorDefinitions, loadConnectorDefinition } from "./resolver";
import {
  connectionSpecificationToForm,
  type FormSchema,
} from "./spec-translation";
import { ConnectorDefinition } from "../../database/workspace-schema";
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
  status: "indexed" | "verified" | "blocked";
  blockedReason?: string;
  /** Why the last connection test failed. A bad key, not a broken connector. */
  lastCheckError?: string;
  hasIcon: boolean;
  source: "workspace";
}

/** Every connector this workspace ships, for the catalog the picker renders. */
export async function listWorkspaceConnectors(
  workspaceId: string,
): Promise<WorkspaceConnectorSummary[]> {
  const rows = await ConnectorDefinition.find({ workspaceId })
    .sort({ slug: 1 })
    .lean();
  return rows.map(row => {
    const mako = (row.spec as any)?.mako ?? {};
    return {
      type: `${WORKSPACE_TYPE_PREFIX}${row.slug}`,
      name: mako.name ?? row.slug,
      version: mako.version ?? "0.0.0",
      description:
        row.status === "blocked"
          ? `Blocked: ${row.blockedReason ?? "this connector failed its last check"}`
          : `${row.slug} — from this workspace's repository`,
      supportedEntities: row.entities ?? [],
      usable: row.status !== "blocked",
      status: row.status,
      blockedReason: row.blockedReason,
      lastCheckError: row.lastCheckError,
      hasIcon: row.hasIcon === true,
      source: "workspace" as const,
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
  return connectionSpecificationToForm(
    (definition.spec as any)?.connectionSpecification,
  );
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
  const row = await ConnectorDefinition.findOne({ workspaceId, slug }).lean();
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
  return { ok: true };
}

export { listConnectorDefinitions };
